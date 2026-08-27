'use client';

import { useSyncExternalStore } from 'react';

function subscribeToLoad(callback: () => void): () => void {
  window.addEventListener('load', callback, { once: true });
  return () => {
    window.removeEventListener('load', callback);
  };
}

/**
 * True once the document has fully loaded -- stylesheets, fonts and other
 * subresources included, not merely the DOM tree.
 *
 * The document is an external system, so this is `useSyncExternalStore`: the
 * snapshot reads `readyState` directly, which also answers for a document
 * that finished loading before the subscriber mounted -- `load` will never
 * fire again, and the state must not wait for an event that already passed.
 * The server snapshot is `false`: prerendered HTML has not loaded anything.
 */
export function useDocumentLoaded(): boolean {
  return useSyncExternalStore(
    subscribeToLoad,
    () => document.readyState === 'complete',
    () => false,
  );
}
