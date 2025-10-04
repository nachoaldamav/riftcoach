import type { Queue } from 'bullmq';
import { redis } from '../clients/redis.js';

export async function getQueuePosition(queue: Queue, jobId: string) {
  const job = await queue.getJob(jobId);
  if (!job) return null;
  const state = await job.getState();
  if (state === 'active' || state === 'completed' || state === 'failed')
    return 0;

  const prefix = queue.opts.prefix ?? 'bull';
  const base = `${prefix}:${queue.name}`;
  const waitKey = `${base}:wait`;
  const prioKey = `${base}:prioritized`;
  const delayedKey = `${base}:delayed`;

  if (job.opts?.priority && job.opts.priority > 0) {
    const rank = await redis.zrank(prioKey, jobId);
    if (rank !== null) return rank + 1;
  }
  if (state === 'waiting') {
    const idx = await redis.lpos(waitKey, jobId);
    if (idx !== null) return (idx as number) + 1;
  }
  if (state === 'delayed') {
    const rank = await redis.zrank(delayedKey, jobId);
    if (rank !== null) return rank + 1;
  }
  return 0;
}
