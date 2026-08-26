import { describe, expect, it } from 'vitest';

import {
  DeviceSessionStore,
  deviceSessionStorageKey,
  legacyDeviceSessionStorageKey,
  memoryStorage,
  type StoredDeviceSession,
} from './DeviceSessionStore';

const installationId = '3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30';

const session: StoredDeviceSession = {
  version: 2,
  controlPlaneUrl: 'http://127.0.0.1:4100',
  controlPlaneInstallationId: installationId,
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessTokenExpiresAt: 1_000,
  refreshTokenExpiresAt: 9_000,
  deviceId: 'device-a',
  groupId: 'group-a',
  role: 'EDITOR',
};

/** A session as the `v1` key held it, with no installation identity at all. */
const legacySession = {
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
    storage.setItem(deviceSessionStorageKey, '{"version":2,"accessToken":42}');
    const store = new DeviceSessionStore(storage);

    expect(store.read()).toBeNull();
    // Removed rather than left to throw again on the next launch, the way the
    // operations key recovers itself.
    expect(storage.getItem(deviceSessionStorageKey)).toBeNull();
  });

  /*
   * A `v2` record that has the key's version but not its installation field was
   * hand-edited or truncated. Defaulting it to `''` would turn a damaged record
   * into a session that merely "cannot prove where it came from" and would then
   * be handed the next control plane's identity as if it had always been there.
   */
  it('refuses a current-version blob that carries no installation field', () => {
    const storage = memoryStorage();
    const { controlPlaneInstallationId: _dropped, ...withoutField } = session;
    storage.setItem(deviceSessionStorageKey, JSON.stringify(withoutField));

    expect(new DeviceSessionStore(storage).read()).toBeNull();
  });

  /*
   * The upgrade path. A device paired before this client recorded which
   * database it was talking to keeps its pairing -- nine screens asking for
   * fresh codes on a shoot day is a worse outcome than the one being prevented
   * -- but it does not acquire a claim it never had: the identity is empty,
   * which the connection reads as unknown rather than as a match.
   */
  it('carries a v1 session forward with an unknown installation', () => {
    const storage = memoryStorage();
    storage.setItem(legacyDeviceSessionStorageKey, JSON.stringify(legacySession));
    const store = new DeviceSessionStore(storage);

    const read = store.read();

    expect(read).toEqual({ ...session, controlPlaneInstallationId: '' });
    expect(storage.getItem(legacyDeviceSessionStorageKey)).toBeNull();
    expect(storage.getItem(deviceSessionStorageKey)).not.toBeNull();
  });

  it('prefers the current key and never resurrects a legacy blob after clear', () => {
    const storage = memoryStorage();
    storage.setItem(legacyDeviceSessionStorageKey, JSON.stringify(legacySession));
    storage.setItem(deviceSessionStorageKey, JSON.stringify(session));
    const store = new DeviceSessionStore(storage);

    expect(store.read()).toEqual(session);

    store.clear();

    // Forgetting a pairing has to forget both keys, or the next read would
    // hand the operator back the session they just gave up.
    expect(store.read()).toBeNull();
    expect(storage.getItem(legacyDeviceSessionStorageKey)).toBeNull();
  });

  it('records an unknown installation once and never replaces a recorded one', () => {
    const store = new DeviceSessionStore(memoryStorage());
    store.write({ ...session, controlPlaneInstallationId: '' });

    store.adoptInstallationId(installationId);
    expect(store.read()?.controlPlaneInstallationId).toBe(installationId);

    /*
     * Two different non-empty identities are exactly the disagreement the
     * connection refuses on. A store that adopted the newer one would erase the
     * evidence before the operator could see it.
     */
    store.adoptInstallationId('9a2c4b60-6f1e-4f6f-9c93-5d0f2b7a41d8');
    expect(store.read()?.controlPlaneInstallationId).toBe(installationId);
  });

  it('records nothing when the control plane reported no installation', () => {
    const store = new DeviceSessionStore(memoryStorage());
    store.write({ ...session, controlPlaneInstallationId: '' });

    store.adoptInstallationId('');

    expect(store.read()?.controlPlaneInstallationId).toBe('');
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
