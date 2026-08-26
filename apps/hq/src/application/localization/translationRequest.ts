import { clampPrefilledBody, codePointLength, codeSpan } from '@/application/prefilledUrl';

import type { ElementTranslationEntry } from './elementTranslations';
import type { AppLocale } from './messages';

/**
 * The other half of R28: the operator's captions, prepared as a file and
 * handed to GitHub for a pull request.
 *
 * ## Why `/new/`, and not `/compare/`
 *
 * `https://github.com/<owner>/<repo>/compare/<base>...<head>?quick_pull=1`
 * opens a pull request form, but only for a head branch that already exists --
 * and creating one needs a token in the client, which is the thing
 * `buildIssueDraftUrl` established this application will not hold.
 * `https://github.com/<owner>/<repo>/new/<branch>?filename=…&value=…` needs
 * nothing: it opens GitHub's web editor with the file and its content already
 * in place, and GitHub's own commit form then offers "create a new branch for
 * this commit and start a pull request". The branch, the commit and the pull
 * request are all the operator's, made with their credentials, in their
 * account.
 *
 * ## What the application cannot know
 *
 * The resulting pull request has no address until the operator commits, and
 * this application never learns it -- there is no token to poll with and no
 * callback to receive. The panel says so (`edit.translation.proposeHint`)
 * rather than showing a link that would stay empty. An application that
 * promised a link and produced none would read as a failed request instead of
 * as the boundary it is.
 */

export interface TranslationRequestInput {
  readonly repository: string;
  /** The branch the file is opened against; GitHub branches from it on commit. */
  readonly branch: string;
  readonly locale: AppLocale;
  readonly entries: readonly ElementTranslationEntry[];
  /** Names the file, so two proposals from one afternoon do not collide. */
  readonly now: Date;
}

/**
 * A new path every time, under a directory of its own.
 *
 * The `/new/` form refuses to commit over an existing file, so a proposal
 * cannot be written straight into `messages.ts`; it also should not be. A
 * caption is a proposal until somebody reviews it, and the reviewer is the one
 * who decides whether it belongs in the catalogue, in the seed, or nowhere.
 * The stamp is UTC and digits only: a file name has to sort, and a name
 * formatted in the operator's locale would sort by whatever that locale
 * happens to put first.
 */
export function translationProposalPath(locale: AppLocale, now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = [
    now.getUTCFullYear().toString(),
    pad(now.getUTCMonth() + 1),
    pad(now.getUTCDate()),
    '-',
    pad(now.getUTCHours()),
    pad(now.getUTCMinutes()),
    pad(now.getUTCSeconds()),
  ].join('');
  return `docs/localization/proposals/${locale}-${stamp}.md`;
}

const truncationNotice =
  '\n\n_Truncated so the link would open. Re-open the draft to propose the rest._';

/**
 * The file the pull request carries.
 *
 * Markdown and a table rather than JSON: the first reader is a person deciding
 * whether a caption is right, not a program merging it, and GitHub renders
 * this in the pull request itself. Every operator value goes through
 * `codeSpan`, the same escaping the issue draft uses, so a caption containing
 * a backtick or a pipe cannot close its own cell and rewrite the rest of the
 * table.
 */
export function composeTranslationProposal(
  locale: AppLocale,
  entries: readonly ElementTranslationEntry[],
  now: Date,
): string {
  const heading = [
    `# Translation proposal: ${locale}`,
    '',
    `Prepared in edit mode on ${now.toISOString()}.`,
    '',
    'Each row is the caption one screen gives one tile in this locale. A caption',
    'accepted here belongs in `apps/hq/src/application/localization/messages.ts`',
    'under the locale it was written for; this file is the proposal, not the',
    'catalogue.',
    '',
    '| Screen | Element | Caption |',
    '| --- | --- | --- |',
  ];
  const rows = entries.map(
    (entry) =>
      `| ${codeSpan(entry.screen)} | ${codeSpan(entry.element)} | ${codeSpan(entry.text)} |`,
  );

  /*
   * Whole rows are dropped rather than the text being cut wherever the limit
   * falls: a table cut mid-row is a table a reviewer has to repair before they
   * can read it, and the point of the ceiling is that the link opens at all.
   * `clampPrefilledBody` still runs afterwards as the guarantee -- it is what
   * makes the limit true even for a heading nobody anticipated.
   */
  const kept = [...rows];
  const body = (): string => [...heading, ...kept].join('\n');
  let omitted = 0;
  while (kept.length > 0 && codePointLength(body()) > proposalLimit) {
    kept.pop();
    omitted += 1;
  }
  const tail =
    omitted === 0 ? [] : ['', `_${omitted.toString()} further caption(s) did not fit this link._`];
  return clampPrefilledBody([...heading, ...kept, ...tail].join('\n'), truncationNotice);
}

/**
 * Smaller than the issue draft's ceiling, because this content is spent twice:
 * once as `value` and again, at roughly a third of the length, as the commit
 * message and the file name. Percent-encoding a Cyrillic caption costs nine
 * bytes per character, so the headroom is not decoration.
 */
const proposalLimit = 5000;

export function buildTranslationRequestUrl({
  repository,
  branch,
  locale,
  entries,
  now,
}: TranslationRequestInput): string {
  if (entries.length === 0) {
    throw new Error('A translation proposal needs at least one caption; this one has none.');
  }
  const url = new URL(`https://github.com/${repository}/new/${branch}`);
  url.searchParams.set('filename', translationProposalPath(locale, now));
  url.searchParams.set('value', composeTranslationProposal(locale, entries, now));
  url.searchParams.set(
    'message',
    `docs(localization): propose ${entries.length.toString()} element caption(s) for ${locale}`,
  );
  return url.toString();
}
