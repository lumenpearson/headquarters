import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

/*
 * Testing Library registers its own cleanup only when a global `afterEach`
 * exists, which requires vitest `globals: true`. This project keeps globals
 * off, so without this file every render accumulates in the document and
 * `screen` queries start matching elements left over from earlier tests.
 *
 * Guarded because setup files run for node-environment tests too, where there
 * is no document to clean.
 */
afterEach(() => {
  if (typeof document !== 'undefined') cleanup();
});
