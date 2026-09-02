import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { translateWith } from '@/application/localization/messages';
import { memoryStorage } from '@/infrastructure/controlPlane/DeviceSessionStore';

import { resolveControlPlaneAddresses } from './controlPlaneAddressResolution';
import { writeManualControlPlaneAddress } from './manualControlPlaneAddress';

/*
 * Not a shoot machine's address: a documentation host and a loopback port.
 */
const cloudPlane = 'https://plane.example';
const nearPlane = 'http://127.0.0.1:4100';

/**
 * What Git Bash makes of the runbook's `NEXT_PUBLIC_HQ_CONTROL_PLANE_URL=/api`.
 *
 * MSYS2 rewrites an argument that starts with a slash into a path under its own
 * installation root, so the value baked into the static export is a Windows
 * path. This is the exact string the operator's screen showed as the primary
 * control-plane address.
 */
const msysRewritten = 'C:/Program Files/Git/api';

/** Every URL the resolver asked for, in order. */
let requested: string[];

function stubRuntimeFilesMissing(): void {
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      requested.push(String(input));
      // Both runtime documents absent: the route ships without them, which is
      // the case that leaves the build variable as the only source of an
      // address.
      return Promise.resolve(new Response('', { status: 404 }));
    }),
  );
}

async function resolveWith(variable: string | undefined) {
  if (variable === undefined) delete process.env.NEXT_PUBLIC_HQ_CONTROL_PLANE_URL;
  else process.env.NEXT_PUBLIC_HQ_CONTROL_PLANE_URL = variable;
  return resolveControlPlaneAddresses(new AbortController().signal);
}

/** The line the operator reads for one refusal, composed as the runtime does. */
function refusalLine(reasonId: Parameters<typeof translateWith>[1], address: string): string {
  const reason = translateWith('ru', reasonId, { address, limit: 4 });
  return translateWith('ru', 'connection.address.buildVariableRefused', { reason });
}

beforeEach(() => {
  stubRuntimeFilesMissing();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NEXT_PUBLIC_HQ_CONTROL_PLANE_URL;
});

describe('the address a build variable names', () => {
  it('accepts the addresses the schema accepts, in the order they were written', async () => {
    const resolved = await resolveWith(`${nearPlane}, ${cloudPlane}`);

    expect(resolved).toEqual({
      addresses: [nearPlane, cloudPlane],
      source: 'build-variable',
      overrideFailure: '',
    });
  });

  it('refuses the MSYS-rewritten path by name and says what to do about it', async () => {
    const resolved = await resolveWith(msysRewritten);

    expect(resolved.addresses).toEqual([]);
    expect(resolved.overrideFailure).toBe(
      refusalLine('connection.address.refusal.msysPath', msysRewritten),
    );
    // The two facts an operator needs and `NetworkError` never carried: which
    // configuration was refused, and what rewrote it.
    expect(resolved.overrideFailure).toContain('NEXT_PUBLIC_HQ_CONTROL_PLANE_URL');
    expect(resolved.overrideFailure).toContain('GIT BASH');
    expect(resolved.overrideFailure).toContain(msysRewritten);
  });

  it('refuses a scheme it has no transport for', async () => {
    const resolved = await resolveWith('ftp://192.168.10.5:4100');

    expect(resolved.addresses).toEqual([]);
    expect(resolved.overrideFailure).toBe(
      refusalLine('connection.address.refusal.notHttp', 'ftp://192.168.10.5:4100'),
    );
  });

  it('refuses an address carrying credentials without printing them back', async () => {
    const resolved = await resolveWith('http://operator:secret@192.168.10.5:4100');

    expect(resolved.addresses).toEqual([]);
    // The origin, so the operator learns which address was refused; never the
    // entry, because a password drawn on a status line is a password in the
    // next photograph of that screen.
    expect(resolved.overrideFailure).toBe(
      refusalLine('connection.address.refusal.credentials', 'http://192.168.10.5:4100'),
    );
    expect(resolved.overrideFailure).not.toContain('secret');
    expect(resolved.overrideFailure).not.toContain('operator');
  });

  it('refuses more addresses than the schema will build clients for', async () => {
    const resolved = await resolveWith(
      'http://a.example,http://b.example,http://c.example,http://d.example,http://e.example',
    );

    expect(resolved.addresses).toEqual([]);
    expect(resolved.overrideFailure).toBe(refusalLine('connection.address.refusal.tooMany', ''));
  });

  it('refuses a repeated address rather than quietly building one client', async () => {
    const resolved = await resolveWith(`${cloudPlane},${cloudPlane}`);

    expect(resolved.addresses).toEqual([]);
    expect(resolved.overrideFailure).toBe(
      refusalLine('connection.address.refusal.repeated', cloudPlane),
    );
  });

  it('refuses a value with no scheme at all rather than throwing', async () => {
    const resolved = await resolveWith('192.168.10.5:4100');

    expect(resolved.addresses).toEqual([]);
    expect(resolved.overrideFailure).toBe(
      refusalLine('connection.address.refusal.notAUrl', '192.168.10.5:4100'),
    );
  });

  it('still reports the build variable as the source of a refused address', async () => {
    // "Not configured" would send the operator looking for a setting that is
    // set and wrong.
    const resolved = await resolveWith(msysRewritten);

    expect(resolved.source).toBe('build-variable');
  });

  it('treats an unset or blank variable as no address rather than as a refusal', async () => {
    expect(await resolveWith(undefined)).toEqual({
      addresses: [],
      source: 'none',
      overrideFailure: '',
    });
    // A trailing comma in a deployment variable is a typo, not an instruction.
    expect(await resolveWith(' , ')).toEqual({
      addresses: [],
      source: 'none',
      overrideFailure: '',
    });
  });
});

describe('what happens before a request is attempted', () => {
  it('sends nothing to a refused address and hands the runtime none to send to', async () => {
    const resolved = await resolveWith(msysRewritten);

    // Resolution runs before any client exists, so the address never leaving
    // this function is the whole guarantee: `ControlPlaneRuntime` builds one
    // client per address it is handed, and it is handed none.
    expect(resolved.addresses).toEqual([]);

    // The two runtime documents are the only reads resolution performs -- the
    // override twice, because the resolver's own check of `controlPlaneUrl` and
    // the configuration loader read it in parallel on purpose. The refused
    // address is never contacted, which is the difference between an operator
    // reading why the configuration is wrong and an operator reading the
    // browser's account of a request that never left.
    expect([...new Set(requested)].sort()).toEqual([
      '/runtime/project.default.json',
      '/runtime/project.override.json',
    ]);
    expect(requested.some((url) => url.includes('Git'))).toBe(false);
  });
});

describe('one rule, three sources', () => {
  const refusedByTheField = [
    msysRewritten,
    'ftp://192.168.10.5:4100',
    'http://operator:secret@192.168.10.5:4100',
    'http://a.example,http://b.example,http://c.example,http://d.example,http://e.example',
    `${cloudPlane},${cloudPlane}`,
    '192.168.10.5:4100',
  ];

  it.each(refusedByTheField)('refuses %s from the build variable too', async (raw) => {
    // The defect this closes: a value the in-app field rejects by name passed
    // through the build variable intact, became the primary link and reached
    // `fetch`.
    expect(writeManualControlPlaneAddress(raw, memoryStorage()).ok).toBe(false);

    const resolved = await resolveWith(raw);

    expect(resolved.addresses).toEqual([]);
    expect(resolved.overrideFailure).not.toBe('');
  });
});
