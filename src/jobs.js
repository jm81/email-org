import { randomUUID } from 'node:crypto';

const jobs = new Map();

export function createJob(description, total = 0) {
  const job = { id: randomUUID(), description, status: 'running', done: 0, total, errors: [], startedAt: Date.now() };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id) {
  return jobs.get(id) ?? null;
}

// Runs fn(job) async; the route returns the job id immediately and the client polls.
export function startJob(description, total, fn) {
  const job = createJob(description, total);
  Promise.resolve()
    .then(() => fn(job))
    .then(() => { if (job.status === 'running') job.status = 'done'; })
    .catch((err) => {
      job.status = 'error';
      job.errors.push(err.responseText || err.message);
    });
  // Drop finished jobs after 10 minutes so the map doesn't grow forever.
  setTimeout(() => jobs.delete(job.id), 10 * 60 * 1000).unref();
  return job;
}
