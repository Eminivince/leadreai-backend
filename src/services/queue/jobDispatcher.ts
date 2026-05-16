import { Job } from 'bullmq';
import { getProspectingQueue } from './queues.js';

export async function dispatchProspectingJob(
  jobId: string,
  workspaceId: string,
): Promise<Job> {
  const queue = getProspectingQueue();
  return queue.add(
    'prospect',
    { jobId, workspaceId },
    { jobId },
  );
}
