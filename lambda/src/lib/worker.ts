import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda'
import type { Alias } from './http'

const client = new LambdaClient({})

export interface WorkerJob {
  userId: string
  draverijId: string
  thinkingSince: string
}

// Fire-and-forget: the worker may run for minutes, longer than API Gateway waits
export async function startWorker(alias: Alias, job: WorkerJob): Promise<void> {
  const FunctionName = process.env.ANALYSIS_WORKER_NAME
  if (!FunctionName) throw new Error('ANALYSIS_WORKER_NAME is not set')
  await client.send(
    new InvokeCommand({
      FunctionName,
      Qualifier: alias,
      InvocationType: 'Event',
      Payload: new TextEncoder().encode(JSON.stringify(job)),
    }),
  )
}
