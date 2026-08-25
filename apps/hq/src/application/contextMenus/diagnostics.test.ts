import { beforeEach, describe, expect, it } from 'vitest';

import { operationsStore } from '../../state/operationsStore';
import { buildDiagnosticsReport, copyDiagnosticsReport } from './diagnostics';

describe('the redacted diagnostic report', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('describes where the client is and what it is holding', () => {
    operationsStore.getState().setRoute('cases');
    const report = buildDiagnosticsReport();

    expect(report).toContain('GREMUCHAYA HQ / DIAGNOSTIC REPORT');
    expect(report).toContain('route: cases');
    expect(report).toContain('records: objects');
  });

  it('names the settings that were changed and never the values they were given', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'layout.density', value: 'comfortable' }]);
    const report = buildDiagnosticsReport();

    expect(report).toContain('layout.density');
    expect(report).not.toContain('comfortable');
  });

  it('carries no path, no URL and no credential-shaped value', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'layout.density', value: 'comfortable' }]);
    const report = buildDiagnosticsReport();

    // Shapes rather than words: the report says out loud that it omits paths
    // and tokens, so a search for the word "token" would match its own notice.
    expect(report).not.toMatch(/[A-Za-z]:[\\/]/u);
    expect(report).not.toContain('\\');
    expect(report).not.toContain('://');
    expect(report).toContain('redacted:');
  });

  it('writes nothing while privacy.copyDiagnostics is off', async () => {
    // The declared default is off, so the refusal is what an operator who has
    // touched nothing gets.
    await expect(copyDiagnosticsReport()).resolves.toBe(false);
  });
});

describe('diagnostic report privacy switches', () => {
  beforeEach(() => {
    operationsStore.getState().resetWorld();
  });

  it('omits the record counts when the operator withholds them', () => {
    expect(buildDiagnosticsReport()).toContain('records: objects');

    operationsStore
      .getState()
      .applySettingsPatch([{ id: 'privacy.diagnosticsRecordCounts', value: false }]);

    // Counts describe the size of a world, which is a hint about a shoot even
    // though they name nothing in it.
    expect(buildDiagnosticsReport()).not.toContain('records: objects');
    // Everything else survives: less detail is not no report.
    expect(buildDiagnosticsReport()).toContain('GREMUCHAYA HQ / DIAGNOSTIC REPORT');
  });

  it('withholds the changed setting names but keeps their count', () => {
    operationsStore.getState().applySettingsPatch([{ id: 'layout.density', value: 'comfortable' }]);
    expect(buildDiagnosticsReport()).toContain('layout.density');

    operationsStore
      .getState()
      .applySettingsPatch([{ id: 'privacy.diagnosticsSettingIds', value: false }]);

    const report = buildDiagnosticsReport();
    expect(report).not.toContain('(layout.density');
    // A reader still learns that something was personalised, without learning
    // what the operator changed.
    expect(report).toMatch(/\d+ changed/);
  });
});
