'use client';

import { TerminalButton } from '@gremuchaya/ui/primitives';
import { titlebarElements, type TitlebarElement } from '@gremuchaya/settings-schema';
import { useEffect, useState, type ReactNode } from 'react';

import { useShellClock } from '@/application/dateTime';
import { routeLabels } from '@/application/navigation';
import { useStringListSetting, useStringSetting } from '@/application/personalization/useSetting';
import { connectionModeToken, realtimeStatusToken } from '@/application/sync/connection';
import { linkStatusTokens } from '@/application/sync/controlPlaneLinks';
import {
  applyWindowCorners,
  readHostWindowProfile,
  webHostWindowProfile,
  type HostWindowProfile,
} from '@/infrastructure/tauri/hostWindowProfile';
import {
  closeWindow,
  isWindowMaximized,
  minimizeWindow,
  toggleMaximizeWindow,
} from '@/infrastructure/tauri/nativeWindowControls';
import { useOperationsStore, type OperationsRoute } from '@/state/operationsStore';

/** The same name the window carries in `tauri.conf.json` and in the metadata. */
const productTitle = 'ГРЕМУЧАЯ СМЕСЬ — ОПЕРАТИВНЫЙ ШТАБ';

/**
 * The application's own title bar (R24, R25).
 *
 * The `control` window is created with `decorations: false`, so this row is the
 * whole window chrome: the drag region, the three window commands, and the room
 * R25 asks to be left for something useful. It is the shell's first grid row
 * rather than an overlay, because a bar drawn over the workspace would take its
 * height from nothing and R26 bounds the workspace by what is left of the
 * window.
 *
 * Windows 11 and Windows 10 get the same bar. The only difference R24 allows
 * between them is the window's corners, and those are DWM's -- asked for by
 * `apply_window_corners` and never redrawn here. Vista through 8.1 classify as
 * `legacy` and are told not to round by that same call, so the square window is
 * the same code path with one argument changed.
 *
 * The web build renders the bar identically and its controls do nothing: a
 * browser owns its own chrome, `isTauri()` is false, and every native call
 * returns without reaching an IPC bridge that is not there.
 */
export function TitleBar({ route }: { readonly route: OperationsRoute }) {
  const profile = useHostWindowProfile();
  const maximized = useWindowMaximized();
  const elements = useStringListSetting('titlebar.elements');
  const information = useStringSetting('titlebar.information');
  const dragRegion = useStringSetting('titlebar.dragRegion');

  // `full` drags from the bar itself and from everything that is not a control;
  // `title` narrows the region to the name alone, which is what an operator who
  // keeps hitting the wrong thing on a touch monitor asks for.
  const dragsBar = dragRegion === 'full';
  const dragsTitle = dragRegion === 'full' || dragRegion === 'title';

  return (
    <header
      className="ops-titlebar"
      data-host-family={profile.family}
      data-drag-region={dragRegion}
      {...(dragsBar ? { 'data-tauri-drag-region': true } : {})}
    >
      {orderedElements(elements).map((element) => {
        switch (element) {
          case 'title':
            return (
              <span
                key={element}
                className="ops-titlebar__title"
                data-titlebar-element="title"
                {...(dragsTitle ? { 'data-tauri-drag-region': true } : {})}
              >
                {productTitle}
              </span>
            );
          case 'information':
            return information === 'none' ? null : (
              <span
                key={element}
                className="ops-titlebar__information"
                data-titlebar-element="information"
                data-titlebar-information={information}
                {...(dragsBar ? { 'data-tauri-drag-region': true } : {})}
              >
                <TitleBarInformation kind={information} route={route} />
              </span>
            );
          case 'minimize':
            return (
              <WindowControl
                key={element}
                element="minimize"
                label="Свернуть окно"
                glyph="—"
                onActivate={minimizeWindow}
              />
            );
          case 'maximize':
            return (
              <WindowControl
                key={element}
                element="maximize"
                label={maximized ? 'Восстановить окно' : 'Развернуть окно'}
                glyph={maximized ? '❐' : '□'}
                onActivate={toggleMaximizeWindow}
              />
            );
          case 'close':
            return (
              <WindowControl
                key={element}
                element="close"
                label="Закрыть окно"
                glyph="✕"
                onActivate={closeWindow}
              />
            );
        }
      })}
    </header>
  );
}

/**
 * The roster the operator arranged, with anything the schema would not name
 * dropped.
 *
 * The validator already refuses an unknown entry on the way into the draft, so
 * this only has to survive a blob persisted by an older build -- the same
 * reason `resolveSettingValue` falls back to the schema's own default rather
 * than to a literal at the call site.
 */
function orderedElements(elements: readonly string[]): readonly TitlebarElement[] {
  return elements.filter((element): element is TitlebarElement =>
    (titlebarElements as readonly string[]).includes(element),
  );
}

/**
 * One window command.
 *
 * `TerminalButton` and not a plain box: the bar is reachable by keyboard, and
 * the split alignment picks the first control out of the row with
 * `button:first-of-type`, which only holds while every control is a button and
 * nothing else in the bar is.
 */
function WindowControl({
  element,
  label,
  glyph,
  onActivate,
}: {
  readonly element: TitlebarElement;
  readonly label: string;
  readonly glyph: string;
  readonly onActivate: () => Promise<void>;
}) {
  return (
    <TerminalButton
      className="ops-titlebar__control"
      data-titlebar-element={element}
      aria-label={label}
      title={label}
      onClick={() => {
        void onActivate().catch((error: unknown) => {
          // A window command the shell was not granted, or a window that is
          // already gone. There is no operator action behind either, and the
          // bar has to stay drawn.
          console.warn(`titlebar: ${element} was refused`, error);
        });
      }}
    >
      <b aria-hidden="true">{glyph}</b>
    </TerminalButton>
  );
}

/**
 * What the information slot reports (R25's "room for useful information").
 *
 * One component per source rather than one component reading all four: the
 * clock re-renders every second through the shared tick, and a slot showing the
 * route would otherwise pay for a subscription it never reads.
 */
function TitleBarInformation({
  kind,
  route,
}: {
  readonly kind: string;
  readonly route: OperationsRoute;
}): ReactNode {
  switch (kind) {
    case 'clock':
      return <ClockReading />;
    case 'operation':
      return <OperationReading />;
    case 'connection':
      return <ConnectionReading />;
    case 'route':
      return routeLabels[route];
    default:
      return null;
  }
}

function ClockReading() {
  const clock = useShellClock();
  return <>{clock}</>;
}

function OperationReading() {
  const operation = useOperationsStore((state) => state.operation);
  return (
    <>
      {operation.code} / ФАЗА {operation.currentPhase}
    </>
  );
}

function ConnectionReading() {
  const connection = useOperationsStore((state) => state.connection);
  // One token rather than two adjacent expressions, so the slash between the
  // mode and the links cannot be lost to JSX whitespace collapsing -- the same
  // reason the status line's transport probe composes it in one string. The
  // links are a set since F14 stage 7: `ONLINE/LIVE+POLL` is a screen holding
  // the plane on the set's LAN and the one on the internet at once.
  const token = `${connectionModeToken(connection.mode)}/${linkStatusTokens(connection.links, realtimeStatusToken)}`;
  return <>{token}</>;
}

/**
 * Which Windows generation this is, and the corner treatment that follows.
 *
 * Read once, on mount: the kernel build cannot change while the process runs,
 * and `apply_window_corners` is what R24 spends the answer on. The state is
 * kept as well so the bar can carry the family as an attribute -- a screenshot
 * from a shoot machine then says which host it was taken on, which is the
 * question nobody can answer afterwards.
 */
function useHostWindowProfile(): HostWindowProfile {
  const [profile, setProfile] = useState<HostWindowProfile>(webHostWindowProfile);
  useEffect(() => {
    let cancelled = false;
    void readHostWindowProfile()
      .then(async (next) => {
        if (cancelled) return;
        setProfile(next);
        // `rounded` is true only for win11. Windows 10 and legacy hosts are
        // told not to round through the same call, which is what makes the
        // square window one argument rather than a second code path.
        await applyWindowCorners(next.rounded);
      })
      .catch((error: unknown) => {
        // The bar is drawn either way; only the corner treatment is lost, and
        // there is no operator action behind it.
        console.warn('titlebar: the host window profile is unavailable', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return profile;
}

/**
 * Whether the window is maximized, so the button can offer restore instead.
 *
 * The webview is resized whenever the native window is, so the DOM `resize`
 * event is the signal -- no Tauri event subscription, and the same code answers
 * in a browser, where `isWindowMaximized` reports `false` because a tab is not
 * a maximized window.
 */
function useWindowMaximized(): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const read = (): void => {
      void isWindowMaximized()
        .then((value) => {
          if (!cancelled) setMaximized(value);
        })
        .catch(() => {
          // Keep the last reading rather than claiming the window was restored.
        });
    };
    read();
    window.addEventListener('resize', read);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', read);
    };
  }, []);
  return maximized;
}
