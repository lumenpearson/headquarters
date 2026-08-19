import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface HashProgress {
  readonly processedBytes: number;
  readonly totalBytes: number;
}

export interface BrowserFileHasher {
  hash(
    file: File,
    onProgress?: (progress: HashProgress) => void,
    signal?: AbortSignal,
  ): Promise<string>;
}

interface WorkerSuccess {
  readonly type: 'success';
  readonly hash: string;
}

interface WorkerProgress {
  readonly type: 'progress';
  readonly processedBytes: number;
}

interface WorkerFailure {
  readonly type: 'failure';
  readonly message: string;
}

type WorkerResponse = WorkerSuccess | WorkerProgress | WorkerFailure;

/**
 * Calculates the client-side expected BLAKE3 digest without materializing a
 * File in JavaScript memory. Modern browsers run this stream reader in a
 * module worker; the small fallback keeps the local bridge usable in the
 * legacy shell where module workers are unavailable.
 */
export const browserBlake3Hasher: BrowserFileHasher = {
  hash(file, onProgress, signal) {
    if (typeof Worker === 'undefined') return hashFileInCurrentContext(file, onProgress, signal);
    return hashFileInWorker(file, onProgress, signal);
  },
};

export async function hashFileInCurrentContext(
  file: File,
  onProgress?: (progress: HashProgress) => void,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal);
  const hasher = blake3.create();
  const reader = file.stream().getReader();
  let processedBytes = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      processedBytes += value.byteLength;
      onProgress?.({ processedBytes, totalBytes: file.size });
    }
    if (processedBytes !== file.size) {
      throw new Error('Browser stream size differs from the selected material metadata.');
    }
    return bytesToHex(hasher.digest());
  } finally {
    reader.releaseLock();
  }
}

function hashFileInWorker(
  file: File,
  onProgress: ((progress: HashProgress) => void) | undefined,
  signal: AbortSignal | undefined,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./materialHash.worker.ts', import.meta.url), {
      type: 'module',
      name: 'hq-material-blake3',
    });
    let settled = false;
    const close = () => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      close();
      callback();
    };
    const abort = () => finish(() => reject(abortError(signal)));

    if (signal?.aborted) {
      abort();
      return;
    }

    worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      if (response.type === 'progress') {
        onProgress?.({ processedBytes: response.processedBytes, totalBytes: file.size });
        return;
      }
      if (response.type === 'success') {
        finish(() => resolve(response.hash));
        return;
      }
      finish(() => reject(new Error(response.message)));
    });
    worker.addEventListener('error', () => {
      finish(() => reject(new Error('The material hashing worker failed.')));
    });
    signal?.addEventListener('abort', abort, { once: true });
    worker.postMessage({ file });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('Aborted', 'AbortError');
}
