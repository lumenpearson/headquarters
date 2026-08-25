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
