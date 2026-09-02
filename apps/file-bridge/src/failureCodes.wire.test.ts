import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectError, createClient, type Client } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { createVirtualPath } from '@gremuchaya/domain';
import { BridgeFailure, BridgeFailureDetailSchema, FileBridgeService } from '@gremuchaya/protocol';
import type { BridgeConfig } from '@gremuchaya/config';
import { afterEach, describe, expect, it } from 'vitest';

import { startBridge } from './server.js';

/**
 * What a browser actually receives, over the only transport this project ships
 * (ADR 0003): binary gRPC-Web. A unit test on `toBridgeConnectError` proves the
 * classification; only this proves that the detail survives being packed into
 * `google.rpc.Status`, base64-encoded into the `grpc-status-details-bin`
 * trailer, and decoded on the other side.
 */
describe('file bridge failure codes over gRPC-Web', () => {
  let closeBridge: (() => Promise<void>) | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await closeBridge?.();
    if (root !== undefined) await rm(root, { recursive: true, force: true });
    closeBridge = undefined;
    root = undefined;
  });

  async function startFixture(): Promise<{ client: Client<typeof FileBridgeService> }> {
    root = await mkdtemp(join(tmpdir(), 'gremuchaya-failure-codes-'));
    await writeFile(join(root, 'brief.txt'), 'сводка', 'utf8');
    await symlink(tmpdir(), join(root, 'elsewhere'), 'dir');
    const config: BridgeConfig = {
      version: 1,
      transport: 'grpc-web',
      port: 0,
      readOnly: true,
      allowedOrigins: ['http://127.0.0.1:3000'],
      mounts: [
        { id: 'incoming', label: 'ВХОДЯЩИЕ', root, virtualPath: createVirtualPath('/ВХОДЯЩИЕ') },
      ],
      stableFile: { probeIntervalMs: 50, timeoutMs: 500 },
      watchDebounceMs: 25,
      materialImport: {
        enabled: false,
        maxFileBytes: 5 * 1024 * 1024 * 1024,
        chunkSizeBytes: 1024 * 1024,
      },
    };
    const running = await startBridge(config);
    closeBridge = running.close;
    const address = running.server.address() as AddressInfo;
    return {
      client: createClient(
        FileBridgeService,
        createGrpcWebTransport({
          baseUrl: `http://127.0.0.1:${address.port}`,
          useBinaryFormat: true,
        }),
      ),
    };
  }

  /*
   * A traversal is refused twice over. The domain's `createVirtualPath` refuses
   * the syntax before any root is consulted, which is the refusal an actual
   * probe reaches; `assertContained` is the second line and has its own code.
   * Either way the answer names a decision, never a location.
   */
  it.each([
    ['parent traversal', '/../../etc'],
    ['percent-encoded traversal', '/%2e%2e/secrets.txt'],
    ['backslash traversal', '/..\\secrets.txt'],
  ])('answers a %s refusal with a code that names no physical path', async (_label, requested) => {
    const { client } = await startFixture();
    const refusal = await capture(client.list({ mountId: 'incoming', path: requested }));

    expect(refusal.findDetails(BridgeFailureDetailSchema)[0]?.code).toBe(
      BridgeFailure.PATH_REJECTED,
    );
    assertHidesPhysicalPath(refusal, root);
  });

  it('answers a request that reaches into the bridge mirror with its own code', async () => {
    const { client } = await startFixture();
    const refusal = await capture(client.list({ mountId: 'incoming', path: '/.hq' }));

    expect(refusal.findDetails(BridgeFailureDetailSchema)[0]?.code).toBe(
      BridgeFailure.INTERNAL_PATH_HIDDEN,
    );
    assertHidesPhysicalPath(refusal, root);
  });

  it('answers a symlink refusal with its own code', async () => {
    const { client } = await startFixture();
    const refusal = await capture(client.list({ mountId: 'incoming', path: '/elsewhere' }));

    expect(refusal.findDetails(BridgeFailureDetailSchema)[0]?.code).toBe(
      BridgeFailure.SYMLINK_REFUSED,
    );
    assertHidesPhysicalPath(refusal, root);
  });

  /*
   * The sharpest of the four passthroughs. `stat` on a virtual path that does
   * not exist raises Node's ENOENT, whose message is `ENOENT: no such file or
   * directory, stat '<mount root>/absent.txt'`. That message used to be the
   * ConnectError's message, so the mount root of a shoot machine crossed to the
   * browser from the one server whose whole purpose is that it never does.
   */
  it('answers a missing entry with a code rather than with the absolute path it failed on', async () => {
    const { client } = await startFixture();
    const refusal = await capture(client.readFile({ mountId: 'incoming', path: '/absent.txt' }));

    expect(refusal.findDetails(BridgeFailureDetailSchema)[0]?.code).toBe(
      BridgeFailure.ENTRY_NOT_FOUND,
    );
    assertHidesPhysicalPath(refusal, root);
  });

  it('codes a refusal from a handler that has no try of its own', async () => {
    const { client } = await startFixture();
    // `RevokeMaterialPlaybackGrant` never wrapped its body. Its empty-field
    // refusal reached the browser as Connect's `unknown`; the router-wide
    // interceptor is what gives it a code.
    const refusal = await capture(client.revokeMaterialPlaybackGrant({ grantId: '' }));

    expect(refusal.findDetails(BridgeFailureDetailSchema)[0]?.code).toBe(
      BridgeFailure.MISSING_FIELD,
    );
  });

  it('answers an unknown mount without confirming which mounts exist', async () => {
    const { client } = await startFixture();
    const refusal = await capture(client.list({ mountId: 'нет-такого', path: '/' }));

    expect(refusal.findDetails(BridgeFailureDetailSchema)[0]?.code).toBe(
      BridgeFailure.MOUNT_UNKNOWN,
    );
    expect(refusal.rawMessage).not.toContain('нет-такого');
  });
});

/** Awaits a call that must fail, and hands back the refusal. */
async function capture(pending: Promise<unknown> | AsyncIterable<unknown>): Promise<ConnectError> {
  try {
    if (Symbol.asyncIterator in pending) {
      for await (const _ of pending) void _;
    } else {
      await pending;
    }
  } catch (error: unknown) {
    if (error instanceof ConnectError) return error;
    throw error;
  }
  throw new Error('Expected the call to be refused.');
}

/**
 * Nothing anywhere in the refusal may name the mount's location on disk --
 * neither the message the client renders nor any detail it decodes.
 */
function assertHidesPhysicalPath(error: ConnectError, physicalRoot: string | undefined): void {
  if (physicalRoot === undefined) throw new Error('Expected a fixture root.');
  const rendered = [
    error.message,
    error.rawMessage,
    ...error.findDetails(BridgeFailureDetailSchema).map((detail) => detail.developerMessage),
  ].join('\n');
  expect(rendered).not.toContain(physicalRoot);
  expect(rendered).not.toContain(tmpdir());
}
