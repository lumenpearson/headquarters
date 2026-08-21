'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type CSSProperties, useEffect, useMemo, useState } from 'react';
import {
  TerminalButton,
  TerminalInput,
  TerminalMenu,
  TerminalPopover,
  TerminalSelect,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';

import { primaryNavigation } from '@/application/navigation';
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

import { BackgroundVideoLayer, useBackgroundMaterialUrl } from './BackgroundSource';
import { Drawer, Gauge, ProgressBar, SeverityBadge, StatusBadge } from './OpsUi';
import { resolveMotionDurationMs } from './ShellMotion';

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

const routeLabels: Readonly<Record<OperationsRoute, string>> = {
  overview: 'СВОДКА ОПЕРАЦИИ',
  objects: 'РЕЕСТР ОБЪЕКТОВ',
  'object-detail': 'КАРТОЧКА ОБЪЕКТА',
  cases: 'ДЕЛА И ДОСЬЕ',
  'case-detail': 'КАРТОЧКА ДЕЛА',
  map: 'ТАКТИЧЕСКАЯ КАРТА',
  video: 'ВИДЕО / ПРЯМОЙ ЭФИР',
  cameras: 'ЦЕНТР КАМЕР',
  'video-archive': 'ВИДЕОАРХИВ',
  communications: 'ЗАЩИЩЁННАЯ СВЯЗЬ',
  files: 'ФАЙЛЫ',
  archive: 'АРХИВ',
  analytics: 'АНАЛИТИКА',
  reports: 'ОТЧЁТЫ',
  search: 'ГЛОБАЛЬНЫЙ ПОИСК',
  settings: 'НАСТРОЙКИ',
  system: 'СИСТЕМА И РЕСУРСЫ',
  'ui-gallery': 'ВНУТРЕННИЙ UI КАТАЛОГ',
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
  const theme = settingString(personalization.draft.values['themes.id'], 'terminal-red');
  const density = settingString(personalization.draft.values['layout.density'], 'dense');
  const background = settingString(
    personalization.draft.values['backgrounds.kind'],
    'terminal-grid',
  );
  const focusPattern = settingString(personalization.draft.values['patterns.focus'], 'brackets');
  const backgroundImageSource = settingString(
    personalization.draft.values['backgrounds.imageSource'],
    '',
  );
  const backgroundVideoSource = settingString(
    personalization.draft.values['backgrounds.videoSource'],
    '',
  );
  const typographyScale = settingNumber(personalization.draft.values['typography.scale'], 1);
  const sizeScale = settingNumber(personalization.draft.values['sizes.scale'], 1);
  const styleMode = settingString(personalization.draft.values['styles.mode'], 'strict-terminal');
  const accent = settingString(personalization.draft.values['colors.accent'], 'orange');
  const animationIntensity = settingNumber(
    personalization.draft.values['animations.intensity'],
    0.65,
  );
  const draftAnimations = settingBoolean(personalization.draft.values['animations.enabled'], true);
  const reducedMotion = settingBoolean(
    personalization.draft.values['accessibility.reducedMotion'],
    false,
  );

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

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('production') === '1') {
      toggleProductionPanel(true);
    }
  }, [toggleProductionPanel]);

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

  return (
    <div
      className={`ops-shell ${compact ? 'ops-shell--compact' : ''} ${production.cameraSafe ? 'ops-shell--camera-safe' : ''} ${motionAllowed ? '' : 'ops-shell--no-motion'} ops-cursor--${production.cursorMode}`}
      data-transport="grpc-web"
      data-context-menu="shell"
      data-theme={theme}
      data-layout-density={density}
      data-background-kind={background}
      data-background-image={backgroundImageUrl === null ? 'none' : 'material'}
      data-focus-pattern={focusPattern}
      data-style-mode={styleMode}
      data-accent={accent}
      onPointerDownCapture={disableAutoDemo}
      style={
        {
          '--ops-type-scale': Math.min(1.25, Math.max(0.85, typographyScale * sizeScale)),
          '--ops-motion-duration': `${resolveMotionDurationMs(animationIntensity, editActive)}ms`,
          '--ops-background-duration': `${Math.round(30_000 - animationIntensity * 18_000)}ms`,
          // Quoted: an object URL is machine-made, but url() without quotes is
          // a place where a stray character would become syntax.
          ...(backgroundImageUrl === null
            ? {}
            : { '--ops-background-source': `url("${backgroundImageUrl}")` }),
        } as CSSProperties
      }
    >
      {backgroundVideoUrl === null ? null : (
        <BackgroundVideoLayer source={backgroundVideoUrl} paused={!motionAllowed} />
      )}
      <pre className="ops-shell__ascii" aria-hidden="true">
        {asciiSignalField}
      </pre>
      <div className="ops-shell__frame" aria-hidden="true" />
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

function settingString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function settingNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function settingBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function OpsTopBar({ route }: { readonly route: OperationsRoute }) {
  const operation = useOperationsStore((state) => state.operation);
  const production = useOperationsStore((state) => state.production);
  const activeAlerts = useOperationsStore((state) =>
    Object.values(state.alerts).filter((alert) => alert.lifecycle !== 'RESOLVED'),
  );
  const openDrawer = useOperationsStore((state) => state.openDrawer);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (production.paused) return;
    const intervalId = window.setInterval(
      () => setElapsed((value) => value + production.clockSpeed),
      1000,
    );
    return () => window.clearInterval(intervalId);
  }, [production.clockSpeed, production.paused]);

  const clock = useMemo(() => {
    if (production.clockMode === 'real') {
      return new Intl.DateTimeFormat('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).format(new Date());
    }
    const parts = production.fixedTime.split(':').map(Number);
    const seconds =
      ((parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) + elapsed) % 86_400;
    return [Math.floor(seconds / 3600), Math.floor((seconds % 3600) / 60), Math.floor(seconds % 60)]
      .map((part) => String(part).padStart(2, '0'))
      .join(':');
  }, [elapsed, production.clockMode, production.fixedTime]);

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
        <small>
          {operation.code} / ФАЗА {operation.currentPhase}
        </small>
      </div>
      <div className="ops-topbar__metadata">
        <span>
          <small>ДАТА</small>
          <b>12.09.2026 / СБ</b>
        </span>
        <span>
          <small>СЕКТОР</small>
          <b>S-03 / ТУ</b>
        </span>
        <span>
          <small>СЕССИЯ</small>
          <b>{production.screenId} / ОП-01</b>
        </span>
        <span>
          <small>ДОПУСК</small>
          <b>АЛЬФА / А1</b>
        </span>
        <span className="is-secure">
          <small>СВЯЗЬ</small>
          <b>ЗАЩИЩЕНА</b>
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
        {primaryNavigation.map(([id, href, key, label]) => {
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
  const metrics = useOperationsStore((state) => state.metrics);
  const alerts = useOperationsStore((state) => state.alerts);
  const bus = typeof BroadcastChannel === 'undefined' ? 'FALLBACK' : 'BROADCAST';
  return (
    <footer className="ops-statusline">
      <strong>[ SYSTEM:READY ]</strong>
      <span>~/{route}</span>
      <span>CPU {metrics.cpu}%</span>
      <span>RAM {metrics.ram}%</span>
      <span>
        NET {metrics.networkIn}/{metrics.networkOut}
      </span>
      <TransportProbe bus={bus} />
      <span>AL:{Object.values(alerts).filter((alert) => alert.lifecycle === 'NEW').length}</span>
      <span>UTF-8</span>
      <span>F:FULL ^K:SEARCH ^⇧P:PROD</span>
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
 */
function TransportProbe({ bus }: { readonly bus: string }) {
  const screenId = useOperationsStore((state) => state.production.screenId);
  return (
    <TerminalPopover
      side="top"
      title="ТРАНСПОРТ СЕССИИ"
      description="Чем этот экран синхронизируется с остальными"
      trigger={
        <TerminalButton className="ops-statusline__probe" aria-label="Подробности транспорта">
          BUS:{bus} RPC:GRPC-WEB
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
          <dd>Не подключена — R27, фича F10</dd>
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
        <p>{event.description}</p>
        <dl className="ops-definition-list">
          <div>
            <dt>ВРЕМЯ</dt>
            <dd>{formatDateTime(event.timestamp)}</dd>
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

function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value));
}
