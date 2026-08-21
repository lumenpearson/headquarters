import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

interface HashRequest {
  readonly file: File;
}

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<HashRequest>) => void): void;
  postMessage(message: HashResponse): void;
};

type HashResponse =
  | { readonly type: 'progress'; readonly processedBytes: number }
  | { readonly type: 'success'; readonly hash: string }
  | { readonly type: 'failure'; readonly message: string };

const workerScope = globalThis as unknown as WorkerScope;

workerScope.addEventListener('message', (event) => {
  void hashFile(event.data.file)
    .then((hash) => workerScope.postMessage({ type: 'success', hash }))
    .catch((error: unknown) =>
      workerScope.postMessage({
        type: 'failure',
        message: error instanceof Error ? error.message : 'Unknown material hashing failure.',
      }),
    );
});

async function hashFile(file: File): Promise<string> {
  const hasher = blake3.create();
  const reader = file.stream().getReader();
  let processedBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      hasher.update(value);
      processedBytes += value.byteLength;
      workerScope.postMessage({ type: 'progress', processedBytes });
    }
    if (processedBytes !== file.size) {
      throw new Error('Browser stream size differs from the selected material metadata.');
    }
    return bytesToHex(hasher.digest());
  } finally {
    reader.releaseLock();
  }
}
