'use client';

import { useEffect, useState } from 'react';

import { useActiveKeybinds } from '@/application/keybinds/activeScheme';
import { groupKeybinds, keybindCategoryLabel } from '@/application/keybinds/grouping';
import { formatChord } from '@/application/keybinds/match';

import { useTranslate } from '@/application/localization/locale';
import { useNumberSetting, useStringListSetting } from '@/application/personalization/useSetting';

import { subscribeKeybindFired } from './KeybindRuntime';

/**
 * How long a row stays lit after its keybind fires. Long enough to notice on a
 * glance, short enough that two presses read as two.
 */

/**
 * R11: the list of every application-wide keybind, lighting up as they are
 * pressed.
 *
 * Built from the registry rather than written out, so a keybind cannot exist
 * without appearing here and cannot appear here without existing. The
 * highlight is what makes it a reference an operator can check against rather
 * than a table they have to trust.
 *
 * The chords are the ones `keybinds.scheme` currently selects. This list is
 * where the keyboard is learned -- it is the first thing the application shows
 * on first launch -- so printing the default collection's chords beside
 * another collection's behaviour would teach the wrong keys to the one
 * operator who reads it.
 */
export function KeybindList() {
  const keybinds = useActiveKeybinds();
  // The subscription behind every label below, including the category headings
  // `keybindCategoryLabel` resolves through the same catalogue.
  const translate = useTranslate();
  const [firedId, setFiredId] = useState<string | null>(null);
  const highlightMs = useNumberSetting('keybinds.firedHighlight');
  const hiddenCategories = useStringListSetting('keybinds.hiddenCategories');

  useEffect(() => {
    let timer = 0;
    const unsubscribe = subscribeKeybindFired((id) => {
      setFiredId(id);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFiredId(null), highlightMs);
    });
    return () => {
      window.clearTimeout(timer);
      unsubscribe();
    };
    // Re-subscribed when the duration moves, so a highlight set after the
    // change is held for the new time rather than the one this closed over.
  }, [highlightMs]);

  return (
    <div className="keybind-list grid gap-hq-3 min-h-0">
      {groupKeybinds(keybinds)
        .filter((group) => !hiddenCategories.includes(group.category))
        .map((group) => (
          <section key={group.category} className="keybind-list__group">
            <h4 className="m-0 mb-hq-1 text-hq-accent text-hq-xs tracking-[0.14em]">
              {keybindCategoryLabel(group.category)}
            </h4>
            <ul className="m-0 p-0 list-none">
              {group.keybinds.map((keybind) => (
                <li
                  key={keybind.id}
                  className="keybind-list__row group grid grid-cols-[minmax(120px,max-content)_minmax(0,1fr)] gap-hq-2 items-baseline py-[2px] px-[4px] border-l border-l-transparent data-[fired=true]:border-l-hq-accent data-[fired=true]:bg-[color-mix(in_srgb,var(--accent)_14%,transparent)]"
                  data-fired={firedId === keybind.id ? 'true' : 'false'}
                >
                  <kbd className="border border-hq-line-2 py-[1px] px-[6px] text-hq-text-1 [font-family:inherit] [line-height:inherit] text-hq-xs whitespace-nowrap group-data-[fired=true]:border-hq-accent group-data-[fired=true]:text-hq-accent">
                    {formatChord(keybind.chord)}
                  </kbd>
                  <span>{translate(keybind.descriptionId, keybind.descriptionParams)}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}
