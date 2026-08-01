import { cp, rename, rm } from 'node:fs/promises';

function isTransient(err) {
  return err && (err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'ENOTEMPTY');
}

/**
 * Defender/editors can hold a handle open right after a file is written —
 * retry renames instead of failing outright. EXDEV (cross-volume rename,
 * e.g. staging on C: while Laragon's www lives on D:) can't succeed on any
 * retry, so it falls back to copy+delete instead.
 */
export async function renameWithRetry(src, dest, { retries = 5, delayMs = 300 } = {}) {
  let lastErr;
  for (let i = 0; i < retries; i += 1) {
    try {
      await rename(src, dest);
      return;
    } catch (err) {
      lastErr = err;
      if (err.code === 'EXDEV') {
        await cp(src, dest, { recursive: true });
        await rm(src, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
        return;
      }
      if (!isTransient(err)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

export async function rmWithRetry(path, opts = {}) {
  return rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100, ...opts });
}
