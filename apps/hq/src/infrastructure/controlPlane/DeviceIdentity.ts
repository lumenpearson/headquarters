import { browserStorage, type KeyValueStorage } from './DeviceSessionStore';

/**
 * The fifth persisted key. Listed in CLAUDE.md's state-ownership paragraph
 * and in `docs/release/environment.md` beside the others.
 */
export const deviceIdentityStorageKey = 'gremuchaya-hq:device-identity:v1';

/**
 * What a pairing call presents as `public_key`.
 *
 * The wire reserves `Device.public_key` as the device's identity anchor and
 * the control plane refuses an empty one (`durable-runtime.ts`,
 * `normalizeDeviceInput`), so a client that sends `''` cannot pair against
 * any control plane with durable auth configured -- which is every deployed
 * one. This port exists so the client asks "what is this device's key" at
 * the moment of pairing and owns nothing about where the answer rests.
 */
export interface DeviceIdentity {
  publicKey(): Promise<string>;
}

/**
 * The identity as it rests on disk. The JWK halves are absent for an
 * `opaque` identity, which has no key material to keep.
 */
interface StoredDeviceIdentity {
  readonly version: 1;
  readonly algorithm: 'ecdsa-p256' | 'opaque';
  /** What pairing sends: `<algorithm>:<base64url>`. */
  readonly wirePublicKey: string;
  readonly publicKeyJwk?: JsonWebKey;
  readonly privateKeyJwk?: JsonWebKey;
}

/**
 * A per-profile device identity keypair, generated once and kept.
 *
 * ECDSA P-256 because WebCrypto ships it everywhere this application runs
 * (WebView2, the browsers); Ed25519 is still uneven across webviews. The
 * private half is persisted beside the public one even though nothing signs
 * with it yet: a public key whose private half was thrown away is a label,
 * not an identity, and the day the control plane challenges devices, the
 * key that every paired device row already carries has to be provable. It
 * rests in `localStorage` in clear text on the same stated trade-off as the
 * refresh token in `DeviceSessionStore`, and it grants nothing by itself:
 * sessions come from pairing codes and bootstrap secrets, never from this
 * key.
 *
 * Where WebCrypto cannot generate a key (storage-blocked profiles land on
 * the memory store; older webviews may refuse the curve), the identity
 * degrades to 32 random bytes labelled `opaque:` -- still stable, still
 * non-empty, honestly named as not being a key.
 */
export class BrowserDeviceIdentity implements DeviceIdentity {
  readonly #storage: KeyValueStorage;
  #pending: Promise<string> | undefined;

  constructor(storage: KeyValueStorage = browserStorage()) {
    this.#storage = storage;
  }

  publicKey(): Promise<string> {
    // A rejection is not memoized: caching a failed generation would make one
    // transient storage or WebCrypto refusal permanent for the life of the
    // client, and pairing is exactly the call worth retrying.
    this.#pending ??= this.#load().catch((error: unknown) => {
      this.#pending = undefined;
      throw error;
    });
    return this.#pending;
  }

  async #load(): Promise<string> {
    const stored = this.#read();
    if (stored !== undefined) return stored.wirePublicKey;
    const generated = await generateIdentity();
    try {
      this.#storage.setItem(deviceIdentityStorageKey, JSON.stringify(generated));
    } catch {
      // A full or blocked store keeps the identity for this process only;
      // the next launch generates a fresh one, which the server reads as a
      // new device presenting itself -- true, if earlier than intended.
    }
    return generated.wirePublicKey;
  }

  #read(): StoredDeviceIdentity | undefined {
    try {
      // The read itself is inside the guard: a blocked-storage profile throws
      // on access, not only on the probe `browserStorage` catches -- the same
      // reason `DeviceSessionStore` wraps its own `getItem`.
      const raw = this.#storage.getItem(deviceIdentityStorageKey);
      if (raw === null) return undefined;
      const parsed: unknown = JSON.parse(raw);
      if (isStoredDeviceIdentity(parsed)) return parsed;
    } catch {
      // Damaged blobs and refused reads fall through to regeneration.
    }
    return undefined;
  }
}

function isStoredDeviceIdentity(value: unknown): value is StoredDeviceIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate['version'] === 1 &&
    (candidate['algorithm'] === 'ecdsa-p256' || candidate['algorithm'] === 'opaque') &&
    typeof candidate['wirePublicKey'] === 'string' &&
    candidate['wirePublicKey'].length > 0
  );
}

async function generateIdentity(): Promise<StoredDeviceIdentity> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle !== undefined) {
    try {
      const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
        'sign',
        'verify',
      ]);
      const spki = new Uint8Array(await subtle.exportKey('spki', pair.publicKey));
      const publicKeyJwk = await subtle.exportKey('jwk', pair.publicKey);
      const privateKeyJwk = await subtle.exportKey('jwk', pair.privateKey);
      return {
        version: 1,
        algorithm: 'ecdsa-p256',
        wirePublicKey: `ecdsa-p256:${base64Url(spki)}`,
        publicKeyJwk,
        privateKeyJwk,
      };
    } catch {
      // The curve is refused: degrade to the opaque identity below.
    }
  }
  const random = new Uint8Array(32);
  const withRandom = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto);
  if (withRandom === undefined) {
    // No WebCrypto and no randomness source at all -- a server render, never
    // a browser. An invented deterministic value would be an identity shared
    // by every such host, so this refuses instead.
    throw new Error('This host offers no randomness source for a device identity.');
  }
  withRandom(random);
  return { version: 1, algorithm: 'opaque', wirePublicKey: `opaque:${base64Url(random)}` };
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
