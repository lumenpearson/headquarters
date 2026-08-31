import { describe, expect, it } from 'vitest';

import { realtimeStatusToken, type ControlPlaneLinkState } from './connection';
import {
  aggregateDelivery,
  createLinkStates,
  isLinkCarrying,
  isLinkOfSameDatabase,
  linkStatusTokens,
  parseControlPlaneAddressList,
  preferredPublishLinkId,
  validateControlPlaneAddresses,
  validateControlPlaneAddressList,
  withLinkPatch,
  withLinksIdle,
} from './controlPlaneLinks';

/*
 * Two addresses for one group: the plane on the set's LAN, which admits a
 * realtime socket, and the plane on the internet, which does not. Neither is a
 * shoot machine's address; both are placeholders.
 */
const nearPlane = 'http://127.0.0.1:4100';
const cloudPlane = 'https://plane.example';

const installationId = '3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30';

function capabilities(realtimeAdmission: boolean, identity = installationId) {
  return {
    installationId: identity,
    sync: true,
    deviceLifecycle: true,
    realtimeAdmission,
    settings: true,
    materials: false,
  };
}

/** The pair as it stands once both probes have answered. */
function probedPair(): readonly ControlPlaneLinkState[] {
  const [near, cloud] = createLinkStates([nearPlane, cloudPlane]);
  return [
    { ...(near as ControlPlaneLinkState), delivery: 'socket', capabilities: capabilities(true) },
    { ...(cloud as ControlPlaneLinkState), delivery: 'poll', capabilities: capabilities(false) },
  ];
}

describe('resolving the addresses a device holds', () => {
  it('reads a comma-separated variable in the order it was written', () => {
    expect(parseControlPlaneAddressList(` ${nearPlane}, ${cloudPlane} `)).toEqual([
      nearPlane,
      cloudPlane,
    ]);
  });

  it('drops blank entries and keeps a repeat for the validator to refuse', () => {
    // A trailing comma is a typo. A repeated address is a statement the
    // operator made twice, and collapsing it here is what made
    // `controlPlaneUrl`'s "must not repeat an address" rule unreachable.
    expect(parseControlPlaneAddressList(`${nearPlane},,${nearPlane},`)).toEqual([
      nearPlane,
      nearPlane,
    ]);
    expect(parseControlPlaneAddressList('')).toEqual([]);
    expect(parseControlPlaneAddressList('   ')).toEqual([]);
  });

  it('accepts what the project schema accepts', () => {
    expect(validateControlPlaneAddressList(` ${nearPlane}, ${cloudPlane} `)).toEqual({
      ok: true,
      addresses: [nearPlane, cloudPlane],
    });
    // Nothing configured is a valid configuration: a device in no group.
    expect(validateControlPlaneAddresses([])).toEqual({ ok: true, addresses: [] });
  });

  it('names the reason for each shape the schema refuses', () => {
    const reasonFor = (raw: string): string => {
      const outcome = validateControlPlaneAddressList(raw);
      return outcome.ok ? 'accepted' : outcome.refusal.reason;
    };

    expect(reasonFor('C:/Program Files/Git/api')).toBe('msys-rewritten-path');
    expect(reasonFor('192.168.10.5:4100')).toBe('not-a-url');
    expect(reasonFor('ftp://192.168.10.5:4100')).toBe('not-http');
    expect(reasonFor('http://operator:secret@192.168.10.5:4100')).toBe('has-credentials');
    expect(reasonFor(`${nearPlane},${nearPlane}`)).toBe('repeated');
    expect(
      reasonFor(
        'http://a.example,http://b.example,http://c.example,http://d.example,http://e.example',
      ),
    ).toBe('too-many');
  });

  it('names the entry that earned the refusal, not the list', () => {
    // A variable holding four addresses is otherwise a sentence about none of
    // them.
    const outcome = validateControlPlaneAddressList(`${nearPlane},ftp://192.168.10.5:4100`);

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.address).toBe('ftp://192.168.10.5:4100');
  });

  it('keeps the credential out of the refusal it reports', () => {
    // The report is what a message, a store and a diagnostic copy are built
    // from, so the password has to stop here rather than at whichever of them
    // happens to render it.
    const outcome = validateControlPlaneAddressList('http://operator:secret@192.168.10.5:4100');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusal.address).toBe('http://192.168.10.5:4100');
      expect(outcome.refusal.address).not.toContain('secret');
    }
  });

  it('recognises a drive path before the URL parser turns it into a scheme', () => {
    // `new URL('C:/Program Files/Git/api')` succeeds with the protocol `c:`,
    // so the reason would otherwise be the true but useless "not an http
    // address" and the operator would never learn that the build rewrote it.
    const outcome = validateControlPlaneAddressList('C:\\Program Files\\Git\\api');

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.reason).toBe('msys-rewritten-path');
  });

  it('refuses anything the schema refuses, even with no reason to give', () => {
    // The schema decides; this list only explains. A value nothing above can
    // fault still has to be accepted by `controlPlaneUrl` before a client is
    // built for it.
    for (const raw of ['http://', 'https://:4100', 'http://x .example']) {
      expect(validateControlPlaneAddressList(raw).ok, raw).toBe(false);
    }
  });

  it('makes the first address the primary and every other a secondary', () => {
    const links = createLinkStates([nearPlane, cloudPlane]);

    // Order is the operator's statement of preference and the only ranking
    // there is: nothing discovers a plane on the LAN.
    expect(links.map((link) => [link.linkId, link.baseUrl, link.role])).toEqual([
      ['link-0', nearPlane, 'primary'],
      ['link-1', cloudPlane, 'secondary'],
    ]);
    // Unknown counts as the slow path until a probe says otherwise.
    expect(links.every((link) => link.delivery === 'poll')).toBe(true);
    expect(links.every((link) => link.admitted)).toBe(true);
  });

  it('builds nothing from an empty list, which is the local-only case', () => {
    expect(createLinkStates([])).toEqual([]);
  });
});

describe('one link reporting does not overwrite another', () => {
  it('keeps realtime admission true on one plane and false on the other at once', () => {
    const links = createLinkStates([nearPlane, cloudPlane]);

    // The probes land one after another, as they do in the runtime. Before this
    // was a set the second answer replaced the first, and a device holding a
    // live socket reported that it had none.
    const afterNear = withLinkPatch(links, 'link-0', {
      capabilities: capabilities(true),
      delivery: 'socket',
    });
    const afterBoth = withLinkPatch(afterNear, 'link-1', {
      capabilities: capabilities(false),
      delivery: 'poll',
    });

    expect(afterBoth.map((link) => link.capabilities?.realtimeAdmission)).toEqual([true, false]);
    expect(afterBoth.map((link) => link.delivery)).toEqual(['socket', 'poll']);
  });

  it('leaves every other link untouched when one reports a status', () => {
    const links = withLinkPatch(probedPair(), 'link-1', { status: 'polling', lastSequence: 42 });

    const patched = withLinkPatch(links, 'link-0', {
      status: 'live',
      connectionId: 'conn-1',
      lastSequence: 41,
    });

    expect(patched[0]).toMatchObject({ status: 'live', connectionId: 'conn-1', lastSequence: 41 });
    expect(patched[1]).toMatchObject({ status: 'polling', lastSequence: 42 });
  });

  it('changes nothing for a link the runtime has already torn down', () => {
    const links = probedPair();

    expect(withLinkPatch(links, 'link-9', { status: 'live' })).toEqual(links);
  });

  it('puts every link back to carrying nothing while keeping what it is', () => {
    const carrying = withLinkPatch(probedPair(), 'link-0', {
      status: 'live',
      connectionId: 'conn-1',
      lastSequence: 12,
      resyncCount: 2,
    });

    const idle = withLinksIdle(carrying);

    // The address and what the plane can do are facts about the deployment and
    // outlive a session; the socket and the sequence are not.
    expect(idle.map((link) => link.status)).toEqual(['off', 'off']);
    expect(idle.map((link) => link.lastSequence)).toEqual([0, 0]);
    expect(idle.map((link) => link.resyncCount)).toEqual([0, 0]);
    expect(idle.map((link) => link.baseUrl)).toEqual([nearPlane, cloudPlane]);
    expect(idle.map((link) => link.delivery)).toEqual(['socket', 'poll']);
    expect(idle[0]?.capabilities?.realtimeAdmission).toBe(true);
  });
});

describe('where a publication goes', () => {
  it('takes the near plane while it is carrying, the cloud plane when it is not, and back', () => {
    const near = { status: 'live' } as const;
    const dead = { status: 'reconnecting' } as const;
    const cloudPolling = withLinkPatch(probedPair(), 'link-1', { status: 'polling' });

    expect(preferredPublishLinkId(withLinkPatch(cloudPolling, 'link-0', near))).toBe('link-0');
    expect(preferredPublishLinkId(withLinkPatch(cloudPolling, 'link-0', dead))).toBe('link-1');
    // The switch back costs nothing: the answer is asked for per publication.
    expect(preferredPublishLinkId(withLinkPatch(cloudPolling, 'link-0', near))).toBe('link-0');
  });

  it('falls back to the primary when nothing is carrying, so the failure is the call’s', () => {
    expect(preferredPublishLinkId(probedPair())).toBe('link-0');
    expect(preferredPublishLinkId([])).toBeUndefined();
  });

  it('never publishes to a plane answering for a different database', () => {
    const foreign = withLinkPatch(probedPair(), 'link-1', { status: 'polling', admitted: false });
    const withoutNear = withLinkPatch(foreign, 'link-0', { status: 'reconnecting' });

    // Two databases share no receipts, no token table and no sequence
    // allocator. A mutation sent there is not a repeat; it is a different group.
    expect(isLinkCarrying(withoutNear[1] as ControlPlaneLinkState)).toBe(false);
    expect(preferredPublishLinkId(withoutNear)).toBe('link-0');
  });
});

describe('which database a link answers for', () => {
  it('admits a matching identity and refuses a different one', () => {
    expect(isLinkOfSameDatabase(capabilities(false), installationId)).toBe(true);
    expect(isLinkOfSameDatabase(capabilities(false, 'other'), installationId)).toBe(false);
  });

  it('lets unknown proceed on either side, as the session does', () => {
    // An empty report comes from a control plane older than the migration that
    // mints an identity; refusing on it would strand a working deployment on an
    // upgrade ordering.
    expect(isLinkOfSameDatabase(capabilities(false, ''), installationId)).toBe(true);
    expect(isLinkOfSameDatabase(capabilities(false), '')).toBe(true);
    expect(isLinkOfSameDatabase(undefined, installationId)).toBe(true);
  });
});

describe('the lead a device has to publish with', () => {
  it('takes the slowest of the links this device holds', () => {
    /*
     * The decision this stage had to take. A lead is the publisher's: it stamps
     * the instant and everybody else obeys it. A device holding a polling link
     * is a device in a group that has a plane whose members hear late, so it
     * publishes as a polling device -- and every member of a mixed group
     * reaches the same answer from its own configuration, which is what makes
     * the screens converge.
     */
    expect(aggregateDelivery(probedPair())).toBe('poll');
  });

  it('leaves a group that is entirely on the LAN at the socket’s lead', () => {
    const lanOnly = createLinkStates([nearPlane]).map((link) => ({
      ...link,
      delivery: 'socket' as const,
      capabilities: capabilities(true),
    }));

    expect(aggregateDelivery(lanOnly)).toBe('socket');
  });

  it('reads an unprobed link as polling, which is the safe direction', () => {
    // Assuming the slow path where the fast one was available costs a command
    // that lands late on every screen together; the opposite assumption costs
    // screens that disagree.
    expect(aggregateDelivery(createLinkStates([nearPlane, cloudPlane]))).toBe('poll');
  });

  it('ignores a plane answering for a different database, and a device in no group', () => {
    const foreign = withLinkPatch(
      createLinkStates([nearPlane, cloudPlane]).map((link) => ({
        ...link,
        delivery: link.role === 'primary' ? ('socket' as const) : ('poll' as const),
      })),
      'link-1',
      { admitted: false },
    );

    expect(aggregateDelivery(foreign)).toBe('socket');
    expect(aggregateDelivery([])).toBe('socket');
  });
});

describe('what the status line prints', () => {
  it('joins the tokens of the links a device holds', () => {
    const carrying = withLinkPatch(
      withLinkPatch(probedPair(), 'link-0', { status: 'live' }),
      'link-1',
      { status: 'polling' },
    );

    expect(linkStatusTokens(carrying, realtimeStatusToken)).toBe('LIVE+POLL');
  });

  it('collapses repeats and prints the single token when there is no link', () => {
    const twoPolls = createLinkStates([nearPlane, cloudPlane]).map((link) => ({
      ...link,
      status: 'polling' as const,
    }));

    expect(linkStatusTokens(twoPolls, realtimeStatusToken)).toBe('POLL');
    // A local-only session reads exactly as it did before there was a set.
    expect(linkStatusTokens([], realtimeStatusToken)).toBe('OFF');
  });
});
