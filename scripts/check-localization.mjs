import { readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

/**
 * Fails when a string an operator can read is written into a component instead
 * of the message catalogue.
 *
 * The promise this guards is "every displayed text has its own translation".
 * That promise cannot be kept by review: a label typed straight into JSX looks
 * exactly like one that came from `t(...)` until somebody switches locale on a
 * shoot day and reads half a screen in the wrong language. Only a check that
 * runs on every commit keeps the count going one direction.
 *
 * It is a ratchet, not a wall. The tree already holds far more untranslated
 * strings than one change can move, so `localization-baseline.json` records
 * what each file owes today; the check fails when a file exceeds its entry, and
 * equally when a file drops below it without the baseline being lowered. The
 * second half is the part that matters -- a baseline nobody lowers is a number
 * that stops describing the tree, and a stale allowance is how the first kind
 * of failure gets absorbed silently.
 *
 * Run with `--update` to rewrite the baseline from the current tree. That is
 * the intended way to record a wave's progress, and it is deliberately a
 * separate, visible step rather than something the check does for itself.
 */

const require = createRequire(import.meta.url);
const ts = require('typescript');

const workspaceRoot = fileURLToPath(new URL('..', import.meta.url));
const baselinePath = join(workspaceRoot, 'scripts', 'localization-baseline.json');

const sourceRoots = [
  join(workspaceRoot, 'apps', 'hq', 'src'),
  join(workspaceRoot, 'packages', 'ui', 'src'),
];

const ignoredDirectories = new Set([
  '.next',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'playwright-report',
  'target',
  'test-results',
]);

/**
 * Trees this check does not speak for.
 *
 * The catalogue holds the source text by definition. The 52 scene definitions
 * and the world seed are the film's own fiction rather than chrome, and how
 * they reach a second language is a content decision taken elsewhere; counting
 * them here would bury the chrome number under prose no wave is scheduled to
 * touch.
 */
const exemptPrefixes = [
  join('apps', 'hq', 'src', 'application', 'localization') + sep,
  join('apps', 'hq', 'src', 'config', 'scenes') + sep,
  join('apps', 'hq', 'src', 'data', 'operationsSeed.ts'),
];

/** Props whose string value is read by a person rather than by a machine. */
const displayProps = new Set([
  'actionLabel',
  'alt',
  'aria-description',
  'aria-label',
  'aria-roledescription',
  'aria-valuetext',
  'ariaLabel',
  'cancelLabel',
  'caption',
  'confirmLabel',
  'description',
  'emptyLabel',
  'emptyText',
  'eyebrow',
  'heading',
  'helper',
  'hint',
  'label',
  'legend',
  'message',
  'placeholder',
  'submitLabel',
  'summary',
  'text',
  'title',
  'tooltip',
]);

const cyrillic = /[Ѐ-ӿ]/u;

/**
 * Whether a literal is prose an operator reads.
 *
 * Cyrillic settles it outright: nothing in this repository writes an
 * identifier, class name or protocol token in Russian. The Latin cases have to
 * be argued, because ids, BEM class names, MIME types, URLs and `data-`
 * attributes are all strings too -- so a Latin literal counts only when it
 * carries the shape of a caption, and every rejection below names the kind of
 * string it is letting through.
 */
function readsAsProse(value) {
  const text = value.trim();
  if (text.length < 2) return false;
  if (cyrillic.test(text)) return true;
  if (!/[A-Za-z]/.test(text)) return false;
  if (/^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9]+)+$/.test(text)) return false; // setting or message id
  if (/^[a-z-]+(?:__|--)/.test(text)) return false; // BEM class name
  if (/^[\w-]+\/[\w-]+/.test(text)) return false; // MIME type or virtual path
  if (/^(?:#|https?:|\/|data-|\$|--)/.test(text)) return false; // selector, URL, attribute, token
  if (/^[A-Z][A-Z0-9 :/\-–—.,()%'’]{2,}$/.test(text) && /[A-Z]{2,}/.test(text)) return true;
  return /^[A-Z][a-z]+(?: [A-Za-z0-9]+)+$/.test(text);
}

/**
 * The per-site escape hatch.
 *
 * A trailing `// i18n-exempt: reason` on the same line takes one literal out of
 * the count. It requires a reason because the cases that qualify -- a fixture
 * name, a `Intl` tag, a protocol word the tokens namespace already covers --
 * are each a different argument, and an exemption without one is indexed by
 * nothing and reviewed by nobody.
 */
const exemptComment = /\/\/\s*i18n-exempt:\s*\S/;

async function collectSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name))
        files.push(...(await collectSourceFiles(absolutePath)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!['.ts', '.tsx'].includes(extname(entry.name))) continue;
    if (/\.(?:test|spec)\.[cm]?tsx?$/.test(entry.name)) continue;
    files.push(absolutePath);
  }
  return files;
}

function findLiterals(relativePath, source) {
  const sourceFile = ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    relativePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const lines = source.split(/\r?\n/);
  const found = [];

  const record = (node, value) => {
    if (!readsAsProse(value)) return;
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    if (exemptComment.test(lines[line] ?? '')) return;
    found.push({ line: line + 1, value: value.trim().replace(/\s+/g, ' ').slice(0, 100) });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      if (node.text.trim()) record(node, node.text);
    } else if (ts.isJsxAttribute(node) && node.initializer !== undefined) {
      if (displayProps.has(node.name.getText(sourceFile))) {
        const initializer = node.initializer;
        if (ts.isStringLiteral(initializer)) record(node, initializer.text);
        else if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
          const expression = initializer.expression;
          if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
            record(node, expression.text);
          else if (ts.isTemplateExpression(expression)) record(node, expression.head.text);
        }
      }
    } else if (ts.isPropertyAssignment(node)) {
      const key = node.name.getText(sourceFile).replace(/['"]/g, '');
      const initializer = node.initializer;
      if (ts.isStringLiteral(initializer) || ts.isNoSubstitutionTemplateLiteral(initializer)) {
        if (displayProps.has(key) || cyrillic.test(initializer.text))
          record(node, initializer.text);
      }
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const counted = ts.isJsxAttribute(parent) || ts.isPropertyAssignment(parent);
      if (!counted && cyrillic.test(node.text)) record(node, node.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

const counts = new Map();
const samples = new Map();

for (const sourceRoot of sourceRoots) {
  for (const absolutePath of await collectSourceFiles(sourceRoot)) {
    const relativePath = relative(workspaceRoot, absolutePath);
    if (exemptPrefixes.some((prefix) => relativePath.startsWith(prefix))) continue;
    const found = findLiterals(relativePath, await readFile(absolutePath, 'utf8'));
    if (found.length === 0) continue;
    counts.set(relativePath.split(sep).join('/'), found.length);
    samples.set(relativePath.split(sep).join('/'), found);
  }
}

if (process.argv.includes('--update')) {
  const updated = Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  await writeFile(baselinePath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
  process.stdout.write(
    `Localization baseline rewritten: ${counts.size} files, ${total} strings.\n`,
  );
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(await readFile(baselinePath, 'utf8'));
} catch {
  process.stderr.write(
    `Localization baseline missing at ${relative(workspaceRoot, baselinePath)}.\n` +
      'Run `node scripts/check-localization.mjs --update` to record the current tree.\n',
  );
  process.exitCode = 1;
  baseline = null;
}

if (baseline !== null) {
  const regressions = [];
  const stale = [];

  for (const [file, count] of counts) {
    const allowed = baseline[file] ?? 0;
    if (count > allowed) {
      const shown = (samples.get(file) ?? [])
        .slice(0, 3)
        .map((hit) => `    ${file}:${hit.line}: ${hit.value}`);
      regressions.push(`  ${file}: ${count} untranslated, baseline allows ${allowed}`, ...shown);
    } else if (count < allowed) {
      stale.push(`  ${file}: ${count} untranslated, baseline still allows ${allowed}`);
    }
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    if (!counts.has(file) && allowed > 0)
      stale.push(`  ${file}: now clean, baseline allows ${allowed}`);
  }

  if (regressions.length > 0 || stale.length > 0) {
    process.stderr.write(
      [
        ...(regressions.length === 0
          ? []
          : [
              'Untranslated operator-visible strings were added.',
              'Move the text into the message catalogue and read it through `t(...)`,',
              'or mark the site `// i18n-exempt: <reason>` when it is not prose.',
              ...regressions,
              '',
            ]),
        ...(stale.length === 0
          ? []
          : [
              'The localization baseline is stale: these files owe less than it allows.',
              'Run `node scripts/check-localization.mjs --update` and commit the result.',
              ...stale,
              '',
            ]),
      ].join('\n'),
    );
    process.exitCode = 1;
  } else {
    const total = [...counts.values()].reduce((sum, n) => sum + n, 0);
    process.stdout.write(
      `Localization ratchet verified: ${total} untranslated strings in ${counts.size} files, none added.\n`,
    );
  }
}
