import { readBooleanSetting } from '@/application/personalization/useSetting';
import { operationsStore } from '@/state/operationsStore';

/**
 * The diagnostic report the shell menu puts on the clipboard.
 *
 * Composed field by field rather than serialised from the store, and that is
 * the whole point of `privacy.copyDiagnostics`. A `JSON.stringify` of the
 * runtime would carry whatever a future slice adds to it -- a mount root, a
 * bridge URL, a paired-device token -- into a paste the operator makes into a
 * chat window. What is listed here is a route, a preset, a set of counters and
 * a set of setting identifiers: nothing that names a machine, a filesystem or
 * a credential. Adding a line means deciding, again, that the value is safe to
 * read aloud.
 */
export function buildDiagnosticsReport(): string {
  const state = operationsStore.getState();
  const { ui, production, metrics, personalization } = state;
  const changed = personalization.draft.changedIds;
  return [
    'GREMUCHAYA HQ / DIAGNOSTIC REPORT',
    `route: ${ui.route} / screen ${production.screenId}`,
    `production: preset ${production.preset} / clock ${production.clockMode} x${production.clockSpeed.toString()} / ${production.paused ? 'paused' : 'running'}`,
    `metrics: cpu ${metrics.cpu.toString()} ram ${metrics.ram.toString()} storage ${metrics.storage.toString()} gpu ${metrics.gpu.toString()} readiness ${metrics.readiness.toString()} step ${metrics.simulationStep.toString()}`,
    `records: objects ${count(state.objects)}, cases ${count(state.cases)}, materials ${count(state.attachments)}, alerts ${count(state.alerts)}, events ${state.events.length.toString()}`,
    // Identifiers only. A changed value is a personalization choice and says
    // nothing about the fault; a changed id is what a reader needs to
    // reproduce it.
    `settings: base revision ${personalization.draft.baseRevision.toString()}, ${changed.length.toString()} changed${changed.length === 0 ? '' : ` (${changed.join(', ')})`}`,
    'redacted: filesystem paths, tokens and connection strings are never collected',
  ].join('\n');
}

/**
 * Copies that report, when the operator has allowed it.
 *
 * The gate is checked here as well as in the menu on purpose: the menu draws
 * the entry disabled, which tells the operator the command exists, and a drawn
 * state is a hint rather than an enforcement. Anything else that comes to
 * raise this action -- a later keybind, a script -- meets the setting too.
 *
 * Returns whether anything was written, so a caller can tell a refusal from a
 * clipboard the browser would not give up.
 */
export async function copyDiagnosticsReport(): Promise<boolean> {
  if (!readBooleanSetting('privacy.copyDiagnostics')) return false;
  const clipboard: Clipboard | undefined =
    typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  if (clipboard === undefined) return false;
  await clipboard.writeText(buildDiagnosticsReport());
  return true;
}

function count(records: Readonly<Record<string, unknown>>): string {
  return Object.keys(records).length.toString();
}
