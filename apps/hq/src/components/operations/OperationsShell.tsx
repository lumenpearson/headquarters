'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type CSSProperties, Fragment, type ReactNode, useEffect, useMemo } from 'react';
import {
  getSettingDefinition,
  statuslineElements,
  type StatuslineElement,
} from '@gremuchaya/settings-schema';
import {
  TerminalButton,
  TerminalInput,
  TerminalMenu,
  TerminalPopover,
  TerminalSelect,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';

import {
  dateTimeModeLabel,
  useDateTimeMode,
  useShellClock,
  useShellDate,
} from '@/application/dateTime';
import { useActiveKeybinds } from '@/application/keybinds/activeScheme';
import { formatChord } from '@/application/keybinds/match';
import { primaryNavigation, routeLabels } from '@/application/navigation';
import {
  booleanSetting,
  numberSetting,
  stringSetting,
} from '@/application/personalization/settingValue';
import { useStringListSetting } from '@/application/personalization/useSetting';
import { contextMenuFor } from '@/application/contextMenus/registry';
import {
  buildContextMenuItems,
  useContextMenuAction,
  useMenuOwners,
} from '@/components/contextMenus/ContextMenuRuntime';
import { subscribeKeybind, useKeybind } from '@/components/keybinds/KeybindRuntime';
import { AnalyticsScreen } from '@/screens/AnalyticsScreen';
import { ArchiveScreen } from '@/screens/ArchiveScreen';
import { CasesScreen } from '@/screens/CasesScreen';
import { CommunicationsScreen } from '@/screens/CommunicationsScreen';
import { FilesScreen } from '@/screens/FilesScreen';
import { ObjectsScreen } from '@/screens/ObjectsScreen';
import { OverviewScreen } from '@/screens/OverviewScreen';
import { ReportsScreen } from '@/screens/ReportsScreen';
import { SearchScreen } from '@/screens/SearchScreen';
import { SettingsScreen } from '@/screens/SettingsScreen';
import { SystemScreen } from '@/screens/SystemScreen';
import { TacticalMapScreen } from '@/screens/TacticalMapScreen';
import { UiGalleryScreen } from '@/screens/UiGalleryScreen';
import { VideoScreen } from '@/screens/VideoScreen';
import { operationsStore, type OperationsRoute, useOperationsStore } from '@/state/operationsStore';

import {
  resolvePresentation,
  type ResolvedPresentation,
} from '@/application/personalization/presentation';
import {
  authorityModeLabel,
  connectionModeLabel,
  connectionModeToken,
  realtimeStatusLabel,
  realtimeStatusToken,
  systemReadinessToken,
} from '@/application/sync/connection';
import { linkStatusTokens } from '@/application/sync/controlPlaneLinks';

import { EditableContent } from '@/components/edit/EditableContent';
import { TitleBar } from '@/components/shell/TitleBar';

import { BackgroundVideoLayer, useBackgroundMaterialUrl } from './BackgroundSource';
import { Drawer, Gauge, ProgressBar, SeverityBadge, StatusBadge } from './OpsUi';
import { resolveMotionDurationMs } from './ShellMotion';
import { clearanceReadout, secureLinkReadout, sectorFocus } from './TopBarReadouts';

const routePaths: Readonly<Partial<Record<OperationsRoute, string>>> = {
  overview: '/overview',
  objects: '/objects',
  cases: '/cases',
  map: '/map',
  video: '/video',
  cameras: '/video/cameras',
  'video-archive': '/video/archive',
  communications: '/communications',
  files: '/files',
  archive: '/archive',
  analytics: '/analytics',
  reports: '/reports',
  search: '/search',
  settings: '/settings',
  system: '/system',
  'ui-gallery': '/dev/ui',
};

const productionPresets = [
  'NORMAL',
  'ACTIVE_OPERATION',
  'ALERT',
  'CRITICAL',
  'VIDEO_FOCUS',
  'MAP_TRACKING',
  'CASE_DOSSIER',
  'SYSTEM_WARNING',
  'CLEAN_IDLE',
] as const;

const productionPresetOptions = productionPresets.map((preset) => ({
  value: preset,
  label: preset,
}));

const clockSpeedOptions = [
  { value: '0.5', label: '0.5×' },
  { value: '1', label: '1×' },
  { value: '2', label: '2×' },
  { value: '5', label: '5×' },
] as const;

const monitorOptions = ['MON-01', 'MON-02', 'MON-03', 'MON-04', 'MON-05', 'MON-06'].map((id) => ({
  value: id,
  label: id,
}));

const cursorOptions = [
  { value: 'visible', label: 'VISIBLE' },
  { value: 'auto', label: 'AUTO HIDE' },
  { value: 'hidden', label: 'HIDDEN' },
] as const;

const asciiSignalField = String.raw`
   .--.      /\      0101::A1      .---.       //////////////
  / /\ \  _/  \_   [SECURE]     /  _  \      ::: NODE 042
 < <  > >|_    _|  .-.-.-.-.   |  / \  |     0x7F 0x2A 0x11
  \ \/ /   |  |   /_/|_|\_\    \  \_/  /     ----- SIGNAL ----
   '--'    /_/\_\  :: MESH ::     '---'       1010100011101001
       _.-'      '-._        _..---.._        /\ /\ /\ /\ /\
  _.-'  S-03 / ACTIVE  '-._.'  GRPC-WEB '._   || || || || ||
 /__OBJECT__CASE__VIDEO__MAP__COMMS__FILES__\  [LOCAL-FIRST]
`;

export function OperationsShell({
  route,
  entityId,
}: {
  readonly route: OperationsRoute;
  readonly entityId?: string;
}) {
  const router = useRouter();
  const compact = useOperationsStore((state) => state.ui.navCompact);
  const production = useOperationsStore((state) => state.production);
  const toggleProductionPanel = useOperationsStore((state) => state.toggleProductionPanel);
  const closeDrawer = useOperationsStore((state) => state.closeDrawer);
  const setRoute = useOperationsStore((state) => state.setRoute);
  const selectObject = useOperationsStore((state) => state.selectObject);
  const selectCase = useOperationsStore((state) => state.selectCase);
  const personalization = useOperationsStore((state) => state.personalization);
  const editActive = useOperationsStore((state) => state.edit.active);
  // Every setting that becomes an attribute or a custom property comes from one
  // table, so a new one is added by declaring it rather than by editing this
  // JSX — and a definition that reaches nothing is caught by a test instead of
  // by a hand recount (C20, C31).
  const presentation = useMemo(
    () => resolvePresentation(personalization.draft.values),
    [personalization.draft.values],
  );
  const values = personalization.draft.values;
  const background = stringSetting(values, 'backgrounds.kind');
  const backgroundImageSource = stringSetting(values, 'backgrounds.imageSource');
  const backgroundVideoSource = stringSetting(values, 'backgrounds.videoSource');
  const animationIntensity = numberSetting(values, 'animations.intensity');
  const draftAnimations = booleanSetting(values, 'animations.enabled');
  const reducedMotion = booleanSetting(values, 'accessibility.reducedMotion');

  // Only the selected kind resolves a material; the other resolves nothing.
  const backgroundImageUrl = useBackgroundMaterialUrl(
    background === 'image' ? backgroundImageSource : '',
  );
  const backgroundVideoUrl = useBackgroundMaterialUrl(
    background === 'video' ? backgroundVideoSource : '',
  );
  const motionAllowed = production.animations && draftAnimations && !reducedMotion;

  useEffect(() => {
    setRoute(route);
    if (entityId !== undefined) {
      if (route === 'object-detail') selectObject(entityId);
      if (route === 'case-detail') selectCase(entityId);
    }
  }, [entityId, route, selectCase, selectObject, setRoute]);

  const openProductionPanelOnStart = booleanSetting(values, 'startup.productionPanel');
  useEffect(() => {
    // The query parameter is a one-off; the setting is the operator's standing
    // answer. An operator's own machine wants the panel every launch, a wall
    // never does.
    if (
      openProductionPanelOnStart ||
      new URLSearchParams(window.location.search).get('production') === '1'
    ) {
      toggleProductionPanel(true);
    }
  }, [openProductionPanelOnStart, toggleProductionPanel]);

  // Any keypress means the operator has taken over. Activity detection, not a
  // keybind: it reacts to every key, including the ones nothing is bound to,
  // so it stays a listener of its own rather than an entry in the registry.
  useEffect(() => {
    const handler = () => {
      if (operationsStore.getState().production.autoDemo) {
        operationsStore.getState().setProductionOption('autoDemo', false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  useKeybind('shell.search', () => router.push('/search'));
  // Claimed once for the whole shell rather than per screen: taking an
  // identifier to the global search is the same act wherever the row lives.
  useContextMenuAction('record.search', (subject) => {
    if (subject === undefined) return;
    operationsStore.getState().setSearchQuery(subject);
    router.push('/search');
  });
  useKeybind('shell.productionPanel', () => toggleProductionPanel());
  useKeybind('shell.dismiss', () => {
    closeDrawer();
    toggleProductionPanel(false);
  });
  useKeybind('shell.fullscreen', () => {
    if (document.fullscreenElement === null) void document.documentElement.requestFullscreen();
    else void document.exitFullscreen();
  });
  useKeybind('shell.togglePlayback', () => {
    if (route === 'video' || route === 'cameras' || route === 'video-archive') {
      operationsStore.getState().toggleVideo();
    }
  });

  // One effect for the nine numbered routes: the rail draws a badge beside each
  // entry, and the badge is the promise this keeps.
  useEffect(() => {
    const unsubscribes = primaryNavigation
      .slice(0, 9)
      .map((entry) => subscribeKeybind(`navigate.${entry[0]}`, () => router.push(entry[1])));
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [router]);

  const disableAutoDemo = () => {
    if (operationsStore.getState().production.autoDemo) {
      operationsStore.getState().setProductionOption('autoDemo', false);
    }
  };

  // Everything the shell root carries as an inline custom property, kept in
  // one memo so the mirror effect below compares against the same values the
  // shell itself renders rather than recomputing them.
  const shellCustomProperties = useMemo<Record<string, string>>(
    () => ({
      ...presentation.customProperties,
      // The product of the two scale settings, bounded. Typography and
      // element size are separate controls and either alone stays inside
      // the interface; together they can leave it, which R19 asks the
      // bounds to prevent.
      '--ops-type-scale': String(
        Math.min(
          1.25,
          Math.max(
            0.85,
            scaleOf(presentation, '--ops-type-scale-setting') *
              scaleOf(presentation, '--ops-size-scale-setting'),
          ),
        ),
      ),
      '--ops-motion-duration': `${resolveMotionDurationMs(animationIntensity, editActive)}ms`,
      '--ops-background-duration': `${Math.round(30_000 - animationIntensity * 18_000)}ms`,
      // Quoted: an object URL is machine-made, but url() without quotes is
      // a place where a stray character would become syntax.
      ...(backgroundImageUrl === null
        ? {}
        : { '--ops-background-source': `url("${backgroundImageUrl}")` }),
    }),
    [presentation, animationIntensity, editActive, backgroundImageUrl],
  );

  // Base UI portals popups, dialogs, menus and toasts to `document.body`,
  // outside `.ops-shell` in the DOM: a data attribute or a custom property
  // declared only on the shell root never reaches them. Mirroring
  // `data-theme`, `data-accent` and every custom property the shell carries
  // onto `body` is what lets a portalled surface pick up the same palette,
  // the same fluid type scale and the same focus-ring width --
  // `operations.css` keys its `--ops-*` matrices off `body[data-theme=...]` /
  // `body[data-accent=...]` for exactly this reason, and `terminal.css` reads
  // `--ops-focus-ring-width` and `--ops-orange-bright` off `body` directly.
  // The shell element keeps carrying its own copies too, for the CSS
  // structure and for the Playwright locators that key off `.ops-shell`.
  useEffect(() => {
    const body = document.body;
    const theme = presentation.attributes['data-theme'];
    const accent = presentation.attributes['data-accent'];
    if (theme !== undefined) body.setAttribute('data-theme', theme);
    if (accent !== undefined) body.setAttribute('data-accent', accent);
    for (const [property, value] of Object.entries(shellCustomProperties)) {
      body.style.setProperty(property, value);
    }
    return () => {
      if (theme !== undefined) body.removeAttribute('data-theme');
      if (accent !== undefined) body.removeAttribute('data-accent');
      for (const property of Object.keys(shellCustomProperties)) {
        body.style.removeProperty(property);
      }
    };
  }, [presentation.attributes, shellCustomProperties]);

  return (
    <div
      className={`ops-shell ${compact ? 'ops-shell--compact' : ''} ${production.cameraSafe ? 'ops-shell--camera-safe' : ''} ${motionAllowed ? '' : 'ops-shell--no-motion'} ops-cursor--${production.cursorMode}`}
      data-transport="grpc-web"
      data-context-menu="shell"
      {...presentation.attributes}
      data-background-image={backgroundImageUrl === null ? 'none' : 'material'}
      onPointerDownCapture={disableAutoDemo}
      style={shellCustomProperties as CSSProperties}
    >
      {backgroundVideoUrl === null ? null : (
        <BackgroundVideoLayer source={backgroundVideoUrl} paused={!motionAllowed} />
      )}
      <pre className="ops-shell__ascii" aria-hidden="true">
        {asciiSignalField}
      </pre>
      <div className="ops-shell__frame" aria-hidden="true" />
      <TitleBar route={route} />
      <OpsTopBar route={route} />
      <OpsNavigation route={route} />
      <main className="ops-workspace" data-route={route}>
        <ScreenRenderer route={route} {...(entityId === undefined ? {} : { entityId })} />
      </main>
      <OpsStatusLine route={route} />
      <OperationsDrawer />
      <ProductionPanel />
    </div>
  );
}

/** A custom property is a string by the time it reaches the style object. */
function scaleOf(presentation: ResolvedPresentation, property: string): number {
  const parsed = Number(presentation.customProperties[property]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function OpsTopBar({ route }: { readonly route: OperationsRoute }) {
  const operation = useOperationsStore((state) => state.operation);
  const production = useOperationsStore((state) => state.production);
  const sectors = useOperationsStore((state) => state.sectors);
  const connection = useOperationsStore((state) => state.connection);
  const activeAlerts = useOperationsStore((state) =>
    Object.values(state.alerts).filter((alert) => alert.lifecycle !== 'RESOLVED'),
  );
  const openDrawer = useOperationsStore((state) => state.openDrawer);
  // The reading, the tick and the mode all come from `@/application/dateTime`.
  // The clock used to be assembled here from the production slice alone, which
  // is why `dateTime.mode` could be set to `system` or `utc` and the header
  // would go on showing the operation's own time.
  const clock = useShellClock();
  const date = useShellDate();
  const sector = sectorFocus(sectors);
  const clearance = clearanceReadout(connection.session);

  return (
    <header className="ops-topbar">
      <Link href="/overview" className="ops-brand">
        <i aria-hidden="true">◈</i>
        <span>
          <strong>ГРЕМУЧАЯ//MESH</strong>
          <small>OPERATIONS CONTROL / ZERO REST</small>
        </span>
      </Link>
      <div className="ops-topbar__route">
        <span>[ROUTE_INDEX]</span>
        <strong>{routeLabels[route]}</strong>
        {/* Operation and sector are the context `information.showOperationalContext`
            governs. They are marked rather than conditionally rendered so the
            setting changes the shell without remounting the header. */}
        <small data-operational-context="operation">
          {operation.code} / ФАЗА {operation.currentPhase}
        </small>
      </div>
      <div className="ops-topbar__metadata">
        <span data-header-entry="date">
          <small>ДАТА</small>
          <b>{date}</b>
        </span>
        <span data-operational-context="sector">
          <small>СЕКТОР</small>
          <b>{sector === undefined ? '—' : `${sector.code} / ${sector.abbreviation}`}</b>
        </span>
        <span>
          <small>СЕССИЯ</small>
          <b>{production.screenId} / ОП-01</b>
        </span>
        <span>
          <small>ДОПУСК</small>
          <b>
            {clearance.tier} / {clearance.code}
          </b>
        </span>
        <span className="is-secure">
          <small>СВЯЗЬ</small>
          <b>{secureLinkReadout(connection.mode)}</b>
        </span>
        <TerminalButton
          onClick={() => {
            const firstAlert = activeAlerts[0];
            if (firstAlert !== undefined) openDrawer('alert', firstAlert.id);
          }}
          title="Открыть активную тревогу"
        >
          <small>ALERT</small>
          <b>{String(activeAlerts.length).padStart(2, '0')}</b>
        </TerminalButton>
        <ShellCommandsMenu />
      </div>
      <time>
        <strong>{clock}</strong>
        <span>{production.paused ? '[FREEZE]' : `[×${production.clockSpeed}]`}</span>
      </time>
    </header>
  );
}

/**
 * The shell's commands, reachable without knowing the gesture.
 *
 * The same five entries the right button opens, from the same registry: a
 * command that exists only behind a chord and a right click is a command most
 * operators never find. Items are rebuilt when the menu opens rather than on
 * every render, because "can this command run right now" is answered by what
 * is mounted at that moment.
 */
function ShellCommandsMenu() {
  // Subscribed, not read during render: claims are made in effects, so a list
  // built from a plain table read is the list from the first render, when
  // nothing is claimed and every command draws itself disabled.
  const owners = useMenuOwners();
  const definition = contextMenuFor('shell');
  if (definition === undefined) return null;
  const items = buildContextMenuItems(definition, undefined, owners);
  return (
    <TerminalMenu
      label={definition.label}
      items={items}
      side="bottom"
      align="end"
      trigger={
        <TerminalButton className="ops-topbar__commands" aria-label="Команды штаба">
          <small>КОМАНДЫ</small>
          <b>[≡]</b>
        </TerminalButton>
      }
    />
  );
}

function OpsNavigation({ route }: { readonly route: OperationsRoute }) {
  const compact = useOperationsStore((state) => state.ui.navCompact);
  const hiddenRoutes = useStringListSetting('general.hiddenRoutes');
  const toggle = useOperationsStore((state) => state.toggleNavCompact);
  const screenId = useOperationsStore((state) => state.production.screenId);
  return (
    <nav className="ops-nav" aria-label="Основная навигация">
      <TerminalButton
        className="ops-nav__compact"
        onClick={toggle}
        aria-label="Переключить компактную навигацию"
      >
        {compact ? '[+]' : '[−]'}
      </TerminalButton>
      <div>
        {primaryNavigation
          .filter(([id]) => !hiddenRoutes.includes(id) || id === 'settings')
          .map(([id, href, key, label]) => {
            const active =
              route === id ||
              (id === 'objects' && route === 'object-detail') ||
              (id === 'cases' && route === 'case-detail') ||
              (id === 'video' && (route === 'cameras' || route === 'video-archive'));
            return (
              <Link key={id} href={href} className={active ? 'is-active' : ''} title={label}>
                <i>[{key}]</i>
                <span>{label}</span>
              </Link>
            );
          })}
      </div>
      <footer>
        <span>MONITOR</span>
        <strong>{screenId}</strong>
      </footer>
    </nav>
  );
}

function OpsStatusLine({ route }: { readonly route: OperationsRoute }) {
  const router = useRouter();
  const metrics = useOperationsStore((state) => state.metrics);
  const alerts = useOperationsStore((state) => state.alerts);
  const connection = useOperationsStore((state) => state.connection);
  const openDrawer = useOperationsStore((state) => state.openDrawer);
  const elements = useStringListSetting('statusline.elements');
  const bus = typeof BroadcastChannel === 'undefined' ? 'FALLBACK' : 'BROADCAST';
  const mode = useDateTimeMode();
  const clock = useShellClock();
  const keybinds = useActiveKeybinds();
  // The three chords the status line has always advertised, taken from the
  // collection `keybinds.scheme` selected instead of spelled out. They were
  // written here as `F:FULL ^K:SEARCH ^⇧P:PROD`, which stopped being true the
  // moment a scheme moved any of them.
  const hints = [
    ['shell.fullscreen', 'FULL'],
    ['shell.search', 'SEARCH'],
    ['shell.productionPanel', 'PROD'],
  ] as const;
  const hint = hints
    .map(([id, label]) => {
      const keybind = keybinds.find((candidate) => candidate.id === id);
      return keybind === undefined ? undefined : `${formatChord(keybind.chord)} ${label}`;
    })
    .filter((entry): entry is string => entry !== undefined)
    .join(' · ');

  const newAlerts = Object.values(alerts).filter((alert) => alert.lifecycle === 'NEW');
  const cycleDateTimeMode = () => {
    const definition = getSettingDefinition('dateTime.mode');
    if (definition === undefined || definition.editor.kind !== 'enum') return;
    const options = definition.editor.options;
    const next = options[(options.indexOf(mode) + 1) % options.length];
    if (next !== undefined) {
      operationsStore.getState().applySettingsPatch([{ id: 'dateTime.mode', value: next }]);
    }
  };

  /*
   * `statusline.elements` decides which of these are drawn and in what order,
   * the way `titlebar.elements` arranges the bar above. Each entry still
   * declares the verbosity it belongs to, and the shell hides the tiers above
   * the chosen one in CSS, so neither setting can reflow the shell.
   *
   * The readouts that have a destination are buttons rather than inert text:
   * the system badge opens `/system`, the load counters open `/analytics`,
   * the alert counter opens the newest unhandled alert, and the clock cycles
   * `dateTime.mode` through the same enum the settings screen offers.
   *
   * The system badge used to print `SYSTEM:READY` regardless of what this
   * session's connection was doing; `systemReadinessToken` is what it reads
   * now, from the same `connection` slice `TransportProbe` already reports on
   * below.
   */
  const entries: Readonly<Record<StatuslineElement, ReactNode>> = {
    system: (
      <TerminalButton
        className="ops-statusline__action"
        title="Открыть состояние системы"
        onClick={() => router.push('/system')}
      >
        <strong>[ SYSTEM:{systemReadinessToken(connection)} ]</strong>
      </TerminalButton>
    ),
    route: <span>~/{route}</span>,
    cpu: (
      <TerminalButton
        className="ops-statusline__action"
        data-detail="standard"
        title="Открыть аналитику нагрузки"
        onClick={() => router.push('/analytics')}
      >
        CPU {metrics.cpu}%
      </TerminalButton>
    ),
    ram: (
      <TerminalButton
        className="ops-statusline__action"
        data-detail="standard"
        title="Открыть аналитику нагрузки"
        onClick={() => router.push('/analytics')}
      >
        RAM {metrics.ram}%
      </TerminalButton>
    ),
    net: (
      <TerminalButton
        className="ops-statusline__action"
        data-detail="verbose"
        title="Открыть аналитику нагрузки"
        onClick={() => router.push('/analytics')}
      >
        NET {metrics.networkIn}/{metrics.networkOut}
      </TerminalButton>
    ),
    probe: <TransportProbe bus={bus} />,
    alerts: (
      <TerminalButton
        className="ops-statusline__action"
        title="Открыть новую тревогу"
        disabled={newAlerts.length === 0}
        onClick={() => {
          const first = newAlerts[0];
          if (first !== undefined) openDrawer('alert', first.id);
        }}
      >
        AL:{newAlerts.length}
      </TerminalButton>
    ),
    encoding: <span data-detail="verbose">UTF-8</span>,
    /* The marker names which clock this is, because the same digits mean
       different things in the three modes and the header shows only the
       digits. */
    clock: (
      <TerminalButton
        className="ops-statusline__action"
        data-detail="standard"
        title="Переключить режим часов"
        onClick={cycleDateTimeMode}
      >
        <span data-clock-label>{dateTimeModeLabel(mode)}</span> {clock}
      </TerminalButton>
    ),
    hints: (
      <span data-detail="standard" data-keybind-hint>
        {hint}
      </span>
    ),
  };

  const shown = elements.filter((element): element is StatuslineElement =>
    (statuslineElements as readonly string[]).includes(element),
  );

  return (
    <footer className="ops-statusline">
      {shown.map((element) => (
        <Fragment key={element}>{entries[element]}</Fragment>
      ))}
    </footer>
  );
}

/**
 * The transport line, with the detail behind it.
 *
 * `BUS:BROADCAST` and `RPC:GRPC-WEB` were two words standing for the whole
 * answer to "how is this session talking to the others", which is the first
 * question on set when a screen stops following. The popover carries what the
 * words compress -- which bus is in use and why, and what the fallback would
 * be -- without spending a panel on it or sending the operator to another
 * screen.
 *
 * `SYNC:` is the third word, and it is the one that used to lie: the row read
 * "Не подключена — R27, фича F10" whatever the session was doing, because
 * there was no client to ask. It now names the mode the connection is
 * actually in, and the group, authority and clock offset behind it.
 *
 * The mode alone still left one thing unsaid. `SYNC:ONLINE` was printed both
 * by a session with a live realtime socket and by one whose whole contact with
 * the group was a fifteen-second presence poll -- a control plane started
 * without realtime admission serves no socket at all. The link is therefore
 * printed after the mode: `ONLINE/LIVE` follows the group as it moves,
 * `ONLINE/POLL` catches up on a timer, and `ONLINE/RETRY` is between attempts.
 */
function TransportProbe({ bus }: { readonly bus: string }) {
  const screenId = useOperationsStore((state) => state.production.screenId);
  const connection = useOperationsStore((state) => state.connection);
  // One token rather than two adjacent expressions, so the slash between the
  // mode and the link cannot be lost to JSX whitespace collapsing.
  const syncToken = `${connectionModeToken(connection.mode)}/${linkStatusTokens(connection.links, realtimeStatusToken)}`;
  return (
    <TerminalPopover
      side="top"
      title="ТРАНСПОРТ СЕССИИ"
      description="Чем этот экран синхронизируется с остальными"
      trigger={
        <TerminalButton className="ops-statusline__probe" aria-label="Подробности транспорта">
          BUS:{bus} RPC:GRPC-WEB SYNC:{syncToken}
        </TerminalButton>
      }
    >
      <dl className="ops-transport-detail">
        <div>
          <dt>ШИНА ЭКРАНОВ</dt>
          <dd>
            {bus === 'BROADCAST'
              ? 'BroadcastChannel — вкладки одного браузера'
              : 'storage-события — BroadcastChannel недоступен'}
          </dd>
        </div>
        <div>
          <dt>RPC</dt>
          <dd>ConnectRPC поверх бинарного gRPC-Web</dd>
        </div>
        <div>
          <dt>ЭКРАН</dt>
          <dd>{screenId}</dd>
        </div>
        <div>
          <dt>ГРУППОВАЯ СИНХРОНИЗАЦИЯ</dt>
          <dd>
            {connectionModeLabel(connection.mode)}
            {connection.groupName === undefined ? '' : ` — ${connection.groupName}`}
          </dd>
        </div>
        <div>
          <dt>АВТОРИТЕТ</dt>
          <dd>
            {connection.authority === undefined
              ? 'Группа не назначена'
              : authorityModeLabel(connection.authority)}
          </dd>
        </div>
        {/* One row per link, with the address on it. A screen on the set's
            LAN holds the near plane and the cloud plane at once, and the two
            report different things about the same group: which of them is
            carrying, and where each of them answers, is what an operator asks
            when a screen is behind. A session with no group keeps the single
            row the block had before there was a set. */}
        {connection.links.length === 0 ? (
          <div>
            <dt>КАНАЛ СОБЫТИЙ</dt>
            <dd>{realtimeStatusLabel('off')}</dd>
          </div>
        ) : (
          connection.links.map((link) => (
            <div key={link.linkId}>
              <dt>{link.role === 'primary' ? 'СВЯЗЬ · ОСНОВНАЯ' : 'СВЯЗЬ · ЗАПАСНАЯ'}</dt>
              <dd>
                {link.baseUrl}
                {' — '}
                {link.admitted
                  ? realtimeStatusLabel(link.status)
                  : 'ДРУГАЯ БАЗА CONTROL PLANE — НЕ ИСПОЛЬЗУЕТСЯ'}
                {link.lastSequence === 0 ? '' : ` — событие ${link.lastSequence}`}
                {link.resyncCount === 0 ? '' : `, пересинхронизаций ${link.resyncCount}`}
              </dd>
            </div>
          ))
        )}
        <div>
          <dt>ЧАСЫ ГРУППЫ</dt>
          <dd>
            {connection.clock.sampledAt === ''
              ? 'Не измерены'
              : `Сдвиг ${connection.clock.offsetMs} мс, задержка ${connection.clock.latencyMs} мс`}
          </dd>
        </div>
        {/* The third fact of the row, beside the mode and the link: whether
            this screen has a local copy of what the group agreed, and when it
            was last refreshed. Without it `SYNC:OFFLINE` reads the same on a
            screen showing the group's last agreement and on one showing the
            compiled-in constants, which are different states to be in on a
            shoot day. */}
        <div>
          <dt>ЛОКАЛЬНАЯ КОПИЯ</dt>
          <dd>
            {connection.mirror.refreshedAt === ''
              ? 'Нет — значения берутся из сборки'
              : `Обновлена ${formatDateTime(connection.mirror.refreshedAt)}, ревизия ${connection.mirror.revision}`}
          </dd>
        </div>
      </dl>
    </TerminalPopover>
  );
}

function ScreenRenderer({
  route,
  entityId,
}: {
  readonly route: OperationsRoute;
  readonly entityId?: string;
}) {
  switch (route) {
    case 'overview':
      return <OverviewScreen />;
    case 'objects':
      return <ObjectsScreen />;
    case 'object-detail':
      return <ObjectsScreen {...(entityId === undefined ? {} : { detailId: entityId })} />;
    case 'cases':
      return <CasesScreen />;
    case 'case-detail':
      return <CasesScreen {...(entityId === undefined ? {} : { detailId: entityId })} />;
    case 'map':
      return <TacticalMapScreen />;
    case 'video':
      return <VideoScreen mode="live" />;
    case 'cameras':
      return <VideoScreen mode="cameras" />;
    case 'video-archive':
      return <VideoScreen mode="archive" />;
    case 'communications':
      return <CommunicationsScreen />;
    case 'files':
      return <FilesScreen archive={false} />;
    case 'archive':
      return <ArchiveScreen />;
    case 'analytics':
      return <AnalyticsScreen />;
    case 'reports':
      return <ReportsScreen />;
    case 'search':
      return <SearchScreen />;
    case 'settings':
      return <SettingsScreen />;
    case 'system':
      return <SystemScreen />;
    case 'ui-gallery':
      return <UiGalleryScreen />;
  }
}

function OperationsDrawer() {
  const drawer = useOperationsStore((state) => state.ui.drawer);
  const close = useOperationsStore((state) => state.closeDrawer);
  const state = useOperationsStore((value) => value);
  if (drawer === null) return null;
  if (drawer.kind === 'alert') {
    const alert = state.alerts[drawer.id];
    if (alert === undefined) return null;
    return (
      <Drawer title={alert.title} eyebrow={`ALERT / ${alert.id}`} onClose={close}>
        <SeverityBadge severity={alert.level} />
        <dl className="ops-definition-list">
          <div>
            <dt>ИСТОЧНИК</dt>
            <dd>{alert.source}</dd>
          </div>
          <div>
            <dt>СЕКТОР</dt>
            <dd>{alert.sectorId}</dd>
          </div>
          <div>
            <dt>ОБЪЕКТ</dt>
            <dd>{alert.linkedEntityId}</dd>
          </div>
          <div>
            <dt>СТАТУС</dt>
            <dd>{alert.lifecycle}</dd>
          </div>
          <div>
            <dt>КООРДИНАТЫ</dt>
            <dd>
              {alert.coordinates.lat}, {alert.coordinates.lng}
            </dd>
          </div>
        </dl>
        <p>{alert.description}</p>
        <TerminalButton
          tone="primary"
          className="ops-action ops-action--primary"
          onClick={() => state.acknowledgeAlert(alert.id)}
          disabled={alert.lifecycle !== 'NEW'}
        >
          [A] ПОДТВЕРДИТЬ ТРЕВОГУ
        </TerminalButton>
      </Drawer>
    );
  }
  if (drawer.kind === 'event') {
    const event = state.events.find((candidate) => candidate.id === drawer.id);
    if (event === undefined) return null;
    return (
      <Drawer title={event.title} eyebrow={`EVENT / ${event.id}`} onClose={close}>
        <SeverityBadge severity={event.severity} />
        <p>
          <EditableContent field="event.description" entityId={event.id}>
            {event.description}
          </EditableContent>
        </p>
        <dl className="ops-definition-list">
          {/*
           * The card is where an event's fields are edited (R4): the feeds
           * render each event as a button, and a selector cannot sit inside
           * one. The title is repeated here as a row for that reason.
           */}
          <div>
            <dt>НАЗВАНИЕ</dt>
            <dd>
              <EditableContent field="event.title" entityId={event.id}>
                {event.title}
              </EditableContent>
            </dd>
          </div>
          <div>
            <dt>ВРЕМЯ</dt>
            <dd>
              <EditableContent field="event.date" entityId={event.id}>
                {formatDate(event.timestamp)}
              </EditableContent>
              ,&nbsp;
              <EditableContent field="event.time" entityId={event.id}>
                {formatTime(event.timestamp)}
              </EditableContent>
            </dd>
          </div>
          <div>
            <dt>ИСТОЧНИК</dt>
            <dd>{event.source}</dd>
          </div>
          <div>
            <dt>ОБЪЕКТЫ</dt>
            <dd>{event.linkedObjectIds.join(', ')}</dd>
          </div>
          <div>
            <dt>ДЕЛА</dt>
            <dd>{event.linkedCaseIds.join(', ')}</dd>
          </div>
        </dl>
      </Drawer>
    );
  }
  if (drawer.kind === 'task') {
    const task = state.tasks[drawer.id];
    if (task === undefined) return null;
    return (
      <Drawer title={task.title} eyebrow={`TASK / ${task.id}`} onClose={close}>
        <ProgressBar value={task.progress} label={task.direction.toUpperCase()} />
        <p>Связанные объекты: {task.linkedObjectIds.join(', ')}</p>
        <TerminalButton
          tone="primary"
          className="ops-action ops-action--primary"
          onClick={() => state.completeTask(task.id)}
          disabled={task.status === 'completed'}
        >
          [X] ОТМЕТИТЬ ВЫПОЛНЕННЫМ
        </TerminalButton>
      </Drawer>
    );
  }
  if (drawer.kind === 'camera') {
    const camera = state.cameras[drawer.id];
    if (camera === undefined) return null;
    return (
      <Drawer title={camera.location} eyebrow={`CAMERA / ${camera.id}`} onClose={close}>
        <StatusBadge status={camera.status} />
        <dl className="ops-definition-list">
          <div>
            <dt>СИГНАЛ</dt>
            <dd>{camera.signal}%</dd>
          </div>
          <div>
            <dt>ПОТОК</dt>
            <dd>
              {camera.resolution} / {camera.fps} FPS
            </dd>
          </div>
          <div>
            <dt>КОДЕК</dt>
            <dd>{camera.codec}</dd>
          </div>
          <div>
            <dt>UPTIME</dt>
            <dd>{camera.uptime}</dd>
          </div>
        </dl>
        <Gauge value={camera.signal} label="УРОВЕНЬ СИГНАЛА" />
      </Drawer>
    );
  }
  if (drawer.kind === 'route') {
    const tacticalRoute = state.routes[drawer.id];
    if (tacticalRoute === undefined) return null;
    return (
      <Drawer title={tacticalRoute.name} eyebrow={`ROUTE / ${tacticalRoute.id}`} onClose={close}>
        <StatusBadge status={tacticalRoute.status} />
        <ProgressBar value={tacticalRoute.progress} label="ПРОХОЖДЕНИЕ" />
        <dl className="ops-definition-list">
          <div>
            <dt>ДЛИНА</dt>
            <dd>{tacticalRoute.lengthKm} КМ</dd>
          </div>
          <div>
            <dt>ETA</dt>
            <dd>{tacticalRoute.etaMinutes} МИН</dd>
          </div>
          <div>
            <dt>РИСК</dt>
            <dd>{tacticalRoute.risk}%</dd>
          </div>
        </dl>
      </Drawer>
    );
  }
  if (drawer.kind === 'channel') {
    const channel = state.channels[drawer.id];
    if (channel === undefined) return null;
    return (
      <Drawer title={channel.name} eyebrow={`CHANNEL / ${channel.id}`} onClose={close}>
        <StatusBadge status={channel.status} />
        <dl className="ops-definition-list">
          <div>
            <dt>ШИФРОВАНИЕ</dt>
            <dd>{channel.encryption}</dd>
          </div>
          <div>
            <dt>ЗАДЕРЖКА</dt>
            <dd>{channel.latency} MS</dd>
          </div>
          <div>
            <dt>PACKET LOSS</dt>
            <dd>{channel.packetLoss}%</dd>
          </div>
        </dl>
        <pre className="ops-transcript">{channel.transcript.join('\n')}</pre>
      </Drawer>
    );
  }
  if (drawer.kind === 'file') {
    const file = state.attachments[drawer.id];
    if (file === undefined) return null;
    return (
      <Drawer title={file.title} eyebrow={`FILE / ${file.id}`} onClose={close}>
        <StatusBadge status={file.status} />
        <div className={`ops-file-preview ops-file-preview--${file.kind}`}>
          <i>[{file.kind.toUpperCase()}]</i>
          <strong>{file.preview}</strong>
        </div>
        <dl className="ops-definition-list">
          <div>
            <dt>ДОПУСК</dt>
            <dd>{file.classification}</dd>
          </div>
          <div>
            <dt>РАЗМЕР</dt>
            <dd>{file.sizeLabel}</dd>
          </div>
          <div>
            <dt>ТЕГИ</dt>
            <dd>{file.tags.join(', ')}</dd>
          </div>
        </dl>
        <TerminalButton className="ops-action">[+] ПРИКРЕПИТЬ К ДЕЛУ</TerminalButton>
      </Drawer>
    );
  }
  const insight = state.insights[drawer.id];
  if (insight === undefined) return null;
  return (
    <Drawer title={insight.title} eyebrow={`INSIGHT / ${insight.id}`} onClose={close}>
      <SeverityBadge severity={insight.priority} />
      <p>{insight.explanation}</p>
      <p>Связанные объекты: {insight.linkedObjectIds.join(', ')}</p>
    </Drawer>
  );
}

function ProductionPanel() {
  const router = useRouter();
  const state = useOperationsStore((value) => value);
  if (!state.ui.productionPanelOpen) return null;
  return (
    <aside
      className="production-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Панель съёмочного режима"
    >
      <header>
        <div>
          <span>PRODUCTION / LOCAL ONLY</span>
          <strong>УПРАВЛЕНИЕ СЪЁМОЧНЫМ СОСТОЯНИЕМ</strong>
        </div>
        <TerminalButton tone="quiet" onClick={() => state.toggleProductionPanel(false)}>
          [ESC] CLOSE
        </TerminalButton>
      </header>
      <div className="production-panel__grid">
        <section>
          <h3>SCENE PRESET</h3>
          <TerminalSelect
            value={state.production.preset}
            options={productionPresetOptions}
            onValueChange={state.applyPreset}
            label="Сценарный preset"
          />
          <TerminalButton onClick={() => state.resetWorld()}>[R] RESET WORLD</TerminalButton>
        </section>
        <section>
          <h3>CLOCK / SIMULATION</h3>
          <label>
            <span>TIME</span>
            <TerminalInput
              value={state.production.fixedTime}
              onChange={(event) => state.setProductionOption('fixedTime', event.target.value)}
              aria-label="Фиксированное время production"
            />
          </label>
          <label>
            <span>SPEED</span>
            <TerminalSelect
              value={String(state.production.clockSpeed)}
              options={clockSpeedOptions}
              onValueChange={(value) =>
                state.setProductionOption('clockSpeed', Number(value) as 0.5 | 1 | 2 | 5)
              }
              label="Скорость часов"
            />
          </label>
          <TerminalButton
            className={state.production.paused ? 'is-active' : ''}
            onClick={() => state.setProductionOption('paused', !state.production.paused)}
          >
            [SPACE] {state.production.paused ? 'RESUME' : 'FREEZE'}
          </TerminalButton>
        </section>
        <section>
          <h3>CAMERA SAFE</h3>
          <Toggle
            label="CAMERA SAFE MODE"
            checked={state.production.cameraSafe}
            onChange={(value) => state.setProductionOption('cameraSafe', value)}
          />
          <Toggle
            label="ANIMATIONS"
            checked={state.production.animations}
            onChange={(value) => state.setProductionOption('animations', value)}
          />
          <Toggle
            label="AUTO DEMO"
            checked={state.production.autoDemo}
            onChange={(value) => state.setProductionOption('autoDemo', value)}
          />
        </section>
        <section>
          <h3>MONITOR</h3>
          <label>
            <span>SCREEN ID</span>
            <TerminalSelect
              value={state.production.screenId}
              options={monitorOptions}
              onValueChange={(value) => state.setProductionOption('screenId', value)}
              label="Monitor ID"
            />
          </label>
          <label>
            <span>CURSOR</span>
            <TerminalSelect
              value={state.production.cursorMode}
              options={cursorOptions}
              onValueChange={(value) =>
                state.setProductionOption('cursorMode', value as 'visible' | 'auto' | 'hidden')
              }
              label="Cursor mode production"
            />
          </label>
          <TerminalButton
            onClick={() =>
              document.fullscreenElement === null
                ? void document.documentElement.requestFullscreen()
                : void document.exitFullscreen()
            }
          >
            [F] FULLSCREEN / KIOSK
          </TerminalButton>
        </section>
        <section className="production-panel__snapshots">
          <h3>CONTINUITY SNAPSHOTS</h3>
          <TerminalButton
            onClick={() => state.saveSnapshot(`SCENE ${new Date().toLocaleTimeString('ru-RU')}`)}
          >
            [S] СОХРАНИТЬ СОСТОЯНИЕ СЦЕНЫ
          </TerminalButton>
          {state.production.snapshots.map((snapshot) => (
            <article key={snapshot.id}>
              <span>
                <strong>{snapshot.name}</strong>
                <small>{formatDateTime(snapshot.createdAt)}</small>
              </span>
              <TerminalButton
                onClick={() => {
                  state.restoreSnapshot(snapshot.id);
                  router.push(routePaths[snapshot.route] ?? '/overview');
                }}
              >
                RESTORE
              </TerminalButton>
            </article>
          ))}
        </section>
      </div>
    </aside>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
}) {
  return (
    <div className="ops-toggle">
      <TerminalSwitch checked={checked} onCheckedChange={onChange} label={label} />
      <span>{label}</span>
    </div>
  );
}

const dateFormat = new Intl.DateTimeFormat('ru-RU', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});

const timeFormat = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function formatDate(value: string): string {
  return dateFormat.format(new Date(value));
}

function formatTime(value: string): string {
  return timeFormat.format(new Date(value));
}

// The two halves are separate because the event card edits them separately;
// joined the way the single formatter used to print them.
function formatDateTime(value: string): string {
  return `${formatDate(value)}, ${formatTime(value)}`;
}
