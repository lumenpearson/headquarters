import { extname } from 'node:path';

const mimeByExtension: Readonly<Record<string, string>> = {
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
};

export function mimeForPath(filePath: string): string {
  return (
    mimeByExtension[extname(filePath).toLocaleLowerCase('en-US')] ?? 'application/octet-stream'
  );
}
