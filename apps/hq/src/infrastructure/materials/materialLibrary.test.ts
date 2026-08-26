import { describe, expect, it } from 'vitest';

import type { MaterialEntry } from './BridgeMaterialClient';
import {
  cameraDeclaredRendition,
  materialOriginLabel,
  renditionsForMaterial,
  selectMaterialLibrary,
  type MaterialLibraryClient,
} from './materialLibrary';

const bridge = library('local-mirror');
const group = library('group-library');

describe('choosing the library a session reads and writes', () => {
  it('uses the group library only when admitted, capable and built', () => {
    expect(selectMaterialLibrary({ bridge, group, online: true, materialsCapability: true })).toBe(
      group,
    );
  });

  it('stays on the loopback bridge for every other combination', () => {
    // Not admitted: local-only, offline, connecting, or a session whose tokens
    // were refused. The capability answer from a previous connection must not
    // outlive the session that earned it.
    expect(selectMaterialLibrary({ bridge, group, online: false, materialsCapability: true })).toBe(
      bridge,
    );
    // Admitted to a control plane that answers `GetCapabilities` without
    // `materials`: every material RPC there refuses, so a client pointed at it
    // could only turn an import into a round trip that fails.
    expect(selectMaterialLibrary({ bridge, group, online: true, materialsCapability: false })).toBe(
      bridge,
    );
    // Admitted and capable, but nothing was built -- a test injected RPC
    // clients, so there is no shared transport to build one on.
    expect(
      selectMaterialLibrary({ bridge, group: null, online: true, materialsCapability: true }),
    ).toBe(bridge);
    expect(
      selectMaterialLibrary({ bridge, group: null, online: false, materialsCapability: false }),
    ).toBe(bridge);
  });

  it('names each origin the way the shell prints it', () => {
    expect(materialOriginLabel('group-library')).toBe('GROUP LIBRARY');
    expect(materialOriginLabel('local-mirror')).toBe('LOCAL MIRROR');
  });
});

describe('the ladder a material can be asked for', () => {
  it('offers picture heights for video and a thumbnail for a still, original first', () => {
    expect(renditionsForMaterial(entry('video/mp4')).map((rendition) => rendition.variant)).toEqual(
      ['', '1080p', '720p', '480p'],
    );
    expect(renditionsForMaterial(entry('image/png')).map((rendition) => rendition.variant)).toEqual(
      ['', 'thumbnail'],
    );
  });

  it('offers only the stored object for anything with no picture to scale', () => {
    expect(renditionsForMaterial(entry('audio/mpeg'))).toHaveLength(1);
    expect(renditionsForMaterial(entry('application/pdf'))).toHaveLength(1);
    expect(renditionsForMaterial(entry('VIDEO/MP4'))).toHaveLength(4);
  });
});

describe('the rendition a camera declares (C25)', () => {
  it('turns the declared codec and bitrate into one variant token and one label', () => {
    expect(cameraDeclaredRendition('H.264', '4.5 Mbps')).toEqual({
      variant: 'h-264@4-5-mbps',
      label: 'DECLARED H.264 / 4.5 Mbps',
    });
  });

  it('still names the half that was declared', () => {
    expect(cameraDeclaredRendition('H.265', '')).toEqual({
      variant: 'h-265',
      label: 'DECLARED H.265',
    });
  });

  it('names nothing when the camera declares nothing', () => {
    expect(cameraDeclaredRendition('', '')).toBeNull();
    expect(cameraDeclaredRendition('   ', '///')).toBeNull();
  });
});

function entry(mimeType: string): MaterialEntry {
  return {
    materialId: '018f0f1a-8000-7000-8000-000000000000',
    displayName: 'sample',
    mimeType,
    byteSize: 1n,
    contentHash: '',
    createdAt: '',
  };
}

/** Identity is all these tests read; nothing calls a method on them. */
function library(origin: 'local-mirror' | 'group-library'): MaterialLibraryClient {
  return { origin } as unknown as MaterialLibraryClient;
}
