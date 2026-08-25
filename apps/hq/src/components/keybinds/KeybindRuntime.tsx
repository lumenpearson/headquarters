'use client';

import { useEffect, useRef } from 'react';

import { activeKeybinds } from '@/application/keybinds/activeScheme';
import { findKeybind, prefixKeyFor } from '@/application/keybinds/registry';
import { readNumberSetting } from '@/application/personalization/useSetting';

type KeybindHandler = () => void;

/*
 * One subscriber table for the whole document, in the idiom `operationsStore`
 * already uses: the application runs as a single client runtime, and threading
 * a context through every screen that owns a key would be ceremony around the
 * same single instance.
 */
const handlers = new Map<string, Set<KeybindHandler>>();
const firedListeners = new Set<(id: string) => void>();
const ownerListeners = new Set<() => void>();

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
 * Reports that the set of claimed keybinds changed.
 *
 * Ownership is mutable state living outside React, and a surface that draws a
 * command as available or not has to subscribe to it. Reading the table during
 * render instead looks pure to the compiler, which then caches the answer from
 * the first render -- when nothing is claimed yet, because every claim is made
 * in an effect.
 */
export function subscribeKeybindOwners(listener: () => void): () => void {
  ownerListeners.add(listener);
  return () => ownerListeners.delete(listener);
}

/** Every keybind some mounted screen can act on right now. */
export function keybindOwnerIds(): readonly string[] {
  return [...handlers.keys()].filter((id) => (handlers.get(id)?.size ?? 0) > 0);
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
  announceOwners();
  return () => {
    existing.delete(handler);
    if (existing.size === 0) handlers.delete(id);
    announceOwners();
  };
}

function announceOwners(): void {
  for (const listener of [...ownerListeners]) listener();
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
 * How long a prefix key stays open before it is forgotten.
 *
 * Long enough to press `g` and then think about which route, short enough that
 * a `g` typed by accident cannot turn a digit pressed a minute later into a
 * navigation the operator never asked for.
 */

/**
 * The single application-wide keydown listener.
 *
 * Replaces four separate `window.addEventListener('keydown')` effects that each
 * matched chords their own way and each decided independently whether the
 * operator was typing.
 *
 * The collection is read per event rather than per effect, so choosing another
 * `keybinds.scheme` changes what the next press does without this listener
 * being torn down and re-registered.
 */
export function KeybindRuntime() {
  useEffect(() => {
    let pendingPrefix: string | undefined;
    let prefixTimer = 0;

    const forgetPrefix = () => {
      pendingPrefix = undefined;
      window.clearTimeout(prefixTimer);
      prefixTimer = 0;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const typing = isTypingTarget(event.target);
      const keybinds = activeKeybinds();
      const prefix = pendingPrefix;
      const keybind = findKeybind(event, { typing, prefix, keybinds });

      if (keybind !== undefined) {
        forgetPrefix();
        if (!fireKeybind(keybind.id)) return;
        if (keybind.preventsDefault) event.preventDefault();
        return;
      }

      // A prefix that led nowhere is dropped rather than carried into the next
      // press: `g` then `x` then `1` must not navigate.
      if (prefix !== undefined) forgetPrefix();
      if (typing) return;

      const opened = prefixKeyFor(event, keybinds);
      if (opened === undefined) return;
      pendingPrefix = opened;
      // Not swallowed. The prefix alone commands nothing yet, and the runtime
      // only takes a key once something actually ran on it.
      // Read here rather than closed over, the same way the active scheme is:
      // this listener is installed once, and an operator who widens the window
      // should not have to reload for the next chord to wait longer.
      prefixTimer = window.setTimeout(forgetPrefix, readNumberSetting('keybinds.prefixWindow'));
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.clearTimeout(prefixTimer);
    };
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
