import { readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const generatedRoot = resolve(import.meta.dirname, '..', 'src', 'gen');

for (const file of await listFiles(generatedRoot)) {
  if (!file.endsWith('.ts')) continue;
  const source = await readFile(file, 'utf8');
  const normalized = source.replace(/\r?\n(?:[ \t]*\r?\n)+$/u, '\n');
  if (normalized !== source) await writeFile(file, normalized, 'utf8');
}

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : Promise.resolve([path]);
    }),
  );
  return nested.flat().sort();
}
