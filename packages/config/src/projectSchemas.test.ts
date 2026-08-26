import { describe, expect, it } from 'vitest';

import { defaultScreenWindows, projectConfigSchema } from './projectSchemas.js';

const project = {
  version: 1,
  projectName: 'Гремучая смесь — Оперативный штаб',
  buildId: 'hq-test',
  runtimeMode: 'rehearsal',
  developerAccessCode: '314159',
  defaultWallPreset: 'hq-standard',
  fixedClock: '14:32:17',
  bridgeUrl: 'http://127.0.0.1:4177',
  screenWindows: defaultScreenWindows,
  virtualMountRules: [],
  fileDisplayOverrides: [],
  freezeActiveMediaOnSourceChange: true,
  maxTextPreviewBytes: 1_048_576,
};

describe('project config schema', () => {
  it('reads an absent control plane URL as local-only', () => {
    const result = projectConfigSchema.parse(project);
    expect(result.controlPlaneUrl).toBeUndefined();
  });

  it('accepts a LAN control plane, unlike the loopback-only bridge', () => {
    // The control plane is one machine on the set's network; every other
    // screen pairs with it across that network, so a host other than
    // 127.0.0.1 has to be allowed here where `bridgeUrl` refuses it.
    const result = projectConfigSchema.parse({
      ...project,
      controlPlaneUrl: 'http://192.168.10.5:4100',
    });
    expect(result.controlPlaneUrl).toBe('http://192.168.10.5:4100');
  });

  it('refuses a control plane URL that is not http(s) or carries credentials', () => {
    expect(
      projectConfigSchema.safeParse({ ...project, controlPlaneUrl: 'ws://192.168.10.5:4100' })
        .success,
    ).toBe(false);
    expect(
      projectConfigSchema.safeParse({
        ...project,
        controlPlaneUrl: 'http://operator:secret@192.168.10.5:4100',
      }).success,
    ).toBe(false);
  });

  it('still binds the bridge to the loopback interface', () => {
    expect(
      projectConfigSchema.safeParse({ ...project, bridgeUrl: 'http://192.168.10.5:4177' }).success,
    ).toBe(false);
  });
});
