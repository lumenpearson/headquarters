import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Renders an environment file from a `.env.example`, minting a fresh secret for
 * every placeholder that asks for one.
 *
 * The reason this exists rather than a paragraph of instructions: the two
 * secrets a control plane needs are 32-non-whitespace-character values that
 * nothing checks the quality of. Told to invent them, a first-time operator
 * invents something memorable, and the deployment that follows is one
 * dictionary away from a forged access token. `randomBytes(48)` is not a
 * suggestion an operator can accidentally decline.
 *
 * It prints variable NAMES and the output path. It never prints a value, and it
 * never reads one back out of an existing file: there is no code path here that
 * can put a live secret on a terminal, in a CI log, or in a shell history.
 */

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const generateMarker = '<generate>';
/**
 * 48 bytes is 64 base64url characters, comfortably past the 32-non-whitespace
 * floor `requireSecret` in `apps/control-plane/src/config.ts` enforces, and
 * base64url so the value can be written into a `.env`, a compose file and a
 * connection URL without quoting or escaping.
 */
const secretBytes = 48;
const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u;

const options = parseArguments(process.argv.slice(2));
const template = await readTemplate(options.templatePath);
const rendered = render(template);

try {
  await writeFile(options.outputPath, rendered.text, {
    encoding: 'utf8',
    // `wx` unless forced, so the refusal is the write itself rather than a
    // check before it. A separate existence check would leave a window in
    // which two runs both decide the file is absent and the second overwrites
    // secrets the first has already been deployed with.
    flag: options.force ? 'w' : 'wx',
    // Honoured where the platform has file modes; ignored on Windows, and
    // ignored on an existing file under `--force`.
    mode: 0o600,
  });
} catch (error) {
  if (isAlreadyExists(error)) {
    process.stderr.write(
      [
        `${options.outputPath} already exists and was left untouched.`,
        'Re-run with --force to replace it, which mints new secrets and invalidates every',
        'access token, refresh token and pairing code issued under the old ones.',
        '',
      ].join('\n'),
    );
    process.exitCode = 1;
  } else {
    throw error;
  }
}

if (process.exitCode !== 1) {
  process.stdout.write(
    [
      `Wrote ${options.outputPath} from ${options.templatePath}`,
      `Generated: ${nameList(rendered.generated)}`,
      `Copied from the template: ${nameList(rendered.copied)}`,
      'No value is printed here or anywhere else by this script.',
      '',
    ].join('\n'),
  );
}

function parseArguments(argv) {
  let templatePath;
  let outputPath;
  let force = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--force') {
      force = true;
      continue;
    }
    if (flag === '--template') {
      templatePath = requireValue(argv, (index += 1), flag);
      continue;
    }
    if (flag === '--out') {
      outputPath = requireValue(argv, (index += 1), flag);
      continue;
    }
    throw new Error(
      `Unknown argument: ${flag}\nUsage: node scripts/generate-env.mjs [--template <path>] [--out <path>] [--force]`,
    );
  }

  // The repository root `.env.example` is the compose file's own environment,
  // which is the case this script is reached for by default. `--template`
  // serves the other one, `apps/control-plane/.env.example`, without a second
  // script that could drift from this one.
  const template = absolute(templatePath ?? resolve(workspaceRoot, '.env.example'));
  return {
    templatePath: template,
    outputPath: absolute(outputPath ?? stripExampleSuffix(template)),
    force,
  };
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function absolute(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function stripExampleSuffix(path) {
  if (!path.endsWith('.example')) {
    throw new Error(`Cannot infer an output path from ${path}; pass --out explicitly`);
  }
  return path.slice(0, -'.example'.length);
}

async function readTemplate(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`Template not found: ${path}`);
    throw error;
  }
}

/**
 * Replaces every `<generate>` placeholder with its own fresh value.
 *
 * Per occurrence, not once per run: the token pepper and the bootstrap secret
 * are two independent secrets by design, and one value written into both would
 * quietly undo that. A commented-out line is left alone, because a template
 * comments out exactly the assignments it means to leave unset.
 */
function render(template) {
  const generated = [];
  const copied = [];
  const lines = template.split(/\r?\n/u).map((line) => {
    const match = assignment.exec(line);
    if (match === null) return line;
    const [, name, value] = match;
    if (value.trim() !== generateMarker) {
      copied.push(name);
      return line;
    }
    generated.push(name);
    return `${name}=${randomBytes(secretBytes).toString('base64url')}`;
  });
  return { text: lines.join('\n'), generated, copied };
}

function nameList(names) {
  return names.length === 0 ? '(none)' : names.join(', ');
}

function isAlreadyExists(error) {
  return typeof error === 'object' && error !== null && error.code === 'EEXIST';
}
