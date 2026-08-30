import type { AppUpdatePort } from './appUpdatePort';

export interface AutostartReconciliation {
  readonly enabled: boolean;
  /** The port's own rejection message, or `null` when nothing was refused. */
  readonly error: string | null;
}

/**
 * Reconciles `startup.launchOnLogin` against the shell's own autostart
 * registration, rather than trusting the setting alone to describe what the
 * machine will actually do on the next login.
 *
 * `setAutostart` is asked for first; `isAutostartEnabled` is re-read
 * regardless of whether that call threw, because a refusal does not say what
 * the registration is now -- only a fresh read does. The caller renders the
 * returned `enabled`, not the setting it asked for: a shell that silently
 * refuses shows up as the switch settling back to its previous state rather
 * than a claim nobody confirmed.
 *
 * A build with no adapter reconciles to `{ enabled: false, error: null }`:
 * there is nothing to register, and nothing that refused it either.
 */
export async function reconcileAutostart(
  port: AppUpdatePort | null,
  desired: boolean,
): Promise<AutostartReconciliation> {
  if (port === null) return { enabled: false, error: null };
  let error: string | null = null;
  try {
    await port.setAutostart(desired);
  } catch (thrown) {
    error = messageOf(thrown);
  }
  try {
    return { enabled: await port.isAutostartEnabled(), error };
  } catch (thrown) {
    return { enabled: false, error: error ?? messageOf(thrown) };
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AutostartReading extends AutostartReconciliation {
  /** Whether a reconciliation is in flight right now. */
  readonly pending: boolean;
}

const resting: AutostartReading = { enabled: false, error: null, pending: false };

/**
 * The reconciliation as something to subscribe to rather than something a
 * component holds.
 *
 * Asking the shell to register an autostart entry is an external process with
 * its own timing, and a React effect that assigned `pending` on its way to
 * starting one was writing state to describe work outside React -- which is
 * exactly the shape the effect rules are about. The coordinator owns the
 * reading; the surface subscribes to it and renders whatever it says.
 *
 * A request that arrives while another is in flight supersedes it: the last
 * value the operator asked for is the one the machine should end up with, and
 * the earlier answer is discarded rather than allowed to overwrite the later.
 *
 * The rule for when a request actually writes: the first `request()` call
 * after construction -- the surface mounting -- only reads. It never calls
 * `setAutostart`, however `desired` compares to what it finds, because a
 * mount is not the operator asking for anything; it is a settings card
 * opening (or reopening) and finding out what is already true. Writing on
 * mount would let opening the card silently register or unregister an
 * autostart entry -- including one a person set up outside the app -- purely
 * because `startup.launchOnLogin`'s persisted value happens to disagree with
 * the machine. Every call after the first writes only when `desired` itself
 * has changed since the previous call: the operator flipping the switch,
 * which is the one event this coordinator treats as an instruction rather
 * than an observation.
 */
export class AutostartCoordinator {
  readonly #port: AppUpdatePort | null;
  readonly #listeners = new Set<() => void>();
  #reading: AutostartReading = resting;
  #generation = 0;
  /** `desired` from the previous `request()`, or `undefined` before the first one. */
  #lastRequestedDesired: boolean | undefined;

  constructor(port: AppUpdatePort | null) {
    this.#port = port;
  }

  getReading(): AutostartReading {
    return this.#reading;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  request(desired: boolean): void {
    const port = this.#port;
    if (port === null) return;
    const isMount = this.#lastRequestedDesired === undefined;
    const intentChanged = !isMount && desired !== this.#lastRequestedDesired;
    this.#lastRequestedDesired = desired;
    if (!isMount && !intentChanged) return;

    const generation = (this.#generation += 1);
    this.#publish({ ...this.#reading, pending: true });
    const settle = isMount ? readCurrentRegistration(port) : reconcileAutostart(port, desired);
    void settle.then((result) => {
      if (generation !== this.#generation) return;
      this.#publish({ ...result, pending: false });
    });
  }

  #publish(reading: AutostartReading): void {
    this.#reading = reading;
    for (const listener of this.#listeners) listener();
  }
}

/**
 * The mount-time half of reconciliation: what the machine already has
 * registered, with no write. Failures report the same shape a write's
 * follow-up read would (`enabled: false`, the message as `error`), so a
 * mount-time read failure renders the same way a write's does.
 */
async function readCurrentRegistration(port: AppUpdatePort): Promise<AutostartReconciliation> {
  try {
    return { enabled: await port.isAutostartEnabled(), error: null };
  } catch (thrown) {
    return { enabled: false, error: messageOf(thrown) };
  }
}
