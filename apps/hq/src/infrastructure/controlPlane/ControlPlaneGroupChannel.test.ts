import { describe, expect, it } from 'vitest';

import type { ControlPlanePort } from '@/application/sync/controlPlanePort';
import type { GroupEventEnvelope } from '@/application/sync/groupChannel';

import { ControlPlaneGroupChannel } from './ControlPlaneGroupChannel';

/**
 * The channel is the group's merge point, so what it must prove is that two
 * transports carrying one order produce one application of each event.
 *
 * A group has exactly one order: the database allocates every sequence under a
 * row lock, so the numbers are the commit order. That is what makes a second
 * transport safe at all -- and what makes the cursor, rather than the socket,
 * the right owner of the applied position.
 */
function channel(): ControlPlaneGroupChannel {
  return new ControlPlaneGroupChannel({
    // Publication is under test in its own case below; here the port answers
    // nothing because nothing asks it to.
    selectPort: () => ({}) as ControlPlanePort,
    groupId: 'group-1',
    deviceId: 'device-1',
  });
}

function event(sequence: bigint): GroupEventEnvelope {
  return {
    sequence,
    kind: 'document-delta',
    actorDeviceId: 'device-2',
    occurredAt: '2026-08-26T00:00:00.000Z',
  } as GroupEventEnvelope;
}

describe('ControlPlaneGroupChannel', () => {
  it('applies an event once however many transports carry it', () => {
    const subject = channel();
    const seen: bigint[] = [];
    subject.subscribe((delivered) => seen.push(delivered.sequence));

    // The socket pushes from the hub; a poller reads the same durable log and
    // carries the same events. Both hand them to the same seam.
    subject.deliver(event(1n));
    subject.deliver(event(2n));
    subject.deliver(event(1n));
    subject.deliver(event(2n));
    subject.deliver(event(3n));

    expect(seen).toEqual([1n, 2n, 3n]);
  });

  it('reports the applied position a transport resumes from', () => {
    const subject = channel();
    expect(subject.appliedSequence()).toBe(0n);

    subject.deliver(event(7n));
    expect(subject.appliedSequence()).toBe(7n);

    // An event already applied moves nothing, so a resume after it does not
    // ask the server to send the group backwards.
    subject.deliver(event(4n));
    expect(subject.appliedSequence()).toBe(7n);
  });

  it('follows the server back when the retained log no longer covers the resume point', () => {
    const subject = channel();
    const seen: bigint[] = [];
    subject.subscribe((delivered) => seen.push(delivered.sequence));
    subject.deliver(event(9n));

    // The server answers a pruned resume point with the oldest sequence it
    // still holds. Everything between is gone; refusing to rewind would leave
    // the group permanently behind.
    subject.rewindTo(3n);
    expect(subject.appliedSequence()).toBe(3n);

    subject.deliver(event(4n));
    expect(seen).toEqual([9n, 4n]);
  });

  it('refuses a negative rewind rather than trusting it', () => {
    const subject = channel();
    subject.deliver(event(5n));

    subject.rewindTo(-1n);

    expect(subject.appliedSequence()).toBe(0n);
  });

  it('stops delivering once closed', () => {
    const subject = channel();
    const seen: bigint[] = [];
    subject.subscribe((delivered) => seen.push(delivered.sequence));

    subject.close();
    subject.deliver(event(1n));

    expect(seen).toEqual([]);
  });
});

describe('one group, two planes to publish to', () => {
  /**
   * A port that records nothing but which plane it is, so the assertion is
   * about the address a publication left by rather than about a call count.
   */
  function plane(name: string, sent: string[]): ControlPlanePort {
    return {
      async publishDocumentDelta() {
        sent.push(name);
        return { sequence: 1n, stateVector: new Uint8Array(0) };
      },
      async publishSessionCommand() {
        sent.push(name);
        return {} as Awaited<ReturnType<ControlPlanePort['publishSessionCommand']>>;
      },
    } as unknown as ControlPlanePort;
  }

  it('publishes to the near plane while it carries, the cloud plane when it does not', async () => {
    const sent: string[] = [];
    const near = plane('near', sent);
    const cloud = plane('cloud', sent);
    let carrying = 'near';
    const subject = new ControlPlaneGroupChannel({
      selectPort: () => (carrying === 'near' ? near : cloud),
      groupId: 'group-1',
      deviceId: 'device-1',
    });
    const delta = {
      documentId: 'doc-1',
      documentType: 'settings' as const,
      delta: new Uint8Array(0),
    };

    await subject.publishDocumentDelta(delta);
    // The near plane's socket dropped. The mutation receipt in the shared
    // database makes the switch safe -- both planes stand in front of one
    // database -- so the failover is a choice rather than a risk.
    carrying = 'cloud';
    await subject.publishDocumentDelta(delta);
    await subject.publishSessionCommand({ action: 'play', target: 'wall-1' });
    // And back, the moment the near plane carries again.
    carrying = 'near';
    await subject.publishDocumentDelta(delta);

    expect(sent).toEqual(['near', 'cloud', 'cloud', 'near']);
  });

  it('asks for the plane per publication rather than remembering the first answer', async () => {
    const sent: string[] = [];
    let asked = 0;
    const near = plane('near', sent);
    const subject = new ControlPlaneGroupChannel({
      selectPort: () => {
        asked += 1;
        return near;
      },
      groupId: 'group-1',
      deviceId: 'device-1',
    });

    await subject.publishSessionCommand({ action: 'pause', target: 'wall-1' });
    await subject.publishSessionCommand({ action: 'play', target: 'wall-1' });

    // A channel that resolved the plane once at construction would answer 1
    // here, and would keep publishing to a plane that had gone away.
    expect(asked).toBe(2);
  });
});
