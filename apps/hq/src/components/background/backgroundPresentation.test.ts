import { describe, expect, it } from 'vitest';

import { resolvePresentation } from '@/application/personalization/presentation';

/**
 * `OperationsShell` spreads `presentation.attributes` straight onto the root
 * `.ops-shell` element, so `resolvePresentation` is the whole mechanism
 * `background-material.spec.ts` relies on when it asserts
 * `data-background-kind`. Proving the new `bitmap-shader` value survives that
 * mechanism here is the same guarantee that spec draws on for every other
 * kind, without needing a browser to draw a WebGL canvas jsdom cannot host.
 */
describe('bitmap-shader background presentation', () => {
  it('carries the bitmap-shader kind onto data-background-kind', () => {
    const resolved = resolvePresentation({ 'backgrounds.kind': 'bitmap-shader' });

    expect(resolved.attributes['data-background-kind']).toBe('bitmap-shader');
  });
});
