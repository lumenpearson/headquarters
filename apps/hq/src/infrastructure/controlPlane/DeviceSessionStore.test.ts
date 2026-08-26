import { describe, expect, it } from 'vitest';

import { DeviceSessionStore, memoryStorage, type StoredDeviceSession } from './DeviceSessionStore';

const session: StoredDeviceSession = {
  version: 1,
  controlPlaneUrl: 'http://127.0.0.1:4100',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: 1_000,
  refreshTokenExpiresAt: 9_000,
  deviceId: 'device-a',
  groupId: 'group-a',
  role: 'EDITOR',
};

describe('DeviceSessionStore', () => {
  it('reads back exactly what it wrote', () => {
    const store = new DeviceSessionStore(memoryStorage());
    store.write(session);

    expect(store.read()).toEqual(session);
  });

  it('answers with nothing, and forgets the key, for a blob that is not a session', () => {
    const storage = memoryStorage();
    storage.setItem('gremuchaya-hq:device-session:v1', '{"version":1,"accessToken":42}');
    const store = new DeviceSessionStore(storage);

    expect(store.read()).toBeNull();
    // Removed rather than left to throw again on the next launch, the way the
    // operations key recovers itself.
    expect(storage.getItem('gremuchaya-hq:device-session:v1')).toBeNull();
  });

  it('keeps a pending refresh id until the refresh succeeds', () => {
    const store = new DeviceSessionStore(memoryStorage());
    store.write(session);
    let minted = 0;
    const mint = () => {
      minted += 1;
      return `request-${minted}`;
    };

    const first = store.beginRefresh(mint);
    // The attempt is written down *before* the call goes out, so a crash in
    // between leaves the next launch replaying the same identifier.
    expect(store.read()?.pendingRefreshRequestId).toBe('request-1');

    // A retry of an attempt that was never answered: the same id, because a
    // different one against the same refresh token is read by the server as a
    // replay and revokes the whole session family.
    const retry = store.beginRefresh(mint);
    expect(retry).toBe(first);
    expect(minted).toBe(1);

    store.completeRefresh({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: 2_000,
      refreshTokenExpiresAt: 10_000,
      role: 'EDITOR',
    });
    const rotated = store.read();
    expect(rotated?.accessToken).toBe('access-2');
    expect(rotated?.refreshToken).toBe('refresh-2');
    expect(rotated?.pendingRefreshRequestId).toBeUndefined();

    // The next refresh is a new attempt and gets a new receipt.
    expect(store.beginRefresh(mint)).toBe('request-2');
  });

  it('survives storage that refuses to answer', () => {
    const blocked = {
      getItem() {
        throw new Error('storage blocked');
      },
      setItem() {
        throw new Error('storage blocked');
      },
      removeItem() {
        throw new Error('storage blocked');
      },
    };
    const store = new DeviceSessionStore(blocked);

    // A profile that blocks storage costs the operator a pairing code on the
    // next launch; it must not take the application down on this one.
    expect(store.read()).toBeNull();
    expect(() => store.write(session)).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });
});
