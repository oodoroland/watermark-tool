'use strict';

/**
 * Runs at most `concurrency` jobs at once across ALL requests, so ten visitors exporting at the
 * same time share the CPU instead of each starting their own set of sharp jobs.
 *
 * Callers check `canAccept(n)` before queuing n jobs and answer 503 when it is false, so the
 * queue (and the memory behind it) stays bounded.
 */
function createJobLimiter({ concurrency, maxQueued }) {
  let active = 0;
  const waiting = [];

  function next() {
    if (active >= concurrency || waiting.length === 0) return;
    active++;
    const { job, resolve, reject } = waiting.shift();
    Promise.resolve()
      .then(job)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  }

  return {
    /** True if n more jobs fit in the queue right now. */
    canAccept: (n = 1) => waiting.length + n <= maxQueued,
    run(job) {
      return new Promise((resolve, reject) => {
        waiting.push({ job, resolve, reject });
        next();
      });
    },
    stats: () => ({ active, queued: waiting.length }),
  };
}

module.exports = { createJobLimiter };
