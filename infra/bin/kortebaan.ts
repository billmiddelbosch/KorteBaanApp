#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib'
import { ApiStack } from '../lib/api-stack'
import { REGION } from '../lib/config'

const app = new cdk.App()

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: REGION,
}

new ApiStack(app, 'KorteBaanApiStack', {
  env,
  description: 'KorteBaan API — API Gateway (dev/prod stages) → Lambda (dev/prod aliases)',
})
