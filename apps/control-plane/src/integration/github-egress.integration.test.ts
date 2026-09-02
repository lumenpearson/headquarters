import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-web';
import { ControlPlaneService, IntegrationService, SyncService } from '@gremuchaya/protocol';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadControlPlaneConfig, type ControlPlaneAuthConfig } from '../config.js';
import type { SqlClient } from '../db/database.js';
import { DisposableDatabasePool, liveTestDatabaseUrl } from '../db/liveDatabase.js';
import { runMigrations } from '../db/migrations.js';
import { startControlPlane } from '../server.js';

/**
 * The GitHub half of `IntegrationService`, end to end.
 *
 * The gateway suites prove what each outbound call sends; this one proves the
 * chain around them — that `HQ_CONTROL_PLANE_GITHUB_*` builds a gateway at the
 * composition root, that the router registers a service which can reach it,
 * that a client's `CreateIssue` over binary gRPC-Web arrives at GitHub with the
 * deployment credential, and that the job the mutation opened is recorded
 * `SUCCEEDED` in a live PostgreSQL with no credential anywhere in the row. A
 * service that works perfectly and is never wired looks identical from inside
 * the process.
 *
 * GitHub here is a real HTTP server on loopback, reached by the gateway's own
 * `fetch`. What no container can settle is github.com's own behaviour: that
 * needs a token this repository does not hold
 * (`docs/release/known-limitations.md`).
 */
const testDatabaseUrl = liveTestDatabaseUrl();
const describeIntegration = testDatabaseUrl === undefined ? describe.skip : describe;
const networkTimeoutMs = 120_000;
const bootstrapSecret = 'github-egress-bootstrap-secret-with-thirty-two-characters';
const tokenPepper = 'github-egress-token-pepper-with-thirty-two-characters';
const deploymentToken = 'ghp_egress_deployment_token_that_must_not_leak_0005';
const repository = 'gremuchaya/headquarters';

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly body: string;
}

describeIntegration('IntegrationService reaching GitHub over gRPC-Web', () => {
  const pool = new DisposableDatabasePool(testDatabaseUrl ?? '');
  let database: SqlClient;
  let github: Server;
  let githubPort = 0;
  let received: RecordedRequest[] = [];
  let closeControlPlane: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    database = await pool.create();
    await runMigrations(database);
    github = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        received.push({
          method: request.method ?? '',
          url: request.url ?? '',
          authorization: request.headers.authorization ?? '',
          body: Buffer.concat(chunks).toString('utf8'),
        });
        const path = (request.url ?? '').split('?')[0] ?? '';
        if (request.method === 'POST' && path === `/repos/${repository}/issues`) {
          response.statusCode = 201;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({ html_url: `https://github.com/${repository}/issues/3`, number: 3 }),
          );
          return;
        }
        if (request.method === 'GET' && path === `/repos/${repository}/pulls/3`) {
          response.statusCode = 200;
          response.setHeader('content-type', 'application/json');
          response.end(
            JSON.stringify({
              state: 'closed',
              merged: true,
              merged_at: '2026-08-28T10:00:00Z',
              html_url: `https://github.com/${repository}/pull/3`,
              updated_at: '2026-08-28T10:00:00Z',
            }),
          );
          return;
        }
        response.statusCode = 404;
        response.end(JSON.stringify({ message: 'Not Found' }));
      });
    });
    github.listen(0, '127.0.0.1');
    await once(github, 'listening');
    githubPort = (github.address() as AddressInfo).port;
  }, networkTimeoutMs);

  afterEach(async () => {
    await closeControlPlane?.();
    closeControlPlane = undefined;
    received = [];
  }, networkTimeoutMs);

  afterAll(async () => {
    github.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      github.close((error) => (error === undefined ? resolve() : reject(error))),
    );
    await pool.dropAll();
  }, networkTimeoutMs);

  it(
    'opens an issue with the configured credential and records the job that spent it',
    async () => {
      const { control, integration, headers, groupId } = await start(true);

      const capabilities = await control.getCapabilities({});
      expect(capabilities.capabilities).toContainEqual({
        $typeName: 'gremuchaya.control.v1.Capability',
        name: 'integration.github-egress',
        version: 'v1',
        enabled: true,
      });
      const health = await control.health({});
      // 1 is SERVING. A client choosing whether to offer "send" or only
      // "copy the prefilled link" reads exactly this.
      expect(health.dependencies.find((dependency) => dependency.name === 'github')).toMatchObject({
        status: 1,
      });

      const opened = await integration.createIssue(
        {
          draft: {
            repository: '',
            title: 'Карта пустая',
            bodyMarkdown: '## Problem\n\nblank',
            labels: ['hq'],
          },
          confirmed: true,
        },
        { headers },
      );

      expect(opened.url).toBe(`https://github.com/${repository}/issues/3`);
      expect(opened.issueNumber).toBe(3n);
      const sent = received[0];
      expect(sent?.method).toBe('POST');
      expect(sent?.url).toBe(`/repos/${repository}/issues`);
      expect(sent?.authorization).toBe(`Bearer ${deploymentToken}`);
      expect(JSON.parse(sent?.body ?? '{}')).toEqual({
        title: 'Карта пустая',
        body: '## Problem\n\nblank',
        labels: ['hq'],
      });

      // The job is the durable half: a retry reads it rather than opening a
      // second issue, so it has to hold the outcome and nothing else.
      const jobs = await database.query({
        text: 'SELECT kind, state, result::text AS result FROM integration_jobs WHERE group_id = $1',
        values: [groupId],
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]).toMatchObject({ kind: 'CREATE_ISSUE', state: 'SUCCEEDED' });
      expect(String(jobs[0]?.result)).toContain('/issues/3');
      // The credential is spent, never stored: it is a deployment secret in a
      // configuration closure, and `integration_jobs.result` is readable by
      // anyone who can read the group's jobs.
      expect(serialize(jobs)).not.toContain(deploymentToken);
      expect(serialize(opened)).not.toContain(deploymentToken);
    },
    networkTimeoutMs,
  );

  it(
    'reads a merged pull request back through the same wiring',
    async () => {
      const { integration, headers } = await start(true);

      const status = await integration.getPullRequestStatus(
        { repository: '', pullRequestNumber: 3n },
        { headers },
      );

      // 2 is MERGED. GitHub's own `state` for it is `closed`, which is the
      // reading a client must not be given.
      expect(status.state).toBe(2);
      expect(status.url).toBe(`https://github.com/${repository}/pull/3`);
      expect(received[0]?.authorization).toBe(`Bearer ${deploymentToken}`);
    },
    networkTimeoutMs,
  );

  it(
    'refuses by naming the configuration where the deployment holds no token',
    async () => {
      const { control, integration, headers, groupId } = await start(false);

      const capabilities = await control.getCapabilities({});
      expect(capabilities.capabilities).toContainEqual({
        $typeName: 'gremuchaya.control.v1.Capability',
        name: 'integration.github-egress',
        version: 'v1',
        enabled: false,
      });

      const failure = await integration
        .createIssue(
          {
            draft: { repository: '', title: 'Report', bodyMarkdown: 'x', labels: [] },
            confirmed: true,
          },
          { headers },
        )
        .catch((error: unknown) => error);

      expect(String(failure)).toContain('HQ_CONTROL_PLANE_GITHUB_TOKEN');
      expect(String(failure)).toContain('HQ_CONTROL_PLANE_GITHUB_REPOSITORY');
      // Nothing was sent: the refusal is a precondition, not a failed call.
      expect(received).toEqual([]);
      // Not even a QUEUED row: the gateway is required before the job is
      // enqueued, so a deployment that cannot send leaves no work behind.
      const jobs = await database.query({
        text: 'SELECT id FROM integration_jobs WHERE group_id = $1',
        values: [groupId],
      });
      expect(jobs).toEqual([]);
    },
    networkTimeoutMs,
  );

  /**
   * One control plane, with or without the GitHub group, against the same live
   * database and the same GitHub on loopback.
   */
  async function start(withGitHub: boolean) {
    const githubConfig = loadControlPlaneConfig({
      HQ_CONTROL_PLANE_GITHUB_TOKEN: deploymentToken,
      HQ_CONTROL_PLANE_GITHUB_REPOSITORY: repository,
      HQ_CONTROL_PLANE_GITHUB_API_BASE_URL: `http://127.0.0.1:${githubPort.toString()}`,
    }).github;
    if (githubConfig === undefined) throw new Error('GitHub configuration expected');

    const running = await startControlPlane(
      {
        port: 0,
        host: '127.0.0.1',
        allowedOrigins: ['http://127.0.0.1:3000'],
        databaseUrl: testDatabaseUrl ?? '',
        auth: authConfig(),
        ...(withGitHub ? { github: githubConfig } : {}),
      },
      { pairedDeviceLifecycle: { database } },
    );
    closeControlPlane = running.close;
    const address = running.server.address() as AddressInfo;
    const transport = createGrpcWebTransport({
      baseUrl: `http://127.0.0.1:${address.port}`,
      useBinaryFormat: true,
    });
    const sync = createClient(SyncService, transport);
    const created = await sync.createGroup(
      {
        name: 'Штаб',
        initialDevice: {
          name: 'Primary workstation',
          publicKey: `ed25519:github-egress-${Date.now().toString()}`,
          platform: 'windows',
          applicationVersion: '0.1.0',
        },
      },
      { headers: { 'x-hq-bootstrap-secret': bootstrapSecret } },
    );
    const accessToken = created.session?.accessToken ?? '';
    if (accessToken.length === 0) throw new Error('access token expected');
    const groupId = created.group?.id?.value ?? '';
    if (groupId.length === 0) throw new Error('group id expected');
    return {
      control: createClient(ControlPlaneService, transport),
      integration: createClient(IntegrationService, transport),
      headers: { authorization: `Bearer ${accessToken}` },
      groupId,
    };
  }
});

/** Protobuf numbers arrive as `bigint`, which `JSON.stringify` refuses. */
function serialize(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === 'bigint' ? entry.toString() : entry,
  );
}

function authConfig(): ControlPlaneAuthConfig {
  return {
    tokenHashVersion: 'v1',
    accessTokenLifetimeMs: 900_000,
    refreshTokenLifetimeMs: 2_592_000_000,
    pairingCodeLifetimeMs: 600_000,
    hashCredential: (kind, credential) =>
      createHmac('sha256', tokenPepper).update(`v1 ${kind} ${credential}`).digest('base64url'),
    verifyBootstrapSecret: (candidate) => candidate === bootstrapSecret,
  };
}
