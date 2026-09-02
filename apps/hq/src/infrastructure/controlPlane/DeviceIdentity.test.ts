import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserDeviceIdentity, deviceIdentityStorageKey } from './DeviceIdentity';
import { memoryStorage } from './DeviceSessionStore';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BrowserDeviceIdentity', () => {
  it('generates a labelled ECDSA P-256 key once and answers with it from then on', async () => {
    const storage = memoryStorage();
    const identity = new BrowserDeviceIdentity(storage);

    const first = await identity.publicKey();

    // The label is the wire contract: the server stores the string whole, so
    // the algorithm has to be readable off the value itself.
    expect(first).toMatch(/^ecdsa-p256:[A-Za-z0-9_-]+$/u);
    // The same instance and a fresh one over the same storage answer the
    // same, which is what makes this an identity rather than a value.
    expect(await identity.publicKey()).toBe(first);
    expect(await new BrowserDeviceIdentity(storage).publicKey()).toBe(first);
  });

  it('keeps the private half beside the public one for the day pairing is challenged', async () => {
    const storage = memoryStorage();
    await new BrowserDeviceIdentity(storage).publicKey();

    const stored: unknown = JSON.parse(storage.getItem(deviceIdentityStorageKey) ?? 'null');

    expect(stored).toMatchObject({
      version: 1,
      algorithm: 'ecdsa-p256',
      privateKeyJwk: { kty: 'EC', crv: 'P-256' },
    });
  });

  it('replaces a damaged blob instead of presenting it', async () => {
    const storage = memoryStorage();
    storage.setItem(deviceIdentityStorageKey, '{"version":1,"wirePublicKey":""}');

    const regenerated = await new BrowserDeviceIdentity(storage).publicKey();

    expect(regenerated).toMatch(/^ecdsa-p256:[A-Za-z0-9_-]+$/u);
    expect(await new BrowserDeviceIdentity(storage).publicKey()).toBe(regenerated);
  });

  it('gives two profiles two identities', async () => {
    const first = await new BrowserDeviceIdentity(memoryStorage()).publicKey();
    const second = await new BrowserDeviceIdentity(memoryStorage()).publicKey();

    expect(first).not.toBe(second);
  });

  it('degrades to a stable opaque identity where the curve is refused', async () => {
    // A host with randomness but no usable WebCrypto -- the docblock's older
    // webview. `subtle` present but refusing would land here too; absent is
    // the simplest honest stand-in.
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(7) });
    const storage = memoryStorage();

    const generated = await new BrowserDeviceIdentity(storage).publicKey();

    expect(generated).toMatch(/^opaque:[A-Za-z0-9_-]+$/u);
    // Still an identity: the persisted copy answers the next instance.
    expect(await new BrowserDeviceIdentity(storage).publicKey()).toBe(generated);
  });

  it('still answers when the store refuses the write, at the cost of stability', async () => {
    const storage = memoryStorage();
    const refusing = {
      getItem: (key: string) => storage.getItem(key),
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: (key: string) => storage.removeItem(key),
    };

    const first = new BrowserDeviceIdentity(refusing);
    const key = await first.publicKey();

    expect(key).toMatch(/^ecdsa-p256:[A-Za-z0-9_-]+$/u);
    // The same instance keeps its answer for the session...
    expect(await first.publicKey()).toBe(key);
    // ...and a fresh launch over the same refused store presents itself as a
    // new device -- the documented cost, not a crash.
    expect(await new BrowserDeviceIdentity(refusing).publicKey()).not.toBe(key);
  });
});
