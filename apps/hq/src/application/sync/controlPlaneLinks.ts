/**
 * The algebra of a device's links to one group (F14, stage 7).
 *
 * A group may be reachable two ways at once: a control plane on the set's LAN,
 * which admits a realtime socket and answers in milliseconds, and one deployed
 * to the public internet, which admits no socket and is followed by polling.
 * Both stand in front of *the same database*, so they are two connections to
 * one group rather than two groups -- the sequence allocator holds a row lock
 * and hands out the commit order, an access token is verified by hash with no
 * issuer recorded, and a mutation repeated across the planes is answered by its
 * receipt.
 *
 * Everything here is a pure function of the configured addresses or of the link
 * set they become. It owns no client, no timer and no transport: what a device
 * does with several links is a decision that has to be readable and testable on
 * its own, and the components below supply the clients this reasons about.
 *
 * The address checks sit at the top of the file rather than in the module that
 * reads one of the three sources, because all three have to reach the same
 * verdict and a rule with three homes has three chances to differ.
 */

import {
  controlPlaneAddressLimit,
  controlPlaneAddressRefusal,
  projectConfigSchema,
  type ControlPlaneAddressRefusal,
} from '@gremuchaya/config';

import type { ControlPlaneCapabilities, ControlPlaneLinkState } from './connection';
import type { GroupEventDelivery } from './groupEventFeed';

/**
 * The entries a configured address list names, in order, before any of them has
 * been judged an address.
 *
 * Comma-separated, because an environment variable is one string and the web
 * build has nowhere else to name a second plane. Blank entries are dropped
 * rather than refused: a trailing comma in a deployment variable is a typo, not
 * an instruction to build a client against the empty address.
 *
 * A repeat is *kept* here and refused by {@link validateControlPlaneAddresses}.
 * Dropping it silently was how `controlPlaneUrl`'s own "must not repeat an
 * address" rule came to be unreachable from two of the three places an address
 * is configured: by the time the schema saw the list there was only ever one
 * entry left, so the in-app field promised a rule in its refusal text that
 * nothing enforced, and what the operator wrote was not what the client used.
 */
export function parseControlPlaneAddressList(raw: string): readonly string[] {
  const entries: string[] = [];
  for (const entry of raw.split(',')) {
    const address = entry.trim();
    if (address.length !== 0) entries.push(address);
  }
  return entries;
}

/**
 * `controlPlaneUrl`'s own schema, guarded against a defect in its refine step:
 * `controlPlaneAddressSchema` (`packages/config/src/projectSchemas.ts`) calls
 * `new URL(value)` inside a `.refine`, which throws for a string `z.url()`
 * still accepts -- one with no scheme at all, which is exactly what an operator
 * typing an address without `http://` produces. `.safeParse` catches a
 * validation issue but not an exception a refinement callback throws, so the
 * raw throw would otherwise reach this module's caller as an unhandled
 * rejection or a crashed render for the one input this exists to refuse
 * cleanly.
 */
export function safeParseControlPlaneUrl(
  value: unknown,
): { readonly success: true; readonly data: readonly string[] } | { readonly success: false } {
  try {
    const result = projectConfigSchema.shape.controlPlaneUrl.safeParse(value);
    return result.success ? { success: true, data: result.data } : { success: false };
  } catch {
    return { success: false };
  }
}

/**
 * Why a configured address list is not one this device will build clients
 * against.
 *
 * The per-address reasons come from `packages/config`, which owns what an
 * address is; the three added here are properties of the list rather than of
 * any one entry. `unclassified` is the deliberate catch-all: the schema is the
 * authority on whether a list is usable, and a list it refuses for a reason
 * nothing here can name is still refused rather than let through.
 */
export type ControlPlaneAddressListRefusal =
  ControlPlaneAddressRefusal | 'repeated' | 'too-many' | 'unclassified';

export interface ControlPlaneAddressRefusalReport {
  readonly reason: ControlPlaneAddressListRefusal;
  /**
   * The entry that earned the refusal, or `''` when the list as a whole did.
   * Carried so the operator is told *which* address was refused: a build
   * variable holding four of them is otherwise a sentence about none of them.
   */
  readonly address: string;
}

export type ControlPlaneAddressListOutcome =
  | { readonly ok: true; readonly addresses: readonly string[] }
  | { readonly ok: false; readonly refusal: ControlPlaneAddressRefusalReport };

/**
 * The one check every configured address list passes, whichever of the three
 * places it came from.
 *
 * The in-app field and `project.override.json` were already checked against
 * `controlPlaneUrl`'s schema; `NEXT_PUBLIC_HQ_CONTROL_PLANE_URL` was split on
 * commas and used as it stood. A build variable is not more trustworthy than a
 * typed one -- it is less, because nobody sees it after the build -- and the
 * value that reached `fetch` unexamined was `C:/Program Files/Git/api`, which
 * Git Bash had made of the documented `/api`. What the operator read was the
 * browser's `NetworkError`, which describes the symptom of a request that never
 * left rather than the configuration that could not produce one.
 *
 * The order of the checks is the order an operator can act on: a named entry
 * first, so the sentence points at one address; the list-wide ceiling last,
 * because a list of five with a malformed first entry is better answered by
 * naming that entry than by counting.
 *
 * The schema runs last and decides. A list nothing above could fault is
 * accepted only if `controlPlaneUrl` accepts it, so this function can never
 * widen what the file and the field allow -- it can only explain a refusal
 * better.
 */
export function validateControlPlaneAddresses(
  entries: readonly string[],
): ControlPlaneAddressListOutcome {
  const seen = new Set<string>();
  for (const entry of entries) {
    const refusal = controlPlaneAddressRefusal(entry);
    if (refusal !== undefined) {
      return {
        ok: false,
        refusal: { reason: refusal, address: reportableAddress(entry, refusal) },
      };
    }
    if (seen.has(entry)) return { ok: false, refusal: { reason: 'repeated', address: entry } };
    seen.add(entry);
  }
  if (entries.length > controlPlaneAddressLimit) {
    return { ok: false, refusal: { reason: 'too-many', address: '' } };
  }
  const parsed = safeParseControlPlaneUrl(entries);
  if (parsed.success) return { ok: true, addresses: parsed.data };
  return { ok: false, refusal: { reason: 'unclassified', address: entries[0] ?? '' } };
}

/**
 * The part of a refused entry that may be repeated back to the operator.
 *
 * Every reason but one names the entry as it was written, which is what makes
 * the refusal actionable. `has-credentials` cannot: the entry *is* a
 * credential, and a password rendered on a status line is a password in the
 * next photograph of that screen. Its origin says which address was refused and
 * carries neither the user name nor the password, so the secret stops here
 * rather than travelling into a message, a store or a diagnostic report.
 */
function reportableAddress(entry: string, reason: ControlPlaneAddressRefusal): string {
  if (reason !== 'has-credentials') return entry;
  try {
    return new URL(entry).origin;
  } catch {
    return '';
  }
}

/** {@link validateControlPlaneAddresses} over one comma-separated string. */
export function validateControlPlaneAddressList(raw: string): ControlPlaneAddressListOutcome {
  return validateControlPlaneAddresses(parseControlPlaneAddressList(raw));
}

/**
 * The link set as it stands before anything has been probed.
 *
 * The first address is the primary: it is the operator's stated preference, and
 * it is the one client that may write credentials. Order carries the whole
 * ranking because there is no discovery on the LAN and there is not going to be
 * one -- the near plane is the address written first.
 *
 * `delivery` starts at `poll` for every link and becomes `socket` only when
 * that link's own probe reports realtime admission. Unknown counts as the slow
 * path on purpose; see {@link aggregateDelivery}.
 */
export function createLinkStates(addresses: readonly string[]): readonly ControlPlaneLinkState[] {
  return addresses.map((baseUrl, index) => ({
    linkId: `link-${String(index)}`,
    baseUrl,
    role: index === 0 ? 'primary' : 'secondary',
    admitted: true,
    delivery: 'poll',
    status: 'off',
    connectionId: '',
    lastSequence: 0,
    resyncCount: 0,
  }));
}

/**
 * One link's fields replaced, the rest untouched.
 *
 * The whole reason the state is a list: two transports reporting at the same
 * time used to overwrite one record, so the near plane's `LIVE` and the cloud
 * plane's `POLL` were the same field and the later report won. An unknown link
 * id changes nothing rather than appending, because a report from a link the
 * runtime has already torn down is about a connection that no longer exists.
 */
export function withLinkPatch(
  links: readonly ControlPlaneLinkState[],
  linkId: string,
  patch: Partial<Omit<ControlPlaneLinkState, 'linkId'>>,
): readonly ControlPlaneLinkState[] {
  return links.map((link) => (link.linkId === linkId ? { ...link, ...patch } : link));
}

/**
 * Every link put back to carrying nothing, keeping what it is.
 *
 * The address, the role and what the plane can do are facts about the
 * deployment and survive a session ending; the socket, the sequence and the
 * resync count are facts about a connection and do not.
 */
export function withLinksIdle(
  links: readonly ControlPlaneLinkState[],
): readonly ControlPlaneLinkState[] {
  return links.map((link) => ({
    ...link,
    status: 'off',
    connectionId: '',
    lastSequence: 0,
    resyncCount: 0,
  }));
}

/** Whether this link is carrying the group right now. */
export function isLinkCarrying(link: ControlPlaneLinkState): boolean {
  return link.admitted && (link.status === 'live' || link.status === 'polling');
}

/**
 * Whether this link's control plane reported the group's own database.
 *
 * The primary link is admitted by definition -- it is the one the session was
 * checked against -- and a secondary is admitted when its `installationId`
 * matches the primary's, or when either side reports none. Unknown proceeds for
 * the reason `ControlPlaneSession` gives it: an empty report comes from a
 * control plane older than the migration that mints an identity, and refusing
 * on it would strand a working deployment on an upgrade ordering.
 *
 * A disagreement is not a degraded link but a different group. Two addresses in
 * front of two databases share no sequence allocator, no token table and no
 * receipts, so following both would merge two logs into one cursor and drop
 * every second event as already applied.
 */
export function isLinkOfSameDatabase(
  capabilities: ControlPlaneCapabilities | undefined,
  groupInstallationId: string,
): boolean {
  const reported = capabilities?.installationId ?? '';
  return reported === '' || groupInstallationId === '' || reported === groupInstallationId;
}

/**
 * Where a publication goes, or `undefined` when no link is carrying anything.
 *
 * The first carrying link in the operator's order, which is the near plane
 * while it is alive and the cloud plane while it is not, and the near plane
 * again the moment it comes back. Publishing to both would be safe -- the
 * mutation receipt in the shared database answers the repeat rather than
 * appending a second event -- but it would spend a metered invocation to learn
 * nothing, so the choice is made rather than avoided.
 *
 * A socket between attempts is treated as not carrying. That is a deliberate
 * over-read of the signal: the socket dropping does not prove the plane's unary
 * endpoint is unreachable, but it is the evidence this client has without
 * paying for a second health probe, and moving the publication to the other
 * plane is safe in a way that guessing the near plane is still there is not.
 */
export function preferredPublishLinkId(
  links: readonly ControlPlaneLinkState[],
): string | undefined {
  return links.find(isLinkCarrying)?.linkId ?? links.find((link) => link.admitted)?.linkId;
}

/**
 * The delivery path a playback lead has to cover on this device.
 *
 * **The decision this stage had to take, and why it is the maximum.** A
 * playback lead is a property of the *publisher*: it stamps `execute_at`, and
 * every other screen obeys the instant it was given. In a group where some
 * members are fed by a socket and some by a poll, a publisher using the
 * socket's 40 ms sends a command whose instant has already passed by the time
 * the poll carries it, and the screens outside the LAN then run it on arrival
 * -- a different moment on each of them, which is the exact divergence the lead
 * exists to prevent.
 *
 * So the lead is taken over the device's *own* links: a device holding any link
 * that polls publishes as a polling device. That works because holding both
 * links is what this stage is for. A screen on the LAN is configured with the
 * near plane *and* the cloud plane precisely so that it experiences the group
 * the way the members outside it do; "I hold a polling link" therefore means
 * "this group has a plane whose members hear late", and every member of a mixed
 * group arrives at the same answer from its own configuration. Uniformity is
 * the property that matters: everybody who can fall behind falls behind by the
 * same amount, so the screens converge.
 *
 * The precondition is worth stating because it is the one way this can be got
 * wrong: a LAN screen configured with the near plane *only*, in a group that
 * also has a cloud plane, publishes at 40 ms and the outside screens miss the
 * instant. Nothing in this client can detect that -- presence names devices,
 * not how each of them is fed -- so it is a configuration rule and is written
 * down as one in `docs/release/known-limitations.md`.
 *
 * A link whose probe has not answered counts as polling. That is the safe
 * direction: the cost of assuming the slow path where the fast one was
 * available is a command that lands late on every screen together, and the cost
 * of the opposite assumption is screens that disagree.
 *
 * With no links at all the answer is `socket`, which is the compiled-in
 * default: a device in no group publishes to nobody, and raising its own lead
 * would delay its own screen for the benefit of an empty group.
 */
export function aggregateDelivery(links: readonly ControlPlaneLinkState[]): GroupEventDelivery {
  if (links.length === 0) return 'socket';
  const followed = links.filter((link) => link.admitted);
  if (followed.length === 0) return 'socket';
  return followed.some((link) => link.delivery === 'poll') ? 'poll' : 'socket';
}

/**
 * The link tokens the shell prints after the mode, joined by `+`.
 *
 * `ONLINE/LIVE+POLL` is a device holding both planes; `ONLINE/LIVE` is a
 * shoot-day LAN with no cloud plane; `ONLINE/POLL` is a session outside it.
 * Repeats are collapsed so that two cloud planes read `POLL` rather than
 * `POLL+POLL`: the operator is being told which kinds of link exist, and the
 * addresses themselves are one keystroke away in the transport popover.
 *
 * With no links the answer is the single `OFF` token the row printed before
 * there was a set, so a local-only session reads exactly as it did.
 */
export function linkStatusTokens(
  links: readonly ControlPlaneLinkState[],
  token: (status: ControlPlaneLinkState['status']) => string,
): string {
  if (links.length === 0) return token('off');
  const tokens: string[] = [];
  for (const link of links) {
    const printed = token(link.status);
    if (!tokens.includes(printed)) tokens.push(printed);
  }
  return tokens.join('+');
}
