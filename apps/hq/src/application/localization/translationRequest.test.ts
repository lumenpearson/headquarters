import { describe, expect, it } from 'vitest';

import {
  buildTranslationRequestUrl,
  composeTranslationProposal,
  translationProposalPath,
} from './translationRequest';
import type { ElementTranslationEntry } from './elementTranslations';

/** 2026-09-12, 21:05:07 UTC. */
const now = new Date(Date.UTC(2026, 8, 12, 21, 5, 7));

const entry = (element: string, text: string): ElementTranslationEntry => ({
  locale: 'en',
  screen: 'overview',
  element,
  text,
});

const build = (entries: readonly ElementTranslationEntry[]): URL =>
  new URL(
    buildTranslationRequestUrl({
      repository: 'owner/repo',
      branch: 'master',
      locale: 'en',
      entries,
      now,
    }),
  );

describe('the translation pull request', () => {
  it('opens GitHub’s new-file form on the named branch', () => {
    const url = build([entry('brief', 'SHIFT BRIEF')]);

    // `/new/<branch>` and not `/compare/...?quick_pull=1`: the compare form
    // needs a head branch that already exists, and creating one needs a token
    // in the client. This form needs nothing, and GitHub offers "create a
    // branch and start a pull request" on commit.
    expect(url.origin + url.pathname).toBe('https://github.com/owner/repo/new/master');
    expect(url.searchParams.get('filename')).toBe(
      'docs/localization/proposals/en-20260912-210507.md',
    );
  });

  it('names the file by locale and UTC stamp so two proposals do not collide', () => {
    expect(translationProposalPath('en', now)).toBe(
      'docs/localization/proposals/en-20260912-210507.md',
    );
    expect(translationProposalPath('ru', new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe(
      'docs/localization/proposals/ru-20260102-030405.md',
    );
  });

  it('carries every caption with the screen and element it belongs to', () => {
    const value = build([
      entry('brief', 'SHIFT BRIEF'),
      entry('feed', 'EVENT FEED'),
    ]).searchParams.get('value');

    expect(value).toContain('`overview`');
    expect(value).toContain('`brief`');
    expect(value).toContain('`SHIFT BRIEF`');
    expect(value).toContain('`EVENT FEED`');
  });

  it('names the count and the locale in the commit message', () => {
    expect(build([entry('brief', 'A'), entry('feed', 'B')]).searchParams.get('message')).toBe(
      'docs(localization): propose 2 element caption(s) for en',
    );
  });

  it('escapes a caption so it cannot break out of its own table cell', () => {
    // The same hazard the issue draft has, through the same helper: a value is
    // free operator text, so it can hold a backtick, a pipe or a newline, and
    // a naive span would let one caption rewrite the rest of the table.
    const value =
      build([entry('brief', '`| ## НЕ ЗАГОЛОВОК |`\nвторая строка')]).searchParams.get('value') ??
      '';
    const rows = value.split('\n').filter((line) => line.startsWith('| `'));

    expect(rows).toHaveLength(1);
    // The newline is shown rather than allowed to end the row.
    expect(rows[0]).toContain('⏎');
    expect(value).toContain('## НЕ ЗАГОЛОВОК');
    // The heading marker is inside a span, not at the start of a line.
    expect(value.split('\n').some((line) => line.startsWith('## НЕ ЗАГОЛОВОК'))).toBe(false);
  });

  it('never puts a credential-shaped value in the URL', () => {
    // A regression guard on the shape of the payload. No token is held
    // anywhere in this path -- that is the whole reason the link exists rather
    // than an API call.
    const url = buildTranslationRequestUrl({
      repository: 'owner/repo',
      branch: 'master',
      locale: 'en',
      entries: [entry('brief', 'SHIFT BRIEF')],
      now,
    });

    expect(url).not.toContain('token');
    expect(url).not.toContain('secret');
  });

  it('refuses to build a link with nothing to propose', () => {
    expect(() =>
      buildTranslationRequestUrl({
        repository: 'owner/repo',
        branch: 'master',
        locale: 'en',
        entries: [],
        now,
      }),
    ).toThrow('at least one caption');
  });

  it('drops whole rows rather than cutting one, and says how many', () => {
    // Percent-encoding a Cyrillic caption costs nine bytes a character, so a
    // long afternoon of captions outgrows the URL. A table cut wherever the
    // limit fell would be a table the reviewer has to repair first.
    const many = Array.from({ length: 200 }, (_, index) =>
      entry(`tile-${index.toString()}`, 'ОЧЕНЬ ДЛИННАЯ ПОДПИСЬ ПЛИТКИ '.repeat(4)),
    );
    const value = composeTranslationProposal('ru', many, now);
    const rows = value.split('\n').filter((line) => line.startsWith('| `'));

    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(many.length);
    expect(value).toContain('did not fit this link');
    // Every kept row is whole: a cut mid-row would leave a line without its
    // closing pipe.
    for (const row of rows) expect(row.endsWith('|')).toBe(true);
    expect([...value].length).toBeLessThanOrEqual(5000);
  });

  it('cuts on a code-point boundary when it has to cut at all', () => {
    // A cut between the halves of a surrogate pair leaves a lone surrogate,
    // and the URL serializer answers that with U+FFFD -- so the last character
    // of the proposal would arrive as a replacement mark.
    const value = composeTranslationProposal(
      'ru',
      Array.from({ length: 400 }, (_, index) => entry(`tile-${index.toString()}`, '🛰'.repeat(60))),
      now,
    );

    expect(value).not.toContain('�');
    expect(value.match(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u)).toBeNull();
  });
});
