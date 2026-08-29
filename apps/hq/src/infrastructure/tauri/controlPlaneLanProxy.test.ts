// @vitest-environment jsdom
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { controlPlaneFetch, requiresControlPlaneProxy } from './controlPlaneLanProxy';

interface RecordedCall {
  readonly command: string;
  readonly args: unknown;
}

function mockNativeShell(handler: (command: string, args: unknown) => unknown): RecordedCall[] {
  const calls: RecordedCall[] = [];
  Object.assign(globalThis, { isTauri: true });
  mockIPC((command, args) => {
    calls.push({ command, args });
    return handler(command, args);
  });
  return calls;
}

afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, 'isTauri');
});

describe('requiresControlPlaneProxy', () => {
  it('answers false for the loopback addresses the CSP already admits', () => {
    expect(requiresControlPlaneProxy('http://127.0.0.1:4100')).toBe(false);
    expect(requiresControlPlaneProxy('http://localhost:4100')).toBe(false);
  });

  it('answers false for the deployed control plane, which the CSP already names', () => {
    expect(requiresControlPlaneProxy('https://staging.vercel.app')).toBe(false);
  });

  it('answers true for a literal address in each private-use range', () => {
    expect(requiresControlPlaneProxy('http://192.168.10.5:4100')).toBe(true);
    expect(requiresControlPlaneProxy('http://10.0.0.7:4100')).toBe(true);
    expect(requiresControlPlaneProxy('http://172.16.0.1:4100')).toBe(true);
    expect(requiresControlPlaneProxy('http://172.31.255.255:4100')).toBe(true);
    expect(requiresControlPlaneProxy('http://169.254.1.1:4100')).toBe(true);
  });

  it('answers false just outside the 172.16.0.0/12 range', () => {
    expect(requiresControlPlaneProxy('http://172.15.255.255:4100')).toBe(false);
    expect(requiresControlPlaneProxy('http://172.32.0.0:4100')).toBe(false);
  });

  it('answers false for a public address -- CSP already refuses it and this adapter does not help', () => {
    expect(requiresControlPlaneProxy('http://8.8.8.8:4100')).toBe(false);
  });

  it('answers false for anything the Rust command would refuse anyway: https and a hostname', () => {
    expect(requiresControlPlaneProxy('https://192.168.10.5:4100')).toBe(false);
    expect(requiresControlPlaneProxy('http://control-plane.local:4100')).toBe(false);
  });
});

describe('controlPlaneFetch outside Tauri', () => {
  it('calls the real fetch and never touches the native shell', async () => {
    const calls = mockNativeShell(() => null);
    const webFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', webFetch);
    Reflect.deleteProperty(globalThis, 'isTauri');

    const response = await controlPlaneFetch('http://192.168.10.5:4100/rpc');

    expect(await response.text()).toBe('ok');
    expect(webFetch).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
  });
});

describe('controlPlaneFetch inside Tauri, at an address the CSP already admits', () => {
  it('calls the real fetch rather than the proxy command', async () => {
    const calls = mockNativeShell(() => null);
    const webFetch = vi.fn(async () => new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', webFetch);

    const response = await controlPlaneFetch('http://127.0.0.1:4100/rpc');

    expect(await response.text()).toBe('ok');
    expect(webFetch).toHaveBeenCalledOnce();
    expect(calls).toEqual([]);
  });
});

describe('controlPlaneFetch inside Tauri, at a LAN address the CSP cannot admit', () => {
  it('routes a GET health probe through the native proxy command with no body', async () => {
    const calls = mockNativeShell((command) =>
      command === 'control_plane_http_request'
        ? { status: 200, headers: [['content-type', 'application/json']], body: [123, 125] }
        : undefined,
    );
    const webFetch = vi.fn();
    vi.stubGlobal('fetch', webFetch);

    const response = await controlPlaneFetch('http://192.168.10.5:4100/health', {
      method: 'GET',
    });

    expect(webFetch).not.toHaveBeenCalled();
    expect(calls).toEqual([
      {
        command: 'control_plane_http_request',
        args: {
          request: {
            method: 'GET',
            url: 'http://192.168.10.5:4100/health',
            headers: [],
            body: null,
          },
        },
      },
    ]);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([123, 125]));
  });

  it('carries a POST body and a header through the proxy command', async () => {
    const calls = mockNativeShell((command) =>
      command === 'control_plane_http_request'
        ? { status: 200, headers: [], body: [9, 9, 9] }
        : undefined,
    );

    await controlPlaneFetch(
      'http://192.168.10.5:4100/gremuchaya.control.v1.ControlPlaneService/Pair',
      {
        method: 'POST',
        headers: { 'content-type': 'application/connect+proto' },
        body: Uint8Array.from([1, 2, 3]),
      },
    );

    expect(calls).toEqual([
      {
        command: 'control_plane_http_request',
        args: {
          request: {
            method: 'POST',
            url: 'http://192.168.10.5:4100/gremuchaya.control.v1.ControlPlaneService/Pair',
            headers: [['content-type', 'application/connect+proto']],
            body: [1, 2, 3],
          },
        },
      },
    ]);
  });

  it('rejects immediately, without calling the native shell, when the signal is already aborted', async () => {
    const calls = mockNativeShell(() => ({ status: 200, headers: [], body: [] }));
    const controller = new AbortController();
    controller.abort();

    await expect(
      controlPlaneFetch('http://192.168.10.5:4100/health', { signal: controller.signal }),
    ).rejects.toThrow(/aborted/u);
    expect(calls).toEqual([]);
  });
});
