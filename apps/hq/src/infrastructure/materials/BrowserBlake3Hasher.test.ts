import { describe, expect, it } from 'vitest';

import { hashFileInCurrentContext } from './BrowserBlake3Hasher';

describe('hashFileInCurrentContext', () => {
  it('hashes a browser stream incrementally without relying on a Blob buffer', async () => {
    const progress: number[] = [];
    const digest = await hashFileInCurrentContext(
      browserFile('evidence.bin', [new TextEncoder().encode('a'), new TextEncoder().encode('bc')]),
      ({ processedBytes }) => progress.push(processedBytes),
    );

    expect(digest).toBe('6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85');
    expect(progress).toEqual([1, 3]);
  });
});

function browserFile(name: string, chunks: readonly Uint8Array[]): File {
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  return {
    name,
    size,
    stream: () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
  } as File;
}
