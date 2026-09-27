import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
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
          timeToLiveAttribute: 'expiresAt', // cleans up old invite/reset links
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

    const accountFunctions = [authFn, meFn, friendsFn, aiConnectionFn]
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
  }
}
