import { describe, expect, it, vi } from 'vitest';

import { memoryStorage } from '@/infrastructure/controlPlane/DeviceSessionStore';

import {
  clearManualControlPlaneAddress,
  manualControlPlaneAddressStorageKey,
  readManualControlPlaneAddress,
  subscribeManualControlPlaneAddress,
  writeManualControlPlaneAddress,
} from './manualControlPlaneAddress';

const nearPlane = 'http://192.168.10.5:4100';
const cloudPlane = 'https://plane.example';

describe('readManualControlPlaneAddress', () => {
  it('answers no addresses on a fresh profile', () => {
    expect(readManualControlPlaneAddress(memoryStorage())).toEqual([]);
  });

  it('reads back what was saved', () => {
    const storage = memoryStorage();
    writeManualControlPlaneAddress(nearPlane, storage);

    expect(readManualControlPlaneAddress(storage)).toEqual([nearPlane]);
  });

  it('reads a hand-edited or truncated blob as no address, the way a damaged session is read as none', () => {
    const storage = memoryStorage();
    storage.setItem(manualControlPlaneAddressStorageKey, '{"not"');

    expect(readManualControlPlaneAddress(storage)).toEqual([]);
  });

  it('reads a value the schema refuses as no address', () => {
    const storage = memoryStorage();
    // A hand-edited blob naming a credential in the URL, which the schema
    // this module shares with `controlPlaneUrl` refuses.
    storage.setItem(
      manualControlPlaneAddressStorageKey,
      JSON.stringify(['http://user:pass@192.168.10.5:4100']),
    );

    expect(readManualControlPlaneAddress(storage)).toEqual([]);
  });

  it('survives storage that throws on every call', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };

    expect(readManualControlPlaneAddress(throwing)).toEqual([]);
  });
});

describe('writeManualControlPlaneAddress', () => {
  it('accepts one address', () => {
    const storage = memoryStorage();

    const outcome = writeManualControlPlaneAddress(nearPlane, storage);

    expect(outcome).toEqual({ ok: true, addresses: [nearPlane] });
    expect(readManualControlPlaneAddress(storage)).toEqual([nearPlane]);
  });

  it('splits a comma list into an ordered set, near plane first', () => {
    const storage = memoryStorage();

    const outcome = writeManualControlPlaneAddress(`${nearPlane}, ${cloudPlane}`, storage);

    expect(outcome).toEqual({ ok: true, addresses: [nearPlane, cloudPlane] });
  });

  it('refuses an empty field rather than treating it as a clear', () => {
    const storage = memoryStorage();
    writeManualControlPlaneAddress(nearPlane, storage);

    const outcome = writeManualControlPlaneAddress('   ', storage);

    expect(outcome.ok).toBe(false);
    // Refused, and the earlier save is untouched -- a refused write is not a
    // silent clear.
    expect(readManualControlPlaneAddress(storage)).toEqual([nearPlane]);
  });

  it('refuses a URL carrying credentials', () => {
    const outcome = writeManualControlPlaneAddress(
      'http://user:pass@192.168.10.5:4100',
      memoryStorage(),
    );

    expect(outcome.ok).toBe(false);
  });

  it('refuses a non-http(s) URL', () => {
    const outcome = writeManualControlPlaneAddress('ftp://192.168.10.5:4100', memoryStorage());

    expect(outcome.ok).toBe(false);
  });

  it('refuses more than four addresses', () => {
    const outcome = writeManualControlPlaneAddress(
      'http://a.example,http://b.example,http://c.example,http://d.example,http://e.example',
      memoryStorage(),
    );

    expect(outcome.ok).toBe(false);
  });

  it('refuses a repeated address, which is what its own refusal text promises', () => {
    // The field deduplicated the list before `controlPlaneUrl` saw it, so the
    // schema's "must not repeat an address" rule was unreachable from here and
    // the refusal below ended `БЕЗ ПОВТОРОВ` on the strength of nothing.
    const outcome = writeManualControlPlaneAddress(`${nearPlane}, ${nearPlane}`, memoryStorage());

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain('БЕЗ ПОВТОРОВ');
  });

  it('refuses the path Git Bash makes of a leading-slash address', () => {
    // The build variable is where this value comes from in practice; the field
    // has to refuse it too, or the two sources disagree about what an address
    // is.
    const outcome = writeManualControlPlaneAddress('C:/Program Files/Git/api', memoryStorage());

    expect(outcome.ok).toBe(false);
  });

  it('refuses a value with no scheme at all rather than throwing', () => {
    // `controlPlaneAddressSchema`'s own refine step calls `new URL(value)`,
    // which throws for a string with no scheme -- exactly what an operator
    // typing an address without `http://` produces.
    const outcome = writeManualControlPlaneAddress('192.168.10.5:4100', memoryStorage());

    expect(outcome.ok).toBe(false);
  });

  it('notifies a subscriber', () => {
    const storage = memoryStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeManualControlPlaneAddress(listener);

    writeManualControlPlaneAddress(nearPlane, storage);

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

describe('clearManualControlPlaneAddress', () => {
  it('forgets a saved address', () => {
    const storage = memoryStorage();
    writeManualControlPlaneAddress(nearPlane, storage);

    clearManualControlPlaneAddress(storage);

    expect(readManualControlPlaneAddress(storage)).toEqual([]);
  });

  it('notifies a subscriber even when there was nothing to clear', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeManualControlPlaneAddress(listener);

    clearManualControlPlaneAddress(memoryStorage());

    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it('stops notifying once unsubscribed', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeManualControlPlaneAddress(listener);
    unsubscribe();

    writeManualControlPlaneAddress(nearPlane, memoryStorage());

    expect(listener).not.toHaveBeenCalled();
  });
});
