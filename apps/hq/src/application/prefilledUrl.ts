/**
 * The two things a prefilled GitHub link has to get right, shared by the two
 * that now build one.
 *
 * `buildIssueDraftUrl` (R7) proved the principle: a URL rather than an API
 * call, so no token is ever held by this application and the operator stays
 * the author of whatever GitHub creates. `buildTranslationRequestUrl` (R28)
 * needs the same escaping and the same ceiling against a different endpoint,
 * and a second copy of either would be a second thing to fix the next time a
 * value arrives that neither anticipated.
 */

/**
 * Renders `text` as a markdown code span that survives whatever it contains.
 *
 * A content value is free operator text of up to 1200 characters, so it can
 * hold backticks and newlines, and a naive pair of backticks would let one
 * value close its own span and rewrite the rest of the list as headings or
 * bullets. Markdown's own rule handles the backticks: a span may be fenced by
 * any number of them, as long as the fence is longer than the longest run
 * inside. Newlines cannot appear in a span at all, so they are shown as `⏎`.
 */
export function codeSpan(text: string): string {
  const flat = text.replaceAll(/\r\n|\r|\n/gu, ' ⏎ ');
  const longestRun = [...flat.matchAll(/`+/gu)].reduce(
    (longest, match) => Math.max(longest, match[0].length),
    0,
  );
  const fence = '`'.repeat(longestRun + 1);
  // A span that begins or ends with a backtick needs a space the renderer eats.
  const padding = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${fence}${padding}${flat}${padding}${fence}`;
}

/**
 * Conservative because the ceiling is not ours to know: browsers differ, and
 * GitHub answers a long query string with its own error page rather than the
 * form. Percent-encoding is what makes this smaller than it looks.
 */
export const prefilledBodyLimit = 6000;

/**
 * Length in code points, which is the unit a URL is cut in.
 *
 * `String.length` counts UTF-16 units, so an emoji or any astral character
 * counts twice and a cut taken on that count can land between the halves of a
 * surrogate pair. Exported because the translation proposal measures the same
 * way while dropping whole table rows, and two ways of measuring "how long is
 * this" is how one of them comes to be wrong.
 */
export function codePointLength(text: string): number {
  return [...text].length;
}

/**
 * The body a browser will still open.
 *
 * Eleven content fields hold up to 1200 characters each, and percent-encoding
 * roughly triples what a value costs, so a long afternoon of edits can outgrow
 * the URL and the link then fails as a whole rather than arriving short. Cut
 * on a code-point boundary: a cut between the halves of a surrogate pair
 * leaves a lone surrogate, and the URL serializer answers that by substituting
 * U+FFFD, so the last character of the list arrives as a replacement mark. The
 * control plane's own prefilled issue hit the same edge and cuts the same way.
 *
 * `notice` is the caller's, because what a truncated list should say depends
 * on what the reader is holding: a markdown issue body says so in a sentence,
 * and a proposed file says so in a comment its own format tolerates.
 */
export function clampPrefilledBody(
  body: string,
  notice: string,
  limit: number = prefilledBodyLimit,
): string {
  const points = [...body];
  if (points.length <= limit) return body;
  return points.slice(0, limit - [...notice].length).join('') + notice;
}
