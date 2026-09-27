import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import type { Alias } from './http'

const client = new LambdaClient({})

export interface WorkerJob {
  userId: string
  draverijId: string
  thinkingSince: string
}

// Fire-and-forget: the worker may run for minutes, longer than API Gateway waits.
// `envName` holds the worker's function name (Analyse and Koersdag each have their own worker).
export async function startWorker(
  alias: Alias,
  job: WorkerJob,
  envName = 'ANALYSIS_WORKER_NAME',
): Promise<void> {
  const FunctionName = process.env[envName]
  if (!FunctionName) throw new Error(`${envName} is not set`)
  await client.send(
    new InvokeCommand({
      FunctionName,
      Qualifier: alias,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(job)),
    }),
  )
}
