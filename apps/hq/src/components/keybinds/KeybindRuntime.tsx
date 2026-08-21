'use client';

import { useEffect, useRef } from 'react';

import { findKeybind } from '@/application/keybinds/registry';

type KeybindHandler = () => void;

/*
 * One subscriber table for the whole document, in the idiom `operationsStore`
 * already uses: the application runs as a single client runtime, and threading
 * a context through every screen that owns a key would be ceremony around the
 * same single instance.
 */
const handlers = new Map<string, Set<KeybindHandler>>();
const firedListeners = new Set<(id: string) => void>();

/**
 * Reports which keybind just did something.
 *
 * Only what actually ran is announced. The list uses this to light up a row as
 * the operator presses it, and lighting up a row whose action no screen
 * provides would say a key works when it does not.
 */
export function subscribeKeybindFired(listener: (id: string) => void): () => void {
  firedListeners.add(listener);
  return () => firedListeners.delete(listener);
}

/**
 * Whether any mounted screen can act on a declared keybind right now.
 *
 * The context menu asks this before drawing a command: an entry that looks
 * available and does nothing is worse than one that says it is unavailable.
 */
export function keybindHasOwner(id: string): boolean {
  return (handlers.get(id)?.size ?? 0) > 0;
}

/**
 * Runs a declared keybind's owners, whatever raised it.
 *
 * The single dispatch path for both gestures: the keydown listener below and
 * the context menu, which is the same command surface reached with a pointer.
 * Returns whether anything ran, which is how the listener decides to swallow
 * the key.
 */
export function fireKeybind(id: string): boolean {
  const owners = handlers.get(id);
  // A declared keybind with no owner on this screen is not this application's
  // key to swallow.
  if (owners === undefined || owners.size === 0) return false;
  for (const owner of [...owners]) owner();
  for (const listener of [...firedListeners]) listener(id);
  return true;
}

/**
 * Claims a declared keybind outside React's hook rules.
 *
 * Used where one effect owns a set of them -- the nine numbered routes -- since
 * nine `useKeybind` calls in a loop is a hook count that only happens to be
 * constant.
 */
export function subscribeKeybind(id: string, handler: KeybindHandler): () => void {
  const existing = handlers.get(id) ?? new Set<KeybindHandler>();
  existing.add(handler);
  handlers.set(id, existing);
  return () => {
    existing.delete(handler);
    if (existing.size === 0) handlers.delete(id);
  };
}

/**
 * Claims a declared keybind for as long as the component is mounted.
 *
 * Ownership stays with whoever can act on it -- the files screen owns its
 * import dialog, edit mode owns its own toggle -- while the declaration, the
 * matching and the typing guard all live in one place.
 */
export function useKeybind(id: string, handler: () => void): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => subscribeKeybind(id, () => latest.current()), [id]);
}

/**
 * The single application-wide keydown listener.
 *
 * Replaces four separate `window.addEventListener('keydown')` effects that each
 * matched chords their own way and each decided independently whether the
 * operator was typing.
 */
export function KeybindRuntime() {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const keybind = findKeybind(event, { typing: isTypingTarget(event.target) });
      if (keybind === undefined) return;
      if (!fireKeybind(keybind.id)) return;
      if (keybind.preventsDefault) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return null;
}

function isTypingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}
