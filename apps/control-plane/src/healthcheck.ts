import { isIP } from 'node:net';

import { ConnectError, createClient } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-node';
import { ControlPlaneService, controlV1 } from '@gremuchaya/protocol';

import { isEntrypoint } from './entrypoint.js';

/**
 * The liveness probe, as one module used by two callers: the image's own
 * `HEALTHCHECK` and the container smoke step in `.github/workflows/container.yml`.
 *
 * It speaks the only transport this service has -- binary gRPC-Web over the
 * same `ControlPlaneService` a client would call (ADR 0003, ADR 0008). A probe
 * written against a plain HTTP path would have to invent one, and an invented
 * path is a second contract that can pass while the real one is broken.
 *
 * `Health` alone is not a sufficient probe for this service. `Health` answers
 * `SERVING` in health-only startup too, where `SyncService` was never
 * registered: a container whose database credentials are wrong, or whose auth
 * secrets are missing, starts, serves, reports `SERVING`, and can pair no
 * device at all. `--require-capability` is what turns that silent reduction
 * into a failed probe, and `--refuse-capability` states the opposite
 * expectation -- that a deployment meant to stay health-only has not quietly
 * acquired a durable surface.
 */

/** The transport-level deadline for the probe's one or two round trips. */
const defaultTimeoutMs = 5_000;
const defaultPort = 4100;
const defaultProbeHost = '127.0.0.1';

export interface HealthcheckOptions {
  /** Origin of the plane to probe, e.g. `http://127.0.0.1:4100`. */
  readonly baseUrl: string;
  /** Capability names that must be reported present and enabled. */
  readonly requiredCapabilities: readonly string[];
  /** Capability names that must be reported absent or disabled. */
  readonly refusedCapabilities: readonly string[];
  /**
   * `Health` dependency names that must themselves be `SERVING`.
   *
   * The service's own status is `SERVING` whether or not a dependency is
   * configured -- deliberately, because a control plane with no Redis is
   * serving correctly. A deployment that configured one says so here.
   */
  readonly requiredDependencies: readonly string[];
  readonly timeoutMs: number;
}

export interface HealthcheckOutcome {
  /**
   * `0` healthy, `1` not. Only these two: Docker reserves exit code 2 for
   * itself and documents that a `HEALTHCHECK` must not produce it, so an
   * argument error is raised before the probe rather than encoded as a third
   * code the orchestrator would misread.
   */
  readonly exitCode: 0 | 1;
  /** One line, safe to print. It carries no credential because it reads none. */
  readonly report: string;
}

/**
 * Probes `options.baseUrl` and says whether the process should exit 0.
 *
 * It never throws. A probe that threw would exit non-zero anyway, but with a
 * stack trace where an orchestrator's health log wants one line saying which of
 * "unreachable", "not serving" and "serving less than it was asked for" it was.
 */
export async function runHealthcheck(options: HealthcheckOptions): Promise<HealthcheckOutcome> {
  const client = createClient(
    ControlPlaneService,
    createGrpcWebTransport({
      httpVersion: '1.1',
      baseUrl: options.baseUrl,
      useBinaryFormat: true,
      defaultTimeoutMs: options.timeoutMs,
      // `agent: false` gives this request a connection that is closed rather
      // than pooled. The probe is a whole process that must exit as soon as it
      // has its answer, and Node's default global agent keeps an idle socket
      // alive for seconds afterwards -- long enough, at a fifteen-second
      // interval, for probes to overlap.
      nodeOptions: { agent: false },
    }),
  );

  try {
    const health = await client.health({});
    if (health.status !== controlV1.ServingStatus.SERVING) {
      return failure(`${health.service} reports ${servingStatusName(health.status)}`);
    }

    // Read off the response already in hand rather than asking again. A
    // dependency this deployment named and the process did not configure is
    // reported `NOT_SERVING`, and an absent one is the same answer for the
    // stronger reason that the process never built it at all.
    const unavailable = options.requiredDependencies.filter(
      (name) =>
        health.dependencies.find((dependency) => dependency.name === name)?.status !==
        controlV1.ServingStatus.SERVING,
    );
    if (unavailable.length > 0) {
      return failure(`${health.service} is SERVING without ${unavailable.join(', ')}`);
    }

    if (options.requiredCapabilities.length === 0 && options.refusedCapabilities.length === 0) {
      return { exitCode: 0, report: `${health.service} ${health.version} is SERVING` };
    }

    // A second round trip, and only when something was asked of it. Health is
    // the cheap answer an orchestrator takes every interval; the capability
    // list is read for the deployments that state an expectation about it.
    const capabilities = await client.getCapabilities({});
    const enabled = new Set(
      capabilities.capabilities.filter((entry) => entry.enabled).map((entry) => entry.name),
    );
    const missing = options.requiredCapabilities.filter((name) => !enabled.has(name));
    const present = options.refusedCapabilities.filter((name) => enabled.has(name));
    if (missing.length > 0 || present.length > 0) {
      return failure(
        [
          `${health.service} is SERVING but does not match the requested capability set`,
          ...(missing.length === 0 ? [] : [`missing: ${missing.join(', ')}`]),
          ...(present.length === 0 ? [] : [`present: ${present.join(', ')}`]),
        ].join('; '),
      );
    }
    return {
      exitCode: 0,
      report: `${health.service} ${health.version} is SERVING with ${describeCapabilityExpectation(options)}`,
    };
  } catch (error) {
    // `ConnectError.from` normalizes a refused connection, a timeout and a
    // server-sent status into one shape, so the report reads the same whether
    // the plane answered badly or did not answer.
    return failure(`${options.baseUrl} did not answer: ${ConnectError.from(error).message}`);
  }
}

/**
 * Reads the flags the two callers pass, defaulting from the same environment
 * the server itself reads.
 *
 * Unknown flags are refused rather than ignored. A `HEALTHCHECK` line is
 * written once and never read again, and a typo that was ignored would make the
 * probe quietly weaker than the Dockerfile claims -- `--require-capabilities`
 * with an `s` would assert nothing at all.
 */
export function parseHealthcheckArguments(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HealthcheckOptions {
  let baseUrl: string | undefined;
  let timeoutMs = defaultTimeoutMs;
  const requiredCapabilities: string[] = [];
  const refusedCapabilities: string[] = [];
  const requiredDependencies: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--base-url':
        baseUrl = requireValue(argv, (index += 1), flag);
        break;
      case '--require-capability':
        requiredCapabilities.push(requireValue(argv, (index += 1), flag));
        break;
      case '--refuse-capability':
        refusedCapabilities.push(requireValue(argv, (index += 1), flag));
        break;
      case '--require-dependency':
        requiredDependencies.push(requireValue(argv, (index += 1), flag));
        break;
      case '--timeout-ms':
        timeoutMs = parseTimeoutMs(requireValue(argv, (index += 1), flag));
        break;
      default:
        throw new Error(`Unknown healthcheck argument: ${String(flag)}`);
    }
  }

  return {
    baseUrl: baseUrl ?? defaultBaseUrl(environment),
    requiredCapabilities,
    refusedCapabilities,
    requiredDependencies,
    timeoutMs,
  };
}

/**
 * Where to probe when nothing said.
 *
 * The container binds `HQ_CONTROL_PLANE_HOST=0.0.0.0`, and `0.0.0.0` is a
 * wildcard to listen on, not an address to connect to. Substituting loopback is
 * what makes the default work in the deployment this exists for; naming the
 * configured host verbatim would make the image's own `HEALTHCHECK` fail
 * against a correctly serving process.
 */
function defaultBaseUrl(environment: Readonly<Record<string, string | undefined>>): string {
  const port = environment.HQ_CONTROL_PLANE_PORT?.trim();
  const host = environment.HQ_CONTROL_PLANE_HOST?.trim();
  return `http://${probeAuthority(host)}:${port === undefined || port.length === 0 ? defaultPort.toString() : port}`;
}

function probeAuthority(host: string | undefined): string {
  if (host === undefined || host.length === 0) return defaultProbeHost;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (bare === '0.0.0.0') return defaultProbeHost;
  if (bare === '::' || bare === '::0') return '[::1]';
  return isIP(bare) === 6 ? `[${bare}]` : bare;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parseTimeoutMs(value: string): number {
  if (!/^\d+$/u.test(value.trim())) {
    throw new Error('--timeout-ms must be a whole number of milliseconds');
  }
  const timeoutMs = Number(value.trim());
  if (timeoutMs < 1 || timeoutMs > 60_000) {
    throw new Error('--timeout-ms must be between 1 and 60000');
  }
  return timeoutMs;
}

function describeCapabilityExpectation(options: HealthcheckOptions): string {
  return [
    ...(options.requiredCapabilities.length === 0
      ? []
      : [`${options.requiredCapabilities.join(', ')} enabled`]),
    ...(options.refusedCapabilities.length === 0
      ? []
      : [`${options.refusedCapabilities.join(', ')} off`]),
  ].join(' and ');
}

function servingStatusName(status: controlV1.ServingStatus): string {
  return controlV1.ServingStatus[status] ?? `status ${String(status)}`;
}

function failure(report: string): HealthcheckOutcome {
  return { exitCode: 1, report };
}

if (isEntrypoint(import.meta.url, process.argv[1])) {
  const outcome = await runHealthcheck(parseHealthcheckArguments(process.argv.slice(2)));
  // stderr for a failure so that `docker inspect`'s health log and an operator's
  // terminal both separate the two without parsing the text.
  const stream = outcome.exitCode === 0 ? process.stdout : process.stderr;
  stream.write(`${outcome.report}\n`);
  process.exitCode = outcome.exitCode;
}
