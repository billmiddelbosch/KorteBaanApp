import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import * as dsql from 'aws-cdk-lib/aws-dsql'
import * as events from 'aws-cdk-lib/aws-events'
import * as targets from 'aws-cdk-lib/aws-events-targets'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'
import * as path from 'path'
import { ALLOWED_ORIGINS, PROJECT } from './config'

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // All handlers are bundled by esbuild into lambda/dist (run `npm run build` in lambda/ first;
    // `npm run deploy` does this via predeploy).
    const lambdaCode = lambda.Code.fromAsset(path.resolve(__dirname, '../../lambda/dist'))

    const makeFn = (
      id: string,
      name: string,
      handler: string,
      description: string,
      extra: Partial<lambda.FunctionProps> = {},
    ) =>
      new lambda.Function(this, id, {
        functionName: `${PROJECT}-${name}`,
        handler,
        description,
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambdaCode,
        timeout: cdk.Duration.seconds(10),
        ...extra,
      })

    // ── Data + secrets (separate per environment) ────────────────────────────
    const envs = ['dev', 'prod'] as const

    const tables = Object.fromEntries(
      envs.map((env) => [
        env,
        new dynamodb.Table(this, `Table-${env}`, {
          tableName: `${PROJECT}-${env}`,
          partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
          sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
          billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
          timeToLiveAttribute: 'expiresAt', // cleans up old links, usage counters and finished chats
          pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: env === 'prod' },
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }),
      ]),
    ) as Record<(typeof envs)[number], dynamodb.Table>

    // Signs session tokens; rotating it logs everyone out
    const jwtSecrets = Object.fromEntries(
      envs.map((env) => [
        env,
        new secretsmanager.Secret(this, `JwtSecret-${env}`, {
          secretName: `${PROJECT}/${env}/jwt`,
          description: `Session token signing key (${env})`,
          generateSecretString: { passwordLength: 64, excludePunctuation: true },
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }),
      ]),
    ) as Record<(typeof envs)[number], secretsmanager.Secret>

    // The owner's Claude setup-token, written from the app (AI-koppeling). Starts empty.
    const claudeSecrets = Object.fromEntries(
      envs.map((env) => [
        env,
        new secretsmanager.Secret(this, `ClaudeSecret-${env}`, {
          secretName: `${PROJECT}/${env}/claude`,
          description: `Claude setup-token (${env}) — managed from the app`,
          secretStringValue: cdk.SecretValue.unsafePlainText(JSON.stringify({ token: null })),
          removalPolicy: cdk.RemovalPolicy.RETAIN,
        }),
      ]),
    ) as Record<(typeof envs)[number], secretsmanager.Secret>

    // Koersdag photos: only kept until the worker has checked them; the lifecycle rule is a backstop
    const photoBuckets = Object.fromEntries(
      envs.map((env) => [
        env,
        new s3.Bucket(this, `PhotoBucket-${env}`, {
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
          lifecycleRules: [{ expiration: cdk.Duration.days(1) }],
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
        }),
      ]),
    ) as Record<(typeof envs)[number], s3.Bucket>
    const photoEnv = {
      PHOTO_BUCKET_DEV: photoBuckets.dev.bucketName,
      PHOTO_BUCKET_PROD: photoBuckets.prod.bucketName,
    }

    const accountEnv = {
      TABLE_DEV: tables.dev.tableName,
      TABLE_PROD: tables.prod.tableName,
      JWT_SECRET_ARN_DEV: jwtSecrets.dev.secretArn,
      JWT_SECRET_ARN_PROD: jwtSecrets.prod.secretArn,
    }
    // scrypt password hashing is CPU-bound; more memory = more CPU = faster logins
    const accountFn = (
      id: string,
      name: string,
      description: string,
      environment: Record<string, string> = accountEnv,
    ) =>
      makeFn(id, name, `${name}.handler`, description, { memorySize: 512, environment })

    const healthFn = makeFn('HealthFunction', 'health', 'health.handler', 'Deploy smoke-test endpoint')
    const authFn = accountFn('AuthFunction', 'auth', 'Login and invite/reset links')
    const meFn = accountFn('MeFunction', 'me', 'Own profile, password and speelsessies')
    const friendsFn = accountFn('FriendsFunction', 'friends', 'Owner: manage friends')
    const aiConnectionFn = accountFn('AiConnectionFunction', 'aiConnection', 'Owner: Claude setup-token', {
      ...accountEnv,
      CLAUDE_SECRET_ARN_DEV: claudeSecrets.dev.secretArn,
      CLAUDE_SECRET_ARN_PROD: claudeSecrets.prod.secretArn,
    })

    // Analyse: the API function stores the chat and hands each AI turn to the worker, which may
    // search and think for minutes (longer than API Gateway's 29 s); the app polls for the reply.
    const analysisWorkerFn = makeFn(
      'AnalysisWorkerFunction',
      'analysisWorker',
      'analysisWorker.handler',
      'Analyse: one AI turn (Claude + web search)',
      {
        memorySize: 512,
        timeout: cdk.Duration.minutes(5),
        environment: {
          TABLE_DEV: tables.dev.tableName,
          TABLE_PROD: tables.prod.tableName,
          CLAUDE_SECRET_ARN_DEV: claudeSecrets.dev.secretArn,
          CLAUDE_SECRET_ARN_PROD: claudeSecrets.prod.secretArn,
        },
      },
    )
    const analysisFn = accountFn('AnalysisFunction', 'analysis', 'Analyse chats and locked advice', {
      ...accountEnv,
      ANALYSIS_WORKER_NAME: analysisWorkerFn.functionName,
    })
    const aiInstructionFn = accountFn('AiInstructionFunction', 'aiInstruction', 'Owner: AI-instructie')

    // Koersdag: same pattern as Analyse; one worker run per omloop update (online check or photo)
    const koersdagWorkerFn = makeFn(
      'KoersdagWorkerFunction',
      'koersdagWorker',
      'koersdagWorker.handler',
      'Koersdag: one update per omloop (Claude + web search / photo)',
      {
        memorySize: 512,
        timeout: cdk.Duration.minutes(5),
        environment: {
          TABLE_DEV: tables.dev.tableName,
          TABLE_PROD: tables.prod.tableName,
          CLAUDE_SECRET_ARN_DEV: claudeSecrets.dev.secretArn,
          CLAUDE_SECRET_ARN_PROD: claudeSecrets.prod.secretArn,
          ...photoEnv,
        },
      },
    )
    const koersdagFn = accountFn('KoersdagFunction', 'koersdag', 'Koersdag: updates per omloop, inzetten', {
      ...accountEnv,
      ...photoEnv,
      KOERSDAG_WORKER_NAME: koersdagWorkerFn.functionName,
    })

    // Terugblik: uitslagen ophalen, foto lezen and evalueren; same worker pattern as Koersdag
    const terugblikWorkerFn = makeFn(
      'TerugblikWorkerFunction',
      'terugblikWorker',
      'terugblikWorker.handler',
      'Terugblik: uitslagen (web search / photo) and evaluation',
      {
        memorySize: 512,
        timeout: cdk.Duration.minutes(5),
        environment: {
          TABLE_DEV: tables.dev.tableName,
          TABLE_PROD: tables.prod.tableName,
          CLAUDE_SECRET_ARN_DEV: claudeSecrets.dev.secretArn,
          CLAUDE_SECRET_ARN_PROD: claudeSecrets.prod.secretArn,
          ...photoEnv,
        },
      },
    )
    const terugblikFn = accountFn('TerugblikFunction', 'terugblik', 'Terugblik: uitslagen, evaluatie, overzicht, lessen', {
      ...accountEnv,
      ...photoEnv,
      TERUGBLIK_WORKER_NAME: terugblikWorkerFn.functionName,
    })

    const accountFunctions = [
      authFn,
      meFn,
      friendsFn,
      aiConnectionFn,
      analysisFn,
      aiInstructionFn,
      koersdagFn,
      terugblikFn,
    ]
    for (const fn of accountFunctions) {
      for (const env of envs) {
        tables[env].grantReadWriteData(fn)
        jwtSecrets[env].grantRead(fn)
      }
    }
    // Only the AI-koppeling function may touch the Claude token
    for (const env of envs) {
      claudeSecrets[env].grantRead(aiConnectionFn)
      claudeSecrets[env].grantWrite(aiConnectionFn)
    }

    // The worker isn't behind API Gateway; it gets its own aliases, invoked by the analysis function.
    // No retries: a retried turn would answer twice, and the worker records its own failures.
    for (const env of envs) {
      tables[env].grantReadWriteData(analysisWorkerFn)
      claudeSecrets[env].grantRead(analysisWorkerFn)
      analysisWorkerFn.addAlias(env, { retryAttempts: 0 }).grantInvoke(analysisFn)
    }

    for (const env of envs) {
      tables[env].grantReadWriteData(koersdagWorkerFn)
      claudeSecrets[env].grantRead(koersdagWorkerFn)
      photoBuckets[env].grantPut(koersdagFn)
      photoBuckets[env].grantDelete(koersdagFn)
      photoBuckets[env].grantRead(koersdagWorkerFn)
      photoBuckets[env].grantDelete(koersdagWorkerFn)
      koersdagWorkerFn.addAlias(env, { retryAttempts: 0 }).grantInvoke(koersdagFn)
    }

    for (const env of envs) {
      tables[env].grantReadWriteData(terugblikWorkerFn)
      claudeSecrets[env].grantRead(terugblikWorkerFn)
      photoBuckets[env].grantPut(terugblikFn)
      photoBuckets[env].grantDelete(terugblikFn)
      photoBuckets[env].grantRead(terugblikWorkerFn)
      photoBuckets[env].grantDelete(terugblikWorkerFn)
      terugblikWorkerFn.addAlias(env, { retryAttempts: 0 }).grantInvoke(terugblikFn)
    }

    // Kortebaankalender: copies the Kortebaanbond calendar into the draverijen list, daily per environment
    const kalenderSyncFn = makeFn(
      'KalenderSyncFunction',
      'kalenderSync',
      'kalenderSync.handler',
      'Kortebaankalender (kortebaanbond.nl) into the draverijen list',
      {
        timeout: cdk.Duration.minutes(1),
        environment: { TABLE_DEV: tables.dev.tableName, TABLE_PROD: tables.prod.tableName },
      },
    )
    for (const env of envs) {
      tables[env].grantReadWriteData(kalenderSyncFn)
      new events.Rule(this, `KalenderSync-${env}`, {
        description: `Daily kortebaankalender sync (${env})`,
        schedule: events.Schedule.cron({ minute: '0', hour: '4' }),
        targets: [new targets.LambdaFunction(kalenderSyncFn.addAlias(env, { retryAttempts: 1 }))],
      })
    }

    // ── Kennisbank (one Aurora DSQL cluster shared by dev and prod) ──────────
    // Schema, roles and the IAM mapping of kbIngest are applied with `cd lambda && npm run kb-migrate`.
    const kbCluster = new dsql.CfnCluster(this, 'KennisbankCluster', {
      deletionProtectionEnabled: true,
      tags: [{ key: 'Name', value: `${PROJECT}-kennisbank` }],
    })
    kbCluster.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN)
    const kbHost = `${kbCluster.attrIdentifier}.dsql.${this.region}.on.aws`

    // Adds the results of recent draverijen (kortebaanbond.nl pdf's + weather) to the kennisbank.
    // Runs once for both environments, so the rule targets the function itself, not an alias.
    const kbIngestFn = makeFn(
      'KbIngestFunction',
      'kbIngest',
      'kbIngest.handler',
      'Kennisbank: results of recent draverijen from kortebaanbond.nl',
      { memorySize: 1024, timeout: cdk.Duration.minutes(5) },
    )
    new events.Rule(this, 'KbIngest', {
      description: 'Daily kennisbank ingest of recent draverijen',
      schedule: events.Schedule.cron({ minute: '0', hour: '5' }),
      targets: [new targets.LambdaFunction(kbIngestFn, { retryAttempts: 1 })],
    })

    // Besides the ingest, the AI workers read the kennisbank and write claims, win chances and
    // lessons, and the Terugblik API lists and removes lessons; all as kb_writer
    const kbWriters = [kbIngestFn, analysisWorkerFn, koersdagWorkerFn, terugblikWorkerFn, terugblikFn]
    for (const fn of kbWriters) {
      fn.addEnvironment('KB_HOST', kbHost)
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['dsql:DbConnect'], resources: [kbCluster.attrResourceArn] }))
    }

    const functions = [healthFn, ...accountFunctions]

    // ── Lambda aliases ───────────────────────────────────────────────────────
    // Every function gets a `dev` and `prod` alias; the handler reads its alias from
    // context.invokedFunctionArn to pick per-environment resources and CORS origins.
    const aliases = functions.flatMap((fn) => [
      { fn, alias: fn.addAlias('dev') },
      { fn, alias: fn.addAlias('prod') },
    ])

    // ── API Gateway ──────────────────────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'Api', {
      restApiName: `${PROJECT}-api`,
      description: 'KorteBaan API — one REST API, dev and prod stages',
      deploy: false, // manual deployment so we can attach two stages
      defaultCorsPreflightOptions: {
        allowOrigins: ALLOWED_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    })

    // Integration using ${stageVariables.alias} so each stage invokes the matching alias
    const aliasIntegration = (fn: lambda.Function) =>
      new apigateway.Integration({
        type: apigateway.IntegrationType.AWS_PROXY,
        integrationHttpMethod: 'POST',
        uri: `arn:aws:apigateway:${this.region}:lambda:path/2015-03-31/functions/${fn.functionArn}:\${stageVariables.alias}/invocations`,
      })

    // Every route, as `METHOD /path` → function. Also feeds the deployment's logical ID so a
    // route change creates a new deployment (with deploy: false CDK doesn't do that for us).
    const routes: [string, string, lambda.Function][] = [
      ['GET', '/health', healthFn],
      ['POST', '/auth/login', authFn],
      ['GET', '/auth/links/{token}', authFn],
      ['POST', '/auth/links/{token}/accept', authFn],
      ['GET', '/me', meFn],
      ['PATCH', '/me', meFn],
      ['PUT', '/me/password', meFn],
      ['GET', '/me/sessions', meFn],
      ['GET', '/friends', friendsFn],
      ['POST', '/friends', friendsFn],
      ['PATCH', '/friends/{id}', friendsFn],
      ['DELETE', '/friends/{id}', friendsFn],
      ['POST', '/friends/{id}/link', friendsFn],
      ['GET', '/ai-connection', aiConnectionFn],
      ['PUT', '/ai-connection', aiConnectionFn],
      ['DELETE', '/ai-connection', aiConnectionFn],
      ['POST', '/ai-connection/test', aiConnectionFn],
      ['GET', '/ai-instruction', aiInstructionFn],
      ['PUT', '/ai-instruction', aiInstructionFn],
      ['POST', '/ai-instruction/revert', aiInstructionFn],
      ['GET', '/draverijen', analysisFn],
      ['GET', '/analyses', analysisFn],
      ['POST', '/analyses', analysisFn],
      ['GET', '/analyses/{id}', analysisFn],
      ['POST', '/analyses/{id}/messages', analysisFn],
      ['POST', '/analyses/{id}/retry', analysisFn],
      ['POST', '/analyses/{id}/restart', analysisFn],
      ['POST', '/analyses/{id}/advice', analysisFn],
      ['GET', '/koersdagen/today', koersdagFn],
      ['POST', '/koersdagen', koersdagFn],
      ['GET', '/koersdagen/{id}', koersdagFn],
      ['POST', '/koersdagen/{id}/refresh', koersdagFn],
      ['POST', '/koersdagen/{id}/photo', koersdagFn],
      ['POST', '/koersdagen/{id}/next', koersdagFn],
      ['POST', '/koersdagen/{id}/finish', koersdagFn],
      ['POST', '/koersdagen/{id}/bets', koersdagFn],
      ['PATCH', '/koersdagen/{id}/bets/{betId}', koersdagFn],
      ['DELETE', '/koersdagen/{id}/bets/{betId}', koersdagFn],
      ['GET', '/terugblik', terugblikFn],
      ['GET', '/terugblik/overview', terugblikFn],
      ['GET', '/terugblik/{id}', terugblikFn],
      ['POST', '/terugblik/{id}/results/fetch', terugblikFn],
      ['POST', '/terugblik/{id}/results/photo', terugblikFn],
      ['PUT', '/terugblik/{id}/results', terugblikFn],
      ['POST', '/terugblik/{id}/evaluate', terugblikFn],
      ['PATCH', '/terugblik/{id}/bets/{betId}', terugblikFn],
      ['GET', '/lessons', terugblikFn],
      ['DELETE', '/lessons/{id}', terugblikFn],
    ]
    const methods = routes.map(([method, route, fn]) =>
      api.root.resourceForPath(route).addMethod(method, aliasIntegration(fn)),
    )

    // Grant API Gateway permission to invoke each alias
    const apiExecuteArn = api.arnForExecuteApi('*', '/*', '*')
    const apigwPrincipal = new iam.ServicePrincipal('apigateway.amazonaws.com')
    for (const { alias } of aliases) {
      alias.addPermission(`Invoke${alias.node.id}`, { principal: apigwPrincipal, sourceArn: apiExecuteArn })
    }

    // ── Deployment + stages ──────────────────────────────────────────────────
    const deployment = new apigateway.Deployment(this, 'Deployment', { api })
    deployment.addToLogicalId(routes.map(([method, route, fn]) => `${method} ${route} ${fn.node.id}`))
    deployment.node.addDependency(...methods)

    // Small friend group: generous for real use, tight enough to blunt scripted abuse
    const throttling = { throttlingRateLimit: 20, throttlingBurstLimit: 40 }

    const devStage = new apigateway.Stage(this, 'DevStage', {
      deployment,
      stageName: 'dev',
      variables: { alias: 'dev' },
      ...throttling,
      description: 'Dev stage — used by test.kortebaan.nl (staging branch) and localhost',
    })

    const prodStage = new apigateway.Stage(this, 'ProdStage', {
      deployment,
      stageName: 'prod',
      variables: { alias: 'prod' },
      ...throttling,
      description: 'Prod stage — used by kortebaan.nl (production branch)',
    })

    // ── Outputs ──────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiUrlDev', {
      value: devStage.urlForPath('/'),
      description: 'VITE_API_BASE_URL for the Amplify staging branch',
    })
    new cdk.CfnOutput(this, 'ApiUrlProd', {
      value: prodStage.urlForPath('/'),
      description: 'VITE_API_BASE_URL for the Amplify production branch',
    })
    new cdk.CfnOutput(this, 'KbEndpoint', { value: kbHost, description: 'Kennisbank DSQL endpoint (--host for kb-migrate/kb-backfill)' })
    new cdk.CfnOutput(this, 'KbWriterRoleArns', {
      value: cdk.Fn.join(',', kbWriters.map((fn) => fn.role!.roleArn)),
      description: '--writer-arn for kb-migrate (all functions that use the kennisbank)',
    })
  }
}
