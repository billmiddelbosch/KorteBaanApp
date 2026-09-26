import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigateway from 'aws-cdk-lib/aws-apigateway'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'
import * as path from 'path'
import { ALLOWED_ORIGINS, PROJECT } from './config'

export class ApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props)

    // All handlers are bundled by esbuild into lambda/dist (run `npm run build` in lambda/ first;
    // `npm run deploy` does this via predeploy).
    const lambdaCode = lambda.Code.fromAsset(path.resolve(__dirname, '../../lambda/dist'))

    const makeFn = (id: string, name: string, handler: string, description: string) =>
      new lambda.Function(this, id, {
        functionName: `${PROJECT}-${name}`,
        handler,
        description,
        runtime: lambda.Runtime.NODEJS_22_X,
        code: lambdaCode,
        timeout: cdk.Duration.seconds(10),
      })

    const functions = [makeFn('HealthFunction', 'health', 'health.handler', 'Deploy smoke-test endpoint')]
    const healthFn = functions[0]

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

    api.root.addResource('health').addMethod('GET', aliasIntegration(healthFn))

    // Grant API Gateway permission to invoke each alias
    const apiExecuteArn = api.arnForExecuteApi('*', '/*', '*')
    const apigwPrincipal = new iam.ServicePrincipal('apigateway.amazonaws.com')
    for (const { alias } of aliases) {
      alias.addPermission(`Invoke${alias.node.id}`, { principal: apigwPrincipal, sourceArn: apiExecuteArn })
    }

    // ── Deployment + stages ──────────────────────────────────────────────────
    const deployment = new apigateway.Deployment(this, 'Deployment', { api })

    const devStage = new apigateway.Stage(this, 'DevStage', {
      deployment,
      stageName: 'dev',
      variables: { alias: 'dev' },
      description: 'Dev stage — used by test.kortebaan.nl (staging branch) and localhost',
    })

    const prodStage = new apigateway.Stage(this, 'ProdStage', {
      deployment,
      stageName: 'prod',
      variables: { alias: 'prod' },
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
