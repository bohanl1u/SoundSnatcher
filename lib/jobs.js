// In-memory job registry. Each snatch gets a working directory under
// work/<id> holding the downloaded source plus any formats encoded from it.

import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const jobs = new Map();

/** Jobs are swept this long after their last use. */
const TTL_MS = 2 * 60 * 60 * 1000;

export function workRoot(baseDir) {
  return path.join(baseDir, 'work');
}

export async function createJob(baseDir, url) {
  const id = randomUUID();
  const dir = path.join(workRoot(baseDir), id);
  await mkdir(dir, { recursive: true });

  const job = {
    id,
    url,
    dir,
    stage: 'queued',      // queued | downloading | analyzing | ready | error
    progress: 0,
    error: null,
    title: null,
    uploader: '',
    duration: 0,
    thumbnail: '',
    sourceFile: null,
    analysis: null,
    encoded: new Map(),   // "mp3-320" -> absolute path
    createdAt: Date.now(),
    touchedAt: Date.now(),
  };

  jobs.set(id, job);
  return job;
}

export function getJob(id) {
  const job = jobs.get(id);
  if (job) job.touchedAt = Date.now();
  return job;
}

export async function destroyJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  jobs.delete(id);
  await rm(job.dir, { recursive: true, force: true }).catch(() => {});
  return true;
}

/** Public shape sent to the browser — no filesystem paths leak out. */
export function publicView(job) {
  return {
    id: job.id,
    stage: job.stage,
    progress: Math.round(job.progress),
    error: job.error,
    title: job.title,
    uploader: job.uploader,
    duration: job.duration,
    thumbnail: job.thumbnail,
    analysis: job.analysis,
  };
}

export function startSweeper() {
  const timer = setInterval(() => {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, job] of jobs) {
      if (job.touchedAt < cutoff) destroyJob(id);
    }
  }, 10 * 60 * 1000);
  timer.unref();
  return timer;
}

/** Wipe any leftovers from a previous run at startup. */
export async function clearWorkspace(baseDir) {
  await rm(workRoot(baseDir), { recursive: true, force: true }).catch(() => {});
  await mkdir(workRoot(baseDir), { recursive: true });
}
