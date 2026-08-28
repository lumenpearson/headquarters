import { describe, expect, it } from 'vitest';

import {
  defaultScreenWindows,
  productionOverrideSchema,
  projectConfigSchema,
} from './projectSchemas.js';

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

const nearPlane = 'http://192.168.10.5:4100';
const cloudPlane = 'https://plane.example';

describe('project config schema', () => {
  it('reads an absent control plane URL as local-only', () => {
    const result = projectConfigSchema.parse(project);
    expect(result.controlPlaneUrl).toEqual([]);
  });

  it('accepts a LAN control plane, unlike the loopback-only bridge', () => {
    // The control plane is one machine on the set's network; every other
    // screen pairs with it across that network, so a host other than
    // 127.0.0.1 has to be allowed here where `bridgeUrl` refuses it.
    const result = projectConfigSchema.parse({ ...project, controlPlaneUrl: nearPlane });
    expect(result.controlPlaneUrl).toEqual([nearPlane]);
  });

  it('reads a bare string as a list of one, so an existing override still works', () => {
    // `project.override.json` on a shoot machine carries this key as a string.
    // An object schema strips a key it does not know, so a renamed field would
    // make that file silently do nothing; the singular key therefore stays and
    // accepts both shapes. Re-parsing the parsed output has to hold as well,
    // because that is exactly what applying an override does.
    const once = projectConfigSchema.parse({ ...project, controlPlaneUrl: nearPlane });
    const twice = projectConfigSchema.parse({ ...once, defaultWallPreset: 'hq-wide' });
    expect(twice.controlPlaneUrl).toEqual([nearPlane]);
  });

  it('keeps two addresses in the order the operator wrote them', () => {
    // Order is the only thing that ranks the planes: there is no discovery on
    // the LAN, so the near plane is the one written first.
    const result = projectConfigSchema.parse({
      ...project,
      controlPlaneUrl: [nearPlane, cloudPlane],
    });
    expect(result.controlPlaneUrl).toEqual([nearPlane, cloudPlane]);
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

  it('applies the same refusal to every entry of a list, not only the first', () => {
    expect(
      projectConfigSchema.safeParse({
        ...project,
        controlPlaneUrl: [nearPlane, 'ws://plane.example'],
      }).success,
    ).toBe(false);
  });

  it('refuses a repeated address and a list past the ceiling', () => {
    // Every address costs a client, a probe and, where the plane serves no
    // socket, a poll on a metered invocation budget.
    expect(
      projectConfigSchema.safeParse({ ...project, controlPlaneUrl: [nearPlane, nearPlane] })
        .success,
    ).toBe(false);
    expect(
      projectConfigSchema.safeParse({
        ...project,
        controlPlaneUrl: [
          'https://one.example',
          'https://two.example',
          'https://three.example',
          'https://four.example',
          'https://five.example',
        ],
      }).success,
    ).toBe(false);
  });

  it('still binds the bridge to the loopback interface', () => {
    expect(
      projectConfigSchema.safeParse({ ...project, bridgeUrl: 'http://192.168.10.5:4177' }).success,
    ).toBe(false);
  });
});

describe('production override schema', () => {
  it('parses the minimal documented override, with no assetOverrides written', () => {
    // docs/release/self-hosting.md documents `{"version": 1, "values": {...}}`
    // as the minimal override an operator writes to point at a control plane;
    // that shape must parse without an explicit `assetOverrides` field.
    const result = productionOverrideSchema.parse({
      version: 1,
      values: { controlPlaneUrl: nearPlane },
    });
    expect(result).toEqual({
      version: 1,
      values: { controlPlaneUrl: nearPlane },
      assetOverrides: {},
    });
  });

  it('parses a bare version with neither values nor assetOverrides written', () => {
    const result = productionOverrideSchema.parse({ version: 1 });
    expect(result).toEqual({ version: 1, values: {}, assetOverrides: {} });
  });

  it('still requires the version, the migration anchor', () => {
    expect(productionOverrideSchema.safeParse({ values: {} }).success).toBe(false);
  });

  it('still parses the full shape, with both records written', () => {
    const result = productionOverrideSchema.parse({
      version: 1,
      values: { controlPlaneUrl: nearPlane },
      assetOverrides: {
        'asset-1': { kind: 'static', url: 'https://cdn.example/asset-1.png' },
      },
    });
    expect(result).toEqual({
      version: 1,
      values: { controlPlaneUrl: nearPlane },
      assetOverrides: {
        'asset-1': { kind: 'static', url: 'https://cdn.example/asset-1.png' },
      },
    });
  });
});
