'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useBooleanSetting } from '@/application/personalization/useSetting';
import { useOperationsStore } from '@/state/operationsStore';

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
  const startupComplete = useOperationsStore((state) => state.ui.startupComplete);
  // Ctrl+/ still opens it either way: this decides the automatic offer on a
  // first launch, not whether the card exists. `startupComplete` keeps the
  // automatic offer off the boot readout -- without it, a first-ever launch
  // opens this card at the same instant StartupSequence starts painting.
  const open = overridden ?? (introOnLaunch && !seen && startupComplete);

  const cardRef = useRef<HTMLDivElement | null>(null);

  /*
   * The card now appears asynchronously -- gated on `startupComplete`, which
   * fires off an arbitrary timer -- rather than always being present at first
   * paint, so an operator can already be focused somewhere else when it
   * mounts. Move focus onto the card the way any modal dialog would, and hand
   * it back to whatever held it beforehand once the card closes.
   * `document.contains` guards the previously-focused element having left the
   * document in the meantime (a screen change while the card was open).
   */
  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cardRef.current?.focus();
    return () => {
      if (previouslyFocused !== null && document.contains(previouslyFocused)) {
        previouslyFocused.focus();
      }
    };
  }, [open]);

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
    <div
      // Blur reads `--ops-overlay-blur` (`popups.overlayBlur`) through the same
      // compound arbitrary-value form `terminalOverlayStyles.ts` uses for the
      // dialog/drawer backdrops, rather than a literal Tailwind utility the
      // setting could never reach; the `16px` fallback matches the setting's
      // own default.
      // Overscroll containment on the backdrop: a card taller than the
      // viewport must not chain its scroll into the page underneath it.
      className="keybind-intro fixed inset-0 z-[var(--z-dialog)] grid place-items-center overscroll-contain [backdrop-filter:blur(var(--ops-overlay-blur,16px))_saturate(90%)] bg-[color-mix(in_srgb,var(--bg-0)_62%,transparent)]"
      role="dialog"
      aria-modal="true"
      aria-label="Сочетания клавиш"
    >
      <div
        ref={cardRef}
        // Programmatic focus target, not a tab stop of its own: `-1` keeps it
        // out of the normal tab order while still letting `.focus()` land here.
        tabIndex={-1}
        className="keybind-intro__card grid grid-rows-[auto_minmax(0,1fr)_auto] gap-hq-3 w-[min(760px,92vw)] max-h-[82dvh] p-hq-4 border border-hq-accent bg-hq-panel-raised outline-none"
      >
        <header className="flex gap-hq-2 items-baseline justify-between text-hq-accent text-hq-xs tracking-[0.12em]">
          <strong>СОЧЕТАНИЯ КЛАВИШ</strong>
          <span className="text-hq-text-2 tracking-[0.04em]">
            Нажмите любое — строка подсветится
          </span>
        </header>
        <KeybindList />
        <footer className="flex justify-end">
          <TerminalButton onClick={dismiss}>ПОНЯТНО</TerminalButton>
        </footer>
      </div>
    </div>
  );
}
