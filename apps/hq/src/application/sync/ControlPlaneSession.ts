import { resolveAuthority } from './authority';
import { summarizeClockSamples } from './clock';
import {
  disconnectedConnection,
  groupDevicePatch,
  initialConnectionState,
  sortPresence,
  type AuthorityMode,
  type ConnectionState,
  type DeviceRole,
  type GroupDevice,
  type GroupSummary,
  type PairingRole,
} from './connection';
import {
  isControlPlaneError,
  type ClockSample,
  type ControlPlaneErrorKind,
  type ControlPlanePort,
  type CreateGroupRequest,
  type PairingCodeGrant,
} from './controlPlanePort';

export interface ControlPlaneSessionOptions {
  readonly client: ControlPlanePort;
  /** Where a transition is recorded. The store's `patchConnection`, in the app. */
  readonly apply: (patch: Partial<ConnectionState>) => void;
  readonly now?: () => number;
  /** Rounds one clock estimate is taken from; the median of them is kept. */
  readonly clockRounds?: number;
  /**
   * How close to expiry an access token may come before it is rotated. Wide
   * enough that a poll never races the deadline, short enough that a refresh
   * is not a per-minute event.
   */
  readonly refreshLeadMs?: number;
}

/**
 * What the runtime should do about `groups.authority` after a reconciliation:
 * nothing, or write the server's mode back into the setting.
 */
export interface AuthorityOutcome {
  readonly reflect?: AuthorityMode;
}

/**
 * The connection to the group, as a sequence of decisions rather than a
 * component (R27).
 *
 * It owns every mode transition of the `connection` slice; `ControlPlaneRuntime`
 * supplies the mount, the timers and the settings, and components read the
 * slice. The service keeps its own copy of what it has written, so a decision is
 * taken against what it knows rather than by reaching back into the store —
 * which is also what lets a test drive it with no store at all.
 *
 * Two fields of the slice are not the service's, and are named here so the
 * ownership can be read in one place. `links` is installed by the runtime from
 * the configured addresses, and every feed reports its own entry of it.
 * `mirror` is a fact about the disk. The runtime also moves the mode to
 * `connecting` on its own before it probes those links, because that probe now
 * precedes {@link ControlPlaneSession.connect}.
 *
 * Nothing here opens a socket. The realtime channel, live edit over
 * `PublishDocumentDelta` and group settings are the second half of F10; they
 * connect to this service rather than replacing it.
 */
export class ControlPlaneSession {
  readonly #client: ControlPlanePort;
  readonly #apply: (patch: Partial<ConnectionState>) => void;
  readonly #now: () => number;
  readonly #clockRounds: number;
  readonly #refreshLeadMs: number;
  #state: ConnectionState = initialConnectionState;

  constructor(options: ControlPlaneSessionOptions) {
    this.#client = options.client;
    this.#apply = options.apply;
    this.#now = options.now ?? (() => Date.now());
    this.#clockRounds = options.clockRounds ?? 5;
    this.#refreshLeadMs = options.refreshLeadMs ?? 60_000;
  }

  get state(): ConnectionState {
    return this.#state;
  }

  /**
   * Brings the session up: probe, restore, refresh, join.
   *
   * `localOnly` is `general.localOnly`, and it is read before anything else
   * because the setting's promise is that this client stays usable without a
   * group — not that it joins one quietly. With it on no request is made at
   * all, which is why the probe is below this branch rather than above it.
   */
  async connect(localOnly: boolean, signal?: AbortSignal): Promise<void> {
    if (localOnly) {
      this.#reset('local-only');
      return;
    }
    this.#set({ mode: 'connecting', failure: '' });

    let capabilities;
    try {
      capabilities = await this.#client.probeCapabilities(signal);
    } catch (error: unknown) {
      this.#set({ mode: 'offline', failure: describe(error, 'CONTROL PLANE НЕ ОТВЕЧАЕТ') });
      return;
    }
    this.#set({ capabilities });
    if (!capabilities.deviceLifecycle) {
      // A control plane started without durable auth registers only
      // `ControlPlaneService`. Offering pairing there would send a code to a
      // service that cannot answer it.
      this.#set({
        mode: 'offline',
        failure: 'CONTROL PLANE ЗАПУЩЕН БЕЗ УЧЁТА УСТРОЙСТВ — ГРУППЫ НЕДОСТУПНЫ',
      });
      return;
    }

    if (this.#client.session() === null) {
      this.#reset('reauth-required', capabilities);
      return;
    }
    if (!this.#installationMatches(capabilities.installationId)) return;
    if (!(await this.#ensureFreshSession(signal))) return;
    await this.#enterGroup(signal);
  }

  /**
   * Whether the database behind this address is still the one the session was
   * minted against, and the refusal when it is not.
   *
   * Three answers, not two. A stored identity and a reported one that disagree
   * is the reset this exists to catch, and the session stops there: the mode
   * moves somewhere the operator can see, the stored session is left exactly
   * where it is, and nothing is joined, adopted or overwritten. Either side
   * being empty is *unknown*, and unknown proceeds: an empty report comes from
   * a control plane older than the migration that mints an identity, an empty
   * store from a session paired before this client recorded one, and refusing
   * on either would strand a working deployment on an upgrade ordering. A
   * replaced database does not present as absent -- a fresh database that has
   * run its migrations always reports an identity -- so nothing this feature
   * exists to catch escapes through that gap.
   *
   * The unknown store is filled in from the report, so the *next* replacement
   * is caught. `adoptInstallationId` never overwrites a recorded identity, so
   * this can only ever close the gap, never paper over a mismatch.
   */
  #installationMatches(reported: string): boolean {
    const stored = this.#client.storedInstallationId();
    if (stored === null) return true;
    if (stored === '' || reported === '') {
      this.#client.adoptInstallationId(reported);
      return true;
    }
    if (stored === reported) return true;
    this.#set({
      ...disconnectedConnection('installation-changed'),
      capabilities: this.#state.capabilities,
      failure:
        'БАЗА CONTROL PLANE ПО ЭТОМУ АДРЕСУ — НЕ ТА, С КОТОРОЙ СПАРЕНО УСТРОЙСТВО. ' +
        'ГРУППА И НАСТРОЙКИ ГРУППЫ НЕ ЧИТАЮТСЯ, ЛОКАЛЬНОЕ СОСТОЯНИЕ НЕ ПЕРЕЗАПИСЫВАЕТСЯ. ' +
        'ЗАБУДЬТЕ СОХРАНЁННУЮ СЕССИЮ И СПАРИТЕСЬ ЗАНОВО.',
    });
    return false;
  }

  /**
   * Creates the group this device will lead, then enters it (R27).
   *
   * The other half of `pair`: one of the two is how a session comes to belong
   * to a group at all, and before this existed neither of them could be the
   * first. The failure lands on `reauth-required` for the same reason pairing's
   * does -- nothing was joined and the operator's next act is to present a
   * credential -- and the refusal is put where the operator reads it rather
   * than swallowed.
   *
   * The secret is a parameter and never a field: it is passed through to the
   * client, which sets it as one request header, and this service records
   * nothing of it. Answering whether the group exists is what the surface needs;
   * anything more would be the secret's lifetime growing.
   */
  async createGroup(request: CreateGroupRequest, signal?: AbortSignal): Promise<boolean> {
    this.#set({ mode: 'connecting', failure: '' });
    try {
      const created = await this.#client.createGroup(request, signal);
      this.#set({ session: created.session });
      this.#applyGroup(created.group);
    } catch (error: unknown) {
      this.#set({ mode: 'reauth-required', failure: describe(error, 'ГРУППА НЕ СОЗДАНА') });
      return false;
    }
    await this.#enterGroup(signal);
    return true;
  }

  /**
   * Issues a pairing code, and hands it back rather than recording it.
   *
   * `null` is a refusal, and the refusal is on `connection.failure` by then:
   * the caller needs the answer only to stop showing a code that is no longer
   * the newest thing that happened. The code itself never enters the slice --
   * it is a credential, and the slice is persisted, broadcast and copied into
   * diagnostic reports.
   */
  async createPairingCode(
    role: PairingRole,
    signal?: AbortSignal,
  ): Promise<PairingCodeGrant | null> {
    if (!(await this.#ensureFreshSession(signal))) return null;
    try {
      const grant = await this.#client.createPairingCode(role, signal);
      this.#set({ failure: '' });
      return grant;
    } catch (error: unknown) {
      this.#record(error);
      return null;
    }
  }

  /**
   * Renames the group, and records the revision the rename produced.
   *
   * The revision is why this goes through `#applyGroup` rather than writing the
   * name alone. `UpdateGroup` publishes `GROUP_UPDATED`, so the same change
   * comes back over the log; the version check in `groupStatePatch` drops it as
   * already held. A name written without its revision would leave this session
   * behind the group it just renamed, and the pre-rename snapshot still in the
   * retained window would put the old name back on the next resume.
   */
  async renameGroup(name: string, signal?: AbortSignal): Promise<boolean> {
    if (!(await this.#ensureFreshSession(signal))) return false;
    try {
      this.#applyGroup(await this.#client.updateGroup(name, signal));
      this.#set({ failure: '' });
      return true;
    } catch (error: unknown) {
      this.#record(error);
      return false;
    }
  }

  /**
   * Changes what a member of the group may do.
   *
   * The answer carries no group and therefore no revision, so the roster is
   * written by the rule both paths share and the group's own fields are left
   * to the `DEVICE_UPDATED` event the same mutation publishes. Applying the
   * answer is not optional: a control plane started without a realtime hub
   * publishes nothing, and a poll feed is up to its interval behind, so a
   * session that waited for the echo would show a role it had already changed.
   * Applying both is safe because replacing a record with an equal record
   * changes nothing.
   */
  async setDeviceRole(deviceId: string, role: DeviceRole, signal?: AbortSignal): Promise<boolean> {
    if (!(await this.#ensureFreshSession(signal))) return false;
    let changed: GroupDevice;
    try {
      changed = await this.#client.setDeviceRole(deviceId, role, signal);
    } catch (error: unknown) {
      this.#record(error);
      return false;
    }
    this.#set({ ...groupDevicePatch(this.#state, changed), failure: '' });
    return true;
  }

  /** Pairs with a code an administrator issued, then enters the group. */
  async pair(pairingCode: string, deviceName: string, signal?: AbortSignal): Promise<void> {
    this.#set({ mode: 'connecting', failure: '' });
    try {
      const paired = await this.#client.pair(pairingCode, deviceName, signal);
      this.#set({ session: paired.session });
      this.#applyGroup(paired.group);
    } catch (error: unknown) {
      this.#set({ mode: 'reauth-required', failure: describe(error, 'КОД ПАРЫ НЕ ПРИНЯТ') });
      return;
    }
    await this.#enterGroup(signal);
  }

  /**
   * Leaves the group's session without giving up the pairing.
   *
   * `LeaveGroup` is participation, not membership: the device stays paired and
   * rejoining needs no new code, which is why this lands on `offline` rather
   * than on `reauth-required`.
   */
  async leave(signal?: AbortSignal): Promise<void> {
    try {
      await this.#client.leave(signal);
    } catch (error: unknown) {
      this.#record(error);
      return;
    }
    this.#set({
      mode: 'offline',
      presence: [],
      devices: [],
      failure: 'СЕССИЯ ВЫШЛА ИЗ ГРУППЫ',
    });
  }

  /** Gives up the pairing itself. The next connection needs a new code. */
  unpair(): void {
    this.#client.forgetSession();
    this.#reset('reauth-required', this.#state.capabilities);
  }

  /** Rotates the access token when it is near expiry; a no-op otherwise. */
  ensureFreshSession(signal?: AbortSignal): Promise<boolean> {
    return this.#ensureFreshSession(signal);
  }

  async refreshPresence(signal?: AbortSignal): Promise<void> {
    if (this.#state.mode !== 'online') return;
    if (!(await this.#ensureFreshSession(signal))) return;
    try {
      this.#set({ presence: sortPresence(await this.#client.getPresence(signal)) });
    } catch (error: unknown) {
      this.#record(error);
    }
  }

  async refreshDevices(signal?: AbortSignal): Promise<void> {
    if (this.#state.mode !== 'online') return;
    if (!(await this.#ensureFreshSession(signal))) return;
    try {
      this.#set({ devices: await this.#client.listDevices(signal) });
    } catch (error: unknown) {
      this.#record(error);
    }
  }

  /**
   * One clock estimate, from several rounds.
   *
   * Several because a single round delayed by a scheduler pause reports an
   * offset that never existed; the median of the rounds is what survives one
   * such delay. R27 asks for agreement to the millisecond, and this is the
   * cheapest way to keep one bad sample from setting it.
   */
  async sampleClock(signal?: AbortSignal): Promise<void> {
    if (this.#state.mode !== 'online') return;
    if (!(await this.#ensureFreshSession(signal))) return;
    const samples: ClockSample[] = [];
    try {
      for (let round = 0; round < this.#clockRounds; round += 1) {
        samples.push(await this.#client.timeSync(signal));
      }
    } catch (error: unknown) {
      this.#record(error);
      // Rounds already taken are still an estimate; only a round that never
      // answered is discarded.
      if (samples.length === 0) return;
    }
    this.#set({ clock: summarizeClockSamples(samples, new Date(this.#now()).toISOString()) });
  }

  /**
   * Brings `groups.authority` and the group's mode into agreement.
   *
   * The precedence is stated in `authority.ts`: the server owns the decision,
   * except that an administrator moving the setting *is* the group deciding.
   * The caller writes the setting back when this answers with `reflect`,
   * because a settings patch belongs to the store and this service has no
   * business holding one.
   */
  async reconcileAuthority(
    setting: AuthorityMode | undefined,
    signal?: AbortSignal,
  ): Promise<AuthorityOutcome> {
    const resolution = resolveAuthority({
      setting,
      server: this.#state.authority,
      role: this.#state.session?.role,
      mode: this.#state.mode,
    });
    if (resolution.action === 'none') return {};
    if (resolution.action === 'reflect') return { reflect: resolution.mode };
    if (!(await this.#ensureFreshSession(signal))) return {};
    try {
      this.#applyGroup(await this.#client.setAuthorityMode(resolution.mode, signal));
    } catch (error: unknown) {
      this.#record(error);
      // The server refused the change, so the group's own mode is what stands.
      // Reflecting it keeps the two from disagreeing on every later pass.
      return this.#state.authority === undefined ? {} : { reflect: this.#state.authority };
    }
    return {};
  }

  async setLeader(deviceId: string, signal?: AbortSignal): Promise<void> {
    if (!(await this.#ensureFreshSession(signal))) return;
    try {
      this.#applyGroup(await this.#client.setLeader(deviceId, signal));
    } catch (error: unknown) {
      this.#record(error);
    }
  }

  async revoke(deviceId: string, signal?: AbortSignal): Promise<void> {
    if (!(await this.#ensureFreshSession(signal))) return;
    try {
      await this.#client.revoke(deviceId, signal);
    } catch (error: unknown) {
      this.#record(error);
      return;
    }
    await this.refreshDevices(signal);
  }

  /** Joins the group and takes the first device, presence and clock readings. */
  async #enterGroup(signal?: AbortSignal): Promise<void> {
    const session = this.#client.session();
    if (session === null) {
      this.#reset('reauth-required', this.#state.capabilities);
      return;
    }
    this.#set({ session });
    try {
      this.#applyGroup(await this.#client.join(signal));
      this.#set({ mode: 'online', failure: '' });
    } catch (error: unknown) {
      if (isControlPlaneError(error, 'unimplemented')) {
        /*
         * A control plane started without presence storage answers `JoinGroup`
         * `unimplemented`. The device is paired and authenticated all the same,
         * so this is a reduced deployment rather than a failure: the session is
         * online and simply has no presence to show.
         */
        this.#set({
          mode: 'online',
          failure: 'CONTROL PLANE БЕЗ ХРАНИЛИЩА ПРИСУТСТВИЯ — СПИСОК СЕССИЙ НЕДОСТУПЕН',
        });
        return;
      }
      this.#record(error);
      return;
    }
    await this.refreshDevices(signal);
    await this.refreshPresence(signal);
    await this.sampleClock(signal);
  }

  /**
   * Rotates the access token when it is within the lead time of expiry.
   *
   * Answers whether the session may be used. A refusal is terminal — the
   * tokens are gone and a refresh token cannot be presented twice — so the
   * mode moves to `reauth-required` and the operator is asked for a code
   * rather than the client retrying against a dead session family.
   */
  async #ensureFreshSession(signal?: AbortSignal): Promise<boolean> {
    if (this.#client.session() === null) {
      this.#reset('reauth-required', this.#state.capabilities);
      return false;
    }
    const expiresAt = this.#client.accessTokenExpiresAt();
    if (expiresAt !== null && expiresAt - this.#now() > this.#refreshLeadMs) return true;
    try {
      this.#set({ session: await this.#client.refresh(signal) });
      return true;
    } catch (error: unknown) {
      this.#record(error);
      return false;
    }
  }

  /**
   * Records what a call answered about the group, revision included.
   *
   * The revision travels with the three fields rather than beside them because
   * it is what lets the other path -- the group log, read by `connectGroupState`
   * -- tell a snapshot that is news from one a resume replayed. A patch that
   * moved the leader without moving the revision would leave the log free to
   * put the previous leader back.
   */
  #applyGroup(group: GroupSummary): void {
    this.#set({
      groupName: group.name,
      authority: group.authority,
      leaderDeviceId: group.leaderDeviceId,
      groupRevision: group.revision,
    });
  }

  /** Turns a failure into the mode it implies, and records what to show. */
  #record(error: unknown): void {
    const kind: ControlPlaneErrorKind = isControlPlaneError(error) ? error.kind : 'unknown';
    if (kind === 'unauthenticated') {
      this.#client.forgetSession();
      this.#reset('reauth-required', this.#state.capabilities);
      this.#set({ failure: describe(error, 'СЕССИЯ УСТРОЙСТВА ОТОЗВАНА') });
      return;
    }
    if (kind === 'unavailable') {
      this.#set({ mode: 'offline', failure: describe(error, 'CONTROL PLANE НЕ ОТВЕЧАЕТ') });
      return;
    }
    // Everything else leaves the mode alone: a refused authority change or an
    // absent collaborator is a fact about one call, not about the connection.
    this.#set({ failure: describe(error, 'ЗАПРОС К CONTROL PLANE ОТКЛОНЁН') });
  }

  #reset(mode: ConnectionState['mode'], capabilities?: ConnectionState['capabilities']): void {
    // The capabilities survive a reset: what this deployment can do is a fact
    // about the control plane, not about the session that was just revoked.
    this.#set({ ...disconnectedConnection(mode), capabilities });
  }

  #set(patch: Partial<ConnectionState>): void {
    this.#state = { ...this.#state, ...patch };
    this.#apply(patch);
  }
}

function describe(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message.trim() : '';
  return message.length === 0 ? fallback : `${fallback}: ${message}`;
}
