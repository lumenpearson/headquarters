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
 * Everything here is a pure function of the link set. It owns no client, no
 * timer and no transport: what a device does with several links is a decision
 * that has to be readable and testable on its own, and the components below
 * supply the clients this reasons about.
 */

import type { ControlPlaneCapabilities, ControlPlaneLinkState } from './connection';
import type { GroupEventDelivery } from './groupEventFeed';

/**
 * The addresses named by an environment variable, in order.
 *
 * Comma-separated, because an environment variable is one string and the web
 * build has nowhere else to name a second plane. Blank entries are dropped
 * rather than refused: a trailing comma in a deployment variable is a typo, not
 * an instruction to build a client against the empty address. Repeats are
 * dropped for the reason the project schema refuses them -- a second client
 * against the same plane doubles the polling bill and delivers nothing new.
 */
export function parseControlPlaneAddressList(raw: string): readonly string[] {
  const seen = new Set<string>();
  for (const entry of raw.split(',')) {
    const address = entry.trim();
    if (address.length !== 0) seen.add(address);
  }
  return [...seen];
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
