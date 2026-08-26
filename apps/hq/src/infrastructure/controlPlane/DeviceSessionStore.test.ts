import { describe, expect, it } from 'vitest';

import {
  DeviceSessionStore,
  deviceSessionStorageKey,
  legacyDeviceSessionStorageKeys,
  memoryStorage,
  type StoredDeviceSession,
} from './DeviceSessionStore';

const installationId = '3f1c2b7a-0d4e-4f6a-9c2b-8e1d5a7c9f30';

/*
 * Named literally rather than taken by position out of the exported list: a
 * test that destructured the list would follow it wherever it went, and the
 * claim here is about which keys are read and in what order.
 */
const legacyV2Key = 'gremuchaya-hq:device-session:v2';
const legacyV1Key = 'gremuchaya-hq:device-session:v1';

const session: StoredDeviceSession = {
  version: 3,
  pairedAtUrl: 'http://127.0.0.1:4100',
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
  it('reads the newer legacy key first, then the older one', () => {
    // Order decides which blob a device that has both is carried forward from,
    // and dropping a key from this list silently costs every device on it its
    // pairing.
    expect(legacyDeviceSessionStorageKeys).toEqual([legacyV2Key, legacyV1Key]);
  });

  it('reads back exactly what it wrote', () => {
    const store = new DeviceSessionStore(memoryStorage());
    store.write(session);

    expect(store.read()).toEqual(session);
  });

  it('answers with nothing, and forgets the key, for a blob that is not a session', () => {
    const storage = memoryStorage();
    storage.setItem(deviceSessionStorageKey, '{"version":3,"accessToken":42}');
    const store = new DeviceSessionStore(storage);

    expect(store.read()).toBeNull();
    // Removed rather than left to throw again on the next launch, the way the
    // operations key recovers itself.
    expect(storage.getItem(deviceSessionStorageKey)).toBeNull();
  });

  /*
   * A `v3` record that has the key's version but not its installation field was
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
    storage.setItem(legacyV1Key, JSON.stringify(legacySession));
    const store = new DeviceSessionStore(storage);

    const read = store.read();

    expect(read).toEqual({ ...session, controlPlaneInstallationId: '' });
    expect(storage.getItem(legacyV1Key)).toBeNull();
    expect(storage.getItem(deviceSessionStorageKey)).not.toBeNull();
  });

  /*
   * The upgrade this stage adds. A `v2` blob was only ever presented back to
   * the address it named; a `v3` one is presented to every address configured
   * for the group, because two planes may stand in front of one database. The
   * identity `v2` did record survives the carry -- it is what actually scopes a
   * session -- and the address it named is kept where nothing filters on it.
   */
  it('carries a v2 session forward, keeping the database it was minted against', () => {
    const storage = memoryStorage();
    const v2 = {
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
    storage.setItem(legacyV2Key, JSON.stringify(v2));
    const store = new DeviceSessionStore(storage);

    expect(store.read()).toEqual(session);
    // Once, and only once: the legacy key is gone and the next read takes the
    // current one without ever reaching the carry path again.
    expect(storage.getItem(legacyV2Key)).toBeNull();
    expect(JSON.parse(storage.getItem(deviceSessionStorageKey) ?? 'null')).toEqual(session);
    expect(store.read()).toEqual(session);
  });

  it('refuses a v2 blob whose installation field was removed', () => {
    const storage = memoryStorage();
    const { controlPlaneInstallationId: _dropped, pairedAtUrl, ...rest } = session;
    storage.setItem(
      legacyV2Key,
      JSON.stringify({ ...rest, version: 2, controlPlaneUrl: pairedAtUrl }),
    );

    // The `v2` key required the field exactly as `v3` does, so a blob without
    // it is damaged rather than old, and carrying it forward as "unknown" would
    // launder the damage into a session that merely cannot prove its database.
    expect(new DeviceSessionStore(storage).read()).toBeNull();
  });

  it('prefers the current key and never resurrects a legacy blob after clear', () => {
    const storage = memoryStorage();
    storage.setItem(legacyV1Key, JSON.stringify(legacySession));
    storage.setItem(legacyV2Key, JSON.stringify(legacySession));
    storage.setItem(deviceSessionStorageKey, JSON.stringify(session));
    const store = new DeviceSessionStore(storage);

    expect(store.read()).toEqual(session);

    store.clear();

    // Forgetting a pairing has to forget every key, or the next read would
    // hand the operator back the session they just gave up.
    expect(store.read()).toBeNull();
    expect(storage.getItem(legacyV1Key)).toBeNull();
    expect(storage.getItem(legacyV2Key)).toBeNull();
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
