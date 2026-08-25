'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useBooleanSetting } from '@/application/personalization/useSetting';

import { KeybindList } from './KeybindList';
import { useKeybind } from './KeybindRuntime';

export const keybindIntroStorageKey = 'hq.keybinds-intro-seen.v1';

/*
 * Read through `useSyncExternalStore` rather than an effect. localStorage is
 * external state, and this is the hook built for reading it: the server
 * snapshot keeps the first render deterministic, and the client re-reads after
 * hydration without the mismatch that writing the same value from an effect
 * would produce.
 */
function subscribeToSeenFlag(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

function readSeenFlag(): boolean {
  try {
    return window.localStorage.getItem(keybindIntroStorageKey) !== null;
  } catch {
    // Storage blocked. Treating it as seen keeps the application usable and
    // simply costs the operator the first-launch card.
    return true;
  }
}

/**
 * R11: the keybind list on first launch, and on demand from anywhere after.
 *
 * "First launch" here is first ever, not every process start -- deliberately
 * unlike the startup sequence, which was asked to replay on each launch. A card
 * that reappeared every morning of a shoot would be something to dismiss rather
 * than something to read, so this one remembers being seen.
 *
 * It stays reachable: the same list lives in settings, and Ctrl+/ reopens this
 * card wherever the operator is.
 */
export function KeybindIntro() {
  const seen = useSyncExternalStore(
    subscribeToSeenFlag,
    readSeenFlag,
    // Server render: no storage to read, so draw nothing and let the client
    // decide once it can.
    () => true,
  );
  const [overridden, setOverridden] = useState<boolean | null>(null);
  const introOnLaunch = useBooleanSetting('keybinds.introOnLaunch');
  // Ctrl+/ still opens it either way: this decides the automatic offer on a
  // first launch, not whether the card exists.
  const open = overridden ?? (introOnLaunch && !seen);

  useKeybind(
    'keybinds.list',
    useCallback(() => setOverridden(!open), [open]),
  );

  const dismiss = () => {
    setOverridden(false);
    try {
      window.localStorage.setItem(keybindIntroStorageKey, new Date().toISOString());
    } catch {
      // Nothing to recover: the card simply offers itself again next launch.
    }
  };

  if (!open) return null;

  return (
    <div className="keybind-intro" role="dialog" aria-label="Сочетания клавиш">
      <div className="keybind-intro__card">
        <header>
          <strong>СОЧЕТАНИЯ КЛАВИШ</strong>
          <span>Нажмите любое — строка подсветится</span>
        </header>
        <KeybindList />
        <footer>
          <TerminalButton onClick={dismiss}>ПОНЯТНО</TerminalButton>
        </footer>
      </div>
    </div>
  );
}
