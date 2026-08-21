import { stat } from 'node:fs/promises';

export async function waitForStableFile(
  filePath: string,
  probeIntervalMs: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let previous: { readonly size: number; readonly modified: number } | null = null;
  while (Date.now() < deadline) {
    try {
      const metadata = await stat(filePath);
      const current = { size: metadata.size, modified: metadata.mtimeMs };
      if (
        previous !== null &&
        current.size === previous.size &&
        current.modified === previous.modified
      )
        return true;
      previous = current;
    } catch {
      previous = null;
    }
    await delay(probeIntervalMs);
  }
  return false;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
