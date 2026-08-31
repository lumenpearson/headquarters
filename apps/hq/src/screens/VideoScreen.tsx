'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from 'react';
import {
  isVideoProvider,
  MediaPlayer,
  MediaProvider,
  type MediaPlayerInstance,
  type VideoSrc,
} from '@vidstack/react';
import { TerminalButton, TerminalSelect, TerminalSlider } from '@gremuchaya/ui/primitives';

import { t, useTranslate } from '@/application/localization/locale';
import type { MessageId } from '@/application/localization/messages';
import {
  useBooleanSetting,
  useNumberSetting,
  useStringSetting,
} from '@/application/personalization/useSetting';
import { channelDomain } from '@/application/simulation/simulationCurves';
import { Gauge, Panel, ProgressBar, Sparkline, StatusBadge } from '@/components/operations/OpsUi';
import type { MaterialEntry } from '@/infrastructure/materials/BridgeMaterialClient';
import { useMaterialLibrary } from '@/application/materials/useMaterialLibrary';
import {
  cameraDeclaredRendition,
  originalRendition,
  type MaterialRendition,
} from '@/infrastructure/materials/materialLibrary';
import { openMaterialRendition } from '@/infrastructure/materials/MaterialSource';
import {
  MaterialRenditionMenu,
  type RenditionOutcome,
} from '@/components/operations/MaterialRenditionMenu';
import {
  demoCameraMaterialOption,
  isAssignableCameraMaterial,
  readCameraMaterialAssignments,
  setCameraMaterialAssignment,
  writeCameraMaterialAssignments,
  type CameraMaterialAssignments,
} from '@/infrastructure/media/cameraMaterialAssignments';
import {
  createCameraStreamRegistry,
  queryCameraRegistry,
  type CameraRegistryFilter,
  type CameraRegistrySort,
} from '@/infrastructure/media/cameraStreamRegistry';
import {
  getNativeCameraRetryDelay,
  type NativeCameraRetryProfile,
  startNativeCameraStream,
  stopNativeCameraStream,
  type NativeCameraStream,
} from '@/infrastructure/media/nativeCameraGateway';
import {
  createPlaybackSyncTarget,
  PlaybackSyncCoordinator,
  type PlaybackSyncAction,
  type PlaybackSyncCommand,
  type PlaybackSyncTarget,
} from '@/infrastructure/media/PlaybackSyncCoordinator';
import { RecordPagination } from '@/components/operations/RecordPagination';
import {
  currentGroupRuntime,
  noGroupRuntime,
  subscribeGroupRuntime,
} from '@/components/sync/groupRuntimeHolder';
import { createGroupPlaybackSyncTransport } from '@/infrastructure/controlPlane/GroupPlaybackSyncTransport';
import { playbackLeadForDelivery } from '@/application/sync/groupEventFeed';
import { operationsStore, useOperationsStore } from '@/state/operationsStore';

const playbackRateOptions = [0.5, 1, 1.5, 2, 4].map((rate) => ({
  value: String(rate),
  label: `${rate}×`,
}));

/**
 * What `performance.webcamResolution` asks the machine camera for.
 *
 * Named rather than computed: a resolution is a pair, and a setting that let an
 * operator name one dimension would ask for shapes no camera offers.
 */
const webcamCaptureSizes = {
  '1080p': { width: { ideal: 1920 }, height: { ideal: 1080 } },
  '720p': { width: { ideal: 1280 }, height: { ideal: 720 } },
  '480p': { width: { ideal: 854 }, height: { ideal: 480 } },
} as const;

const cameraFilterMessageIds = [
  { value: 'all', id: 'video.filterAll' },
  { value: 'online', id: 'video.filterOnline' },
  { value: 'alert', id: 'video.filterAlert' },
  { value: 'lost', id: 'overview.metricSignalLost' },
] as const satisfies ReadonlyArray<{ readonly value: string; readonly id: MessageId }>;

const cameraSortMessageIds = [
  { value: 'registry', id: 'video.sortRegistryOrder' },
  { value: 'id', id: 'video.sortId' },
  { value: 'signal', id: 'drawer.signalLevel' },
  { value: 'sector', id: 'field.sector' },
] as const satisfies ReadonlyArray<{ readonly value: string; readonly id: MessageId }>;

interface WebcamSession {
  readonly cameraId: string;
  readonly stream: MediaStream;
}

type WebcamState = 'idle' | 'requesting' | 'active' | 'denied' | 'unavailable' | 'ended';
type MaterialCatalogState = 'loading' | 'ready' | 'unavailable';
type MaterialSourceState = 'idle' | 'loading' | 'ready' | 'missing' | 'unavailable';
type PlaybackSyncState = 'CONNECTING' | 'ACTIVE' | 'SOURCE MISMATCH' | 'LOCAL ONLY';

/**
 * The badge a channel's registry filter draws in the query summary
 * (`camera-grid-query-summary`), keyed by `CameraRegistryFilter`: a table
 * rather than `cameraFilter.toUpperCase()`, which drew the filter's own
 * English identifier however `localization.locale` was set.
 */
const registryFilterMessageIds: Readonly<Record<CameraRegistryFilter, MessageId>> = {
  all: 'video.registryFilterAll',
  online: 'video.registryFilterOnline',
  alert: 'video.registryFilterAlert',
  lost: 'overview.metricSignalLost',
};

const playbackSyncStateMessageIds: Readonly<Record<PlaybackSyncState, MessageId>> = {
  CONNECTING: 'video.syncConnecting',
  ACTIVE: 'video.syncActive',
  'SOURCE MISMATCH': 'video.syncSourceMismatch',
  'LOCAL ONLY': 'video.syncLocalOnly',
};

interface CameraMaterialSource {
  readonly cameraId: string;
  readonly materialId: string;
  readonly source: string;
  readonly transport: 'BOUNDED_BLOB' | 'RANGE_GRANT';
  /** The variant this source was opened for; empty for the stored object. */
  readonly variant: string;
  /** Whether the library answered with something other than the stored object. */
  readonly rendered: boolean;
}

interface CameraMaterialSourceFailure {
  readonly cameraId: string;
  readonly materialId: string;
  readonly message: string;
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00';
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function samePlaybackTarget(left: PlaybackSyncTarget, right: PlaybackSyncTarget): boolean {
  return (
    left.cameraId === right.cameraId &&
    left.sourceKind === right.sourceKind &&
    left.materialId === right.materialId
  );
}

/**
 * `performance.inactiveDecode`: a stream nobody can see stops being decoded.
 *
 * Both browser signals are wired because neither covers the other's case.
 * `visibilitychange` reports the whole document going dark — the operator
 * switched to another window, or the shoot machine locked the screen — while
 * the observer reports this surface leaving view inside a document that is
 * still visible, which is what a screen switch or a collapsed tile does.
 * Nothing polls: an interval would decide on a stale answer for as long as it
 * lasts, and this setting exists to stop work rather than to schedule more.
 *
 * The gate reports a decision rather than pausing the player itself. Playback
 * intent lives in `ui.videoPlaying`, and the effect that applies it takes this
 * as a second input, so one owner still writes play/pause: a stream that was
 * playing when the surface went dark comes back playing, and one the operator
 * had paused stays paused.
 */
function useInactiveDecodeSuspension(surfaceRef: RefObject<MediaPlayerInstance | null>): boolean {
  const stopInactiveDecode = useBooleanSetting('performance.inactiveDecode');
  // Read once rather than waited for: a screen mounted while the operator is
  // already in another window has missed the event that would have said so.
  // The guard is for the static export, which renders this file with no DOM.
  const [documentHidden, setDocumentHidden] = useState(
    () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  );
  // An observer reports nothing until its first callback, and a player that has
  // not attached its host element yet is not evidence of an invisible one, so
  // the surface counts as on screen until something says otherwise: the failure
  // an operator notices is a black feed, not a warm decoder.
  const [surfaceOffScreen, setSurfaceOffScreen] = useState(false);

  useEffect(() => {
    const onVisibilityChange = (): void => {
      setDocumentHidden(document.visibilityState === 'hidden');
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    const surfaceElement = surfaceRef.current?.el ?? null;
    let observer: IntersectionObserver | null = null;
    // `typeof` rather than a property lookup: this file is also loaded where
    // the constructor is not declared at all.
    if (surfaceElement !== null && typeof IntersectionObserver === 'function') {
      observer = new IntersectionObserver((entries) => {
        const latest = entries.at(-1);
        if (latest === undefined) return;
        setSurfaceOffScreen(!latest.isIntersecting);
      });
      observer.observe(surfaceElement);
    }

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer?.disconnect();
    };
  }, [surfaceRef]);

  // The setting gates the decision, not the subscription. Both signals stay
  // current while it is off, so turning it back on suspends on what the browser
  // reports now instead of on whatever it last reported before the setting
  // stopped being honoured.
  return stopInactiveDecode && (documentHidden || surfaceOffScreen);
}

export function VideoScreen({ mode }: { readonly mode: 'live' | 'cameras' | 'archive' }) {
  const translate = useTranslate();
  // Memoized rather than a plain `.map()` on every render: an unmemoized
  // derived value built from `translate` (a new closure on every render)
  // between this component's many hooks confused React Compiler's reactive-
  // scope inference for callbacks declared later that reference neither --
  // `assignCameraMaterial`, `toggleWebcam`, `applyPlaybackAction` and
  // `selectCameraWithSync` all failed `preserve-manual-memoization` for that
  // reason until these two moved into `useMemo`.
  const cameraFilterOptions = useMemo(
    () => cameraFilterMessageIds.map(({ value, id }) => ({ value, label: translate(id) })),
    [translate],
  );
  const cameraSortOptions = useMemo(
    () => cameraSortMessageIds.map(({ value, id }) => ({ value, label: translate(id) })),
    [translate],
  );
  const router = useRouter();
  const state = useOperationsStore((value) => value);
  const playerRef = useRef<MediaPlayerInstance>(null);
  const decodeSuspended = useInactiveDecodeSuspension(playerRef);
  const defaultPlaybackRate = useNumberSetting('player.defaultRate');
  const cameraPageSize = useNumberSetting('cameras.gridPageSize');
  const seekStepSeconds = useNumberSetting('player.seekStep');
  const loopDemoSource = useBooleanSetting('player.loopDemo');
  const snapshotGrayscale = useBooleanSetting('player.snapshotGrayscale');
  const configuredVolume = useNumberSetting('player.defaultVolume') / 100;
  const playbackLeadMs = useNumberSetting('performance.playbackLeadMs');
  const retryProfileSetting = useStringSetting('performance.streamRetryBackoff');
  const retryProfile: NativeCameraRetryProfile =
    retryProfileSetting === 'fast' || retryProfileSetting === 'patient'
      ? retryProfileSetting
      : 'standard';
  const configuredCameraFilter = useStringSetting('cameras.defaultFilter');
  const webcamCaptureAllowed = useBooleanSetting('privacy.webcamCapture');
  const frameCaptureAllowed = useBooleanSetting('privacy.frameCapture');
  const webcamResolution = useStringSetting('performance.webcamResolution');
  const webcamFrameRate = useNumberSetting('performance.webcamFrameRate');
  const startMuted = useBooleanSetting('player.startMuted');
  const [duration, setDuration] = useState(18);
  const [currentTime, setCurrentTime] = useState(0);
  // `player.defaultRate` is the rate until the transport is used to pick one,
  // which is the difference between a default and a lock: a rate chosen here
  // outlives a later move of the setting, and a screen that was never touched
  // follows the setting wherever the operator puts it.
  const [chosenPlaybackRate, setChosenPlaybackRate] = useState<number | null>(null);
  const playbackRate = chosenPlaybackRate ?? defaultPlaybackRate;
  // Same shape as `player.defaultRate` above: a volume set on the screen
  // outlives a later move of the setting, and a screen nobody touched follows
  // it. Stored as a percentage because `numberWithin` takes its step from the
  // bounds -- a 0..1 range would ship a slider that steps by whole units.
  const [chosenVolume, setChosenVolume] = useState<number | null>(null);
  const volume = chosenVolume ?? configuredVolume;
  const [chosenMuted, setChosenMuted] = useState<boolean | null>(null);
  const muted = chosenMuted ?? startMuted;
  const [failedCameraId, setFailedCameraId] = useState<string | null>(null);
  const [sourceOverride, setSourceOverride] = useState<{
    readonly cameraId: string;
    readonly source: string;
  } | null>(null);
  /*
   * Seeded, then re-seeded when the setting moves -- the shape
   * `TacticalMapScreen` uses for `map.mode`. A `useState` initialiser would
   * capture the factory default forever, because personalization hydrates from
   * an effect after the first render.
   */
  const seededFilter: CameraRegistryFilter =
    cameraFilterOptions.find((option) => option.value === configuredCameraFilter)?.value ?? 'all';
  const [chosenFilter, setChosenFilter] = useState<CameraRegistryFilter | null>(null);
  const [filterSeededFrom, setFilterSeededFrom] = useState<CameraRegistryFilter>(seededFilter);
  if (filterSeededFrom !== seededFilter) {
    setFilterSeededFrom(seededFilter);
    setChosenFilter(null);
  }
  const cameraFilter = chosenFilter ?? seededFilter;
  const [cameraSort, setCameraSort] = useState<CameraRegistrySort>('registry');
  const [cameraPageIndex, setCameraPageIndex] = useState(1);
  const nativeConsumerSeed = useId();
  const nativeConsumerId = useMemo(
    () => `hq-video-${nativeConsumerSeed.replaceAll(/[^a-zA-Z0-9_-]/gu, '')}`,
    [nativeConsumerSeed],
  );
  const [nativeStream, setNativeStream] = useState<NativeCameraStream | null>(null);
  const [webcamSession, setWebcamSession] = useState<WebcamSession | null>(null);
  const [webcamState, setWebcamState] = useState<WebcamState>('idle');
  const [cameraMaterialAssignments, setCameraMaterialAssignments] =
    useState<CameraMaterialAssignments>({});
  const [cameraMaterials, setCameraMaterials] = useState<readonly MaterialEntry[]>([]);
  const [materialCatalogState, setMaterialCatalogState] = useState<MaterialCatalogState>('loading');
  const [cameraMaterialSource, setCameraMaterialSource] = useState<CameraMaterialSource | null>(
    null,
  );
  const [cameraMaterialSourceFailure, setCameraMaterialSourceFailure] =
    useState<CameraMaterialSourceFailure | null>(null);
  /*
   * The rendition the operator asked this channel for (R21, C25). Seeded from
   * the camera's own declaration below and reset when the assignment moves, so
   * a 480p chosen for one channel is not silently requested for the next.
   */
  const [chosenVariant, setChosenVariant] = useState<string | null>(null);
  const [playbackSyncState, setPlaybackSyncState] = useState<PlaybackSyncState>('CONNECTING');
  /*
   * The group, read as external state exactly as `EditModeRuntime` reads it:
   * it appears with `JoinGroup` and disappears with the session, neither of
   * which is a render of this screen.
   */
  const group = useSyncExternalStore(subscribeGroupRuntime, currentGroupRuntime, noGroupRuntime);
  const authority = useOperationsStore((value) => value.connection.authority);
  const leaderDeviceId = useOperationsStore((value) => value.connection.leaderDeviceId);
  const webcamSessionRef = useRef<WebcamSession | null>(null);
  const webcamRequestRef = useRef(0);
  const selectedCameraIdRef = useRef<string | undefined>(undefined);
  const cameraMaterialAssignmentsRef = useRef<CameraMaterialAssignments>({});
  const playbackSyncRef = useRef<PlaybackSyncCoordinator | null>(null);
  const playbackCommandHandlerRef = useRef<(command: PlaybackSyncCommand) => void>(() => undefined);
  const materialClient = useMaterialLibrary();
  const cameras = useMemo(() => Object.values(state.cameras), [state.cameras]);
  const selected = state.cameras[state.ui.selectedCameraId] ?? Object.values(state.cameras)[0];
  const selectedMaterialId =
    selected === undefined ? undefined : cameraMaterialAssignments[selected.id];
  const selectedMaterial = cameraMaterials.find(
    (material) => material.materialId === selectedMaterialId,
  );
  /*
   * The ladder this channel can be asked for (R21, C25).
   *
   * The library names what it can serve; the camera's own declaration is
   * prepended, which is the one path by which `Camera.codec` and
   * `Camera.bitrate` reach a grant request at all. It is prepended rather than
   * appended because a channel whose declaration is honoured is the state the
   * registry describes, so it is what the menu opens on.
   */
  const declaredRendition = useMemo(
    () =>
      selected === undefined ? null : cameraDeclaredRendition(selected.codec, selected.bitrate),
    [selected],
  );
  const cameraRenditions = useMemo<readonly MaterialRendition[]>(() => {
    if (selectedMaterial === undefined) return [originalRendition];
    const offered = materialClient.renditions(selectedMaterial);
    if (declaredRendition === null || offered.length <= 1) return offered;
    return [offered[0] ?? originalRendition, declaredRendition, ...offered.slice(1)];
  }, [declaredRendition, materialClient, selectedMaterial]);
  /*
   * A channel opens on the rendition its own codec and bitrate name -- but
   * only when the library actually offers that rendition. The bridge serves
   * one stored object and answers every request with the original, so seeding
   * a variant it will never return leaves the channel waiting for a source
   * that cannot arrive, and the status line says LOADING forever.
   */
  const seededVariant =
    declaredRendition !== null &&
    cameraRenditions.some((rendition) => rendition.variant === declaredRendition.variant)
      ? declaredRendition.variant
      : (cameraRenditions[0]?.variant ?? '');
  const [variantSeededFrom, setVariantSeededFrom] = useState(
    `${selected?.id ?? ''}:${seededVariant}`,
  );
  if (variantSeededFrom !== `${selected?.id ?? ''}:${seededVariant}`) {
    setVariantSeededFrom(`${selected?.id ?? ''}:${seededVariant}`);
    setChosenVariant(null);
  }
  const requestedVariant = chosenVariant ?? seededVariant;
  const requestedRendition = useMemo<MaterialRendition>(
    () =>
      cameraRenditions.find((rendition) => rendition.variant === requestedVariant) ??
      originalRendition,
    [cameraRenditions, requestedVariant],
  );
  const activeCameraMaterialSource =
    cameraMaterialSource !== null &&
    cameraMaterialSource.cameraId === selected?.id &&
    cameraMaterialSource.materialId === selectedMaterialId &&
    // The variant is part of the identity of a source, not a label on it: a
    // menu that left the previous rendition playing while the next one was
    // being granted would show a change that had not happened yet.
    cameraMaterialSource.variant === requestedVariant
      ? cameraMaterialSource
      : null;
  const activeCameraMaterialFailure =
    cameraMaterialSourceFailure !== null &&
    cameraMaterialSourceFailure.cameraId === selected?.id &&
    cameraMaterialSourceFailure.materialId === selectedMaterialId
      ? cameraMaterialSourceFailure
      : null;
  const materialSourceState: MaterialSourceState =
    selectedMaterialId === undefined
      ? 'idle'
      : selectedMaterial === undefined
        ? materialCatalogState === 'loading'
          ? 'loading'
          : materialCatalogState === 'unavailable'
            ? 'unavailable'
            : 'missing'
        : activeCameraMaterialSource !== null
          ? 'ready'
          : activeCameraMaterialFailure === null
            ? 'loading'
            : 'unavailable';
  /*
   * What the library answered for the rendition on screen. `original` is the
   * honest reading of every deployment in this repository: `issuePreview`
   * presigns the stored object whatever variant it is handed, so a channel set
   * to `720P` is playing the original and the bar says so rather than letting
   * the menu imply a change that did not happen.
   */
  const renditionOutcome: RenditionOutcome =
    materialSourceState === 'unavailable' || materialSourceState === 'missing'
      ? 'failed'
      : activeCameraMaterialSource === null
        ? 'pending'
        : activeCameraMaterialSource.rendered
          ? 'rendered'
          : requestedVariant.length === 0
            ? 'pending'
            : 'original';
  const cameraLocalSources = useMemo(
    () =>
      activeCameraMaterialSource === null
        ? {}
        : { [activeCameraMaterialSource.cameraId]: activeCameraMaterialSource.source },
    [activeCameraMaterialSource],
  );
  const streamRegistry = useMemo(
    () => createCameraStreamRegistry(cameras, { localSources: cameraLocalSources }),
    [cameraLocalSources, cameras],
  );
  const selectedStream = selected === undefined ? undefined : streamRegistry[selected.id];
  const selectedWebcamSession =
    webcamSession !== null && webcamSession.cameraId === selected?.id && webcamSession.stream.active
      ? webcamSession
      : null;
  const selectedWebcamSource =
    selectedWebcamSession === null
      ? null
      : ({ src: selectedWebcamSession.stream, type: 'video/object' } as const);
  const selectedNativeStream = nativeStream?.cameraId === selected?.id ? nativeStream : null;
  const selectedSourceOverride =
    sourceOverride !== null && sourceOverride.cameraId === selected?.id
      ? sourceOverride.source
      : null;
  const selectedMaterialMediaSource =
    activeCameraMaterialSource === null || selectedMaterial === undefined
      ? null
      : ({
          src: activeCameraMaterialSource.source,
          type: selectedMaterial.mimeType === 'video/webm' ? 'video/webm' : 'video/mp4',
        } satisfies VideoSrc);
  const selectedSource =
    selectedWebcamSource ??
    selectedSourceOverride ??
    selectedNativeStream?.manifestUrl ??
    selectedMaterialMediaSource ??
    selectedStream?.browserSource;
  const selectedMaterialSourceActive =
    selectedWebcamSource === null &&
    selectedSourceOverride === null &&
    selectedNativeStream === null &&
    selectedMaterialMediaSource !== null;
  const selectedTransport =
    selectedWebcamSession === null
      ? (selectedNativeStream?.transport ?? selectedStream?.transport)
      : 'WEBCAM';
  const isWebcamSelected = selectedWebcamSession !== null;
  const playbackSyncTarget = useMemo<PlaybackSyncTarget | null>(() => {
    if (selected === undefined || isWebcamSelected) return null;
    if (selectedTransport === 'DEMO_VIDEO') {
      return createPlaybackSyncTarget(selected.id, 'DEMO_VIDEO');
    }
    if (selectedTransport === 'LOCAL_MATERIAL' && selectedMaterialId !== undefined) {
      return createPlaybackSyncTarget(selected.id, 'LOCAL_MATERIAL', selectedMaterialId);
    }
    return null;
  }, [isWebcamSelected, selected, selectedMaterialId, selectedTransport]);
  const mediaError = selected?.id === failedCameraId;
  const activeChannel =
    state.channels[state.ui.selectedChannelId] ?? Object.values(state.channels)[0];
  const cameraPage = useMemo(
    () =>
      queryCameraRegistry(cameras, streamRegistry, {
        filter: cameraFilter,
        sort: cameraSort,
        page: cameraPageIndex,
        pageSize: cameraPageSize,
      }),
    [cameraFilter, cameraPageIndex, cameraPageSize, cameras, cameraSort, streamRegistry],
  );
  const cameraRegistryHealth = useMemo(
    () => ({
      online: cameras.filter((camera) => camera.status === 'ACTIVE').length,
      alert: cameras.filter((camera) => camera.status === 'ALERT').length,
      lost: cameras.filter((camera) => camera.status === 'SIGNAL_LOST').length,
      gateway: Object.values(streamRegistry).filter((stream) => stream.transport === 'RTSP_GATEWAY')
        .length,
      demo: Object.values(streamRegistry).filter((stream) => stream.transport === 'DEMO_VIDEO')
        .length,
      materials: Object.values(streamRegistry).filter(
        (stream) => stream.transport === 'LOCAL_MATERIAL',
      ).length,
    }),
    [cameras, streamRegistry],
  );
  const assignableCameraMaterials = useMemo(
    () => cameraMaterials.filter(isAssignableCameraMaterial),
    [cameraMaterials],
  );
  const materialSourceOptions = useMemo(() => {
    const options: Array<{
      readonly value: string;
      readonly label: string;
      readonly disabled?: boolean;
    }> = [
      { value: demoCameraMaterialOption, label: translate('video.demoSourceLabel') },
      ...assignableCameraMaterials.map((material) => ({
        value: material.materialId,
        label: translate('video.fileSourceLabel', {
          name: abbreviateMaterialName(material.displayName),
        }),
      })),
    ];
    if (
      selectedMaterialId !== undefined &&
      !assignableCameraMaterials.some((material) => material.materialId === selectedMaterialId)
    ) {
      options.push({
        value: selectedMaterialId,
        label: translate('video.missingSourceLabel', { id: selectedMaterialId.slice(0, 12) }),
        disabled: true,
      });
    }
    return options;
    // `translate` belongs here: without it the memo keeps whatever locale was
    // in force when the material list last changed, and a pure locale switch
    // would leave these three labels stuck in the old language.
  }, [assignableCameraMaterials, selectedMaterialId, translate]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const persisted = readCameraMaterialAssignments(window.localStorage);
      cameraMaterialAssignmentsRef.current = persisted;
      setCameraMaterialAssignments(persisted);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void materialClient
      .list('', 100, controller.signal)
      .then((page) => {
        if (!active) return;
        setCameraMaterials(
          page.materials
            .filter(isAssignableCameraMaterial)
            .sort((left, right) => right.createdAt.localeCompare(left.createdAt, 'en-US')),
        );
        setMaterialCatalogState('ready');
      })
      .catch(() => {
        if (!active || controller.signal.aborted) return;
        setCameraMaterials([]);
        setMaterialCatalogState('unavailable');
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [materialClient]);

  useEffect(() => {
    const cameraId = selected?.id;
    if (
      cameraId === undefined ||
      selectedMaterialId === undefined ||
      selectedMaterial === undefined
    )
      return;

    const controller = new AbortController();
    let released = false;
    /*
     * The blob-versus-grant choice and the undoing of either used to be written
     * out here as well as in `openMaterialSource`, so a fix to one was a fix to
     * one of two copies. The seam owns both, and the screen keeps only what is
     * its own: which camera the source belongs to, and what to show when it
     * cannot be opened.
     */
    const handle = openMaterialRendition(
      materialClient,
      selectedMaterial,
      requestedRendition,
      controller.signal,
    );
    void Promise.resolve().then(() => {
      if (!released) setCameraMaterialSourceFailure(null);
    });
    void handle.opened
      .then((source) => {
        if (released || controller.signal.aborted) return;
        setCameraMaterialSource({
          cameraId,
          materialId: selectedMaterial.materialId,
          source: source.url,
          transport: source.transport,
          variant: source.variant,
          rendered: source.rendered,
        });
      })
      .catch((error: unknown) => {
        if (released || controller.signal.aborted) return;
        setCameraMaterialSourceFailure({
          cameraId,
          materialId: selectedMaterial.materialId,
          message:
            error instanceof Error ? error.message : t('video.localMaterialStreamUnavailable'),
        });
      });
    return () => {
      released = true;
      controller.abort();
      handle.release();
    };
  }, [
    materialCatalogState,
    materialClient,
    requestedRendition,
    selected?.id,
    selectedMaterial,
    selectedMaterialId,
  ]);

  useEffect(() => {
    selectedCameraIdRef.current = selected?.id;
    const activeSession = webcamSessionRef.current;
    if (activeSession !== null && activeSession.cameraId !== selected?.id) {
      webcamRequestRef.current += 1;
      activeSession.stream.getTracks().forEach((track) => track.stop());
      webcamSessionRef.current = null;
    }
  }, [selected?.id]);

  useEffect(
    () => () => {
      webcamRequestRef.current += 1;
      webcamSessionRef.current?.stream.getTracks().forEach((track) => track.stop());
      webcamSessionRef.current = null;
    },
    [],
  );

  const stopWebcam = useCallback(() => {
    webcamRequestRef.current += 1;
    webcamSessionRef.current?.stream.getTracks().forEach((track) => track.stop());
    webcamSessionRef.current = null;
    setWebcamSession(null);
    setWebcamState('idle');
  }, []);

  const assignCameraMaterial = useCallback(
    (nextMaterialId: string) => {
      const cameraId = selected?.id;
      if (cameraId === undefined) return;
      if (isWebcamSelected) stopWebcam();
      const nextAssignments = setCameraMaterialAssignment(
        cameraMaterialAssignmentsRef.current,
        cameraId,
        nextMaterialId,
      );
      cameraMaterialAssignmentsRef.current = nextAssignments;
      writeCameraMaterialAssignments(window.localStorage, nextAssignments);
      setCameraMaterialAssignments(nextAssignments);
      setSourceOverride(null);
      setFailedCameraId(null);
    },
    [isWebcamSelected, selected?.id, stopWebcam],
  );

  const toggleWebcam = useCallback(async () => {
    const cameraId = selected?.id;
    if (cameraId === undefined) return;
    /*
     * Gated here rather than on the button. `w` reaches this same function from
     * the keyboard, so disabling the control would promise a boundary a
     * keystroke walks straight around — which is what C33 records about
     * `advanced.liveEdit`. The button is disabled as well, so the operator can
     * see the refusal rather than press a control that silently does nothing.
     */
    if (!webcamCaptureAllowed) {
      setWebcamState('unavailable');
      return;
    }
    const current = webcamSessionRef.current;
    if (current?.cameraId === cameraId && current.stream.active) {
      stopWebcam();
      return;
    }
    current?.stream.getTracks().forEach((track) => track.stop());
    webcamSessionRef.current = null;
    setWebcamSession(null);

    if (navigator.mediaDevices?.getUserMedia === undefined) {
      setWebcamState('unavailable');
      return;
    }
    const requestId = webcamRequestRef.current + 1;
    webcamRequestRef.current = requestId;
    setWebcamState('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          ...webcamCaptureSizes[
            webcamResolution === '720p' || webcamResolution === '480p' ? webcamResolution : '1080p'
          ],
          // `ideal` is a request the browser negotiates, so the setting moves
          // what is asked for and never what is enforced. `max` rises with the
          // choice rather than capping it below what was asked.
          frameRate: { ideal: webcamFrameRate, max: Math.max(30, webcamFrameRate) },
        },
      });
      if (webcamRequestRef.current !== requestId || selectedCameraIdRef.current !== cameraId) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const session = { cameraId, stream } satisfies WebcamSession;
      webcamSessionRef.current = session;
      setWebcamSession(session);
      setSourceOverride(null);
      setFailedCameraId(null);
      setWebcamState('active');
      for (const track of stream.getVideoTracks()) {
        track.addEventListener(
          'ended',
          () => {
            if (webcamSessionRef.current?.stream !== stream) return;
            webcamSessionRef.current = null;
            setWebcamSession(null);
            setWebcamState('ended');
          },
          { once: true },
        );
      }
    } catch (error: unknown) {
      if (webcamRequestRef.current !== requestId) return;
      const unavailableErrorNames = new Set([
        'NotFoundError',
        'NotReadableError',
        'OverconstrainedError',
      ]);
      setWebcamState(
        error instanceof DOMException && unavailableErrorNames.has(error.name)
          ? 'unavailable'
          : 'denied',
      );
    }
    // The three settings belong in this list. Without them the callback keeps
    // the values it first closed over, so the privacy gate answers with
    // whatever was true at mount and the constraints never follow the operator
    // — the defect a Playwright run caught and the jsdom stub could not.
  }, [selected?.id, stopWebcam, webcamCaptureAllowed, webcamFrameRate, webcamResolution]);

  const applyPlaybackAction = useCallback(
    (action: Exclude<PlaybackSyncAction, 'SELECT'>, positionSeconds: number, rate: number) => {
      const player = playerRef.current;
      const mediaDuration = player?.duration || duration || 18;
      const nextPosition = Math.min(mediaDuration, Math.max(0, positionSeconds));
      const nextPercent = (nextPosition / mediaDuration) * 100;
      if (action === 'SET_RATE') {
        setChosenPlaybackRate(rate);
        if (player !== null) player.playbackRate = rate;
        return;
      }
      if (action === 'SEEK') {
        if (player !== null) player.currentTime = nextPosition;
        state.setVideoPosition(nextPercent);
        state.setVideoLive(nextPercent >= 99.5);
        return;
      }
      if (player !== null) player.currentTime = nextPosition;
      state.setVideoPosition(nextPercent);
      state.setVideoLive(nextPercent >= 99.5);
      if (action === 'PLAY') {
        state.setVideoPlaying(true);
        void player?.play().catch(() => undefined);
      } else {
        state.setVideoPlaying(false);
        void player?.pause().catch(() => undefined);
      }
    },
    [duration, state],
  );

  const applyPlaybackCommand = useCallback(
    (command: PlaybackSyncCommand) => {
      if (command.action === 'SELECT') {
        if (state.cameras[command.target.cameraId] === undefined) {
          setPlaybackSyncState('SOURCE MISMATCH');
          return;
        }
        state.selectCamera(command.target.cameraId);
        setPlaybackSyncState('ACTIVE');
        return;
      }
      if (playbackSyncTarget === null || !samePlaybackTarget(playbackSyncTarget, command.target)) {
        setPlaybackSyncState('SOURCE MISMATCH');
        return;
      }
      applyPlaybackAction(command.action, command.positionSeconds, command.playbackRate);
      setPlaybackSyncState('ACTIVE');
    },
    [applyPlaybackAction, playbackSyncTarget, state],
  );

  useEffect(() => {
    playbackCommandHandlerRef.current = applyPlaybackCommand;
  }, [applyPlaybackCommand]);

  useEffect(() => {
    try {
      /*
       * The coordinator already declared and validated the lead; nothing passed
       * it. A lead gives a slower screen time to arrive at the same instant as
       * a fast one, which is the point of synchronised playback.
       *
       * How long a lead depends on how the command travels. A socket pushes it
       * within milliseconds of the append; a poll feed reads the log on a
       * cadence measured in seconds, and a command whose instant has already
       * passed when it arrives is executed on arrival -- a different moment on
       * every screen. `playbackLeadForDelivery` raises the floor for the poll
       * feed and leaves a socket group on whatever the operator set.
       *
       * The transport is the group's while this session is in one, and the
       * browser's otherwise. That is what moves `epoch` and `sequence` off this
       * machine: the group transport answers each publication with the pair the
       * server allocated, and the coordinator adopts it. Authority is passed in
       * too, so a session under `LEADER` refuses to publish locally rather than
       * learning it from a `FAILED_PRECONDITION` on every control press.
       *
       * The clock offset is what moves the *instant* off this machine (R27).
       * A lead cannot repair two screens whose clocks disagree -- it equalizes
       * delivery, and a clock difference is not delivery -- so `executeAtMs`
       * is expressed on the group's scale, and `TimeSync` is what converts to
       * it. Passed as a reader rather than a value on purpose: the estimate is
       * re-taken every minute, and putting it in this effect's dependencies
       * would rebuild the coordinator on each round, dropping every pending
       * command with it. The store is read at each conversion instead.
       */
      const groupTransport =
        group === null
          ? undefined
          : createGroupPlaybackSyncTransport({
              channel: group.channel,
              onPublishFailed: () => setPlaybackSyncState('LOCAL ONLY'),
            });
      const coordinator = new PlaybackSyncCoordinator({
        onCommand: (command) => playbackCommandHandlerRef.current(command),
        executionDelayMs: playbackLeadForDelivery(group?.delivery ?? 'socket', playbackLeadMs),
        clockOffsetMs: () => operationsStore.getState().connection.clock.offsetMs,
        ...(groupTransport === undefined ? {} : { transport: groupTransport }),
        ...(group === null ? {} : { deviceId: group.deviceId }),
        ...(authority === undefined
          ? {}
          : {
              authority:
                authority === 'leader' ? ('LEADER' as const) : ('MULTI_AUTHORITY' as const),
            }),
        ...(leaderDeviceId === undefined ? {} : { leaderDeviceId }),
      });
      playbackSyncRef.current = coordinator;
      void Promise.resolve().then(() => setPlaybackSyncState('ACTIVE'));
      return () => {
        if (playbackSyncRef.current === coordinator) playbackSyncRef.current = null;
        coordinator.close();
      };
    } catch {
      void Promise.resolve().then(() => setPlaybackSyncState('LOCAL ONLY'));
      return undefined;
    }
  }, [authority, group, leaderDeviceId, playbackLeadMs]);

  const requestPlaybackAction = useCallback(
    (
      action: Exclude<PlaybackSyncAction, 'SELECT'>,
      positionSeconds = playerRef.current?.currentTime ?? currentTime,
      rate = playbackRate,
    ) => {
      if (playbackSyncTarget !== null) {
        const command = playbackSyncRef.current?.publish({
          action,
          target: playbackSyncTarget,
          positionSeconds,
          playbackRate: rate,
        });
        if (command !== null && command !== undefined) {
          setPlaybackSyncState('ACTIVE');
          return;
        }
      }
      applyPlaybackAction(action, positionSeconds, rate);
      setPlaybackSyncState('LOCAL ONLY');
    },
    [applyPlaybackAction, currentTime, playbackRate, playbackSyncTarget],
  );

  const selectCameraWithSync = useCallback(
    (cameraId: string) => {
      if (isWebcamSelected) stopWebcam();
      setFailedCameraId(null);
      setSourceOverride(null);
      const target = createPlaybackSyncTarget(cameraId, 'DEMO_VIDEO');
      const command =
        target === null ? null : playbackSyncRef.current?.publish({ action: 'SELECT', target });
      if (command !== null && command !== undefined) {
        setPlaybackSyncState('ACTIVE');
        return;
      }
      state.selectCamera(cameraId);
      setPlaybackSyncState('LOCAL ONLY');
    },
    [isWebcamSelected, state, stopWebcam],
  );

  const fullscreen = useCallback(() => {
    void playerRef.current?.enterFullscreen().catch(() => undefined);
  }, []);

  const seekToPercent = useCallback(
    (percent: number) => {
      if (isWebcamSelected) return;
      const nextPercent = Math.min(100, Math.max(0, percent));
      const player = playerRef.current;
      requestPlaybackAction('SEEK', (nextPercent / 100) * (player?.duration || duration || 18));
    },
    [duration, isWebcamSelected, requestPlaybackAction],
  );

  const seekBy = useCallback(
    (seconds: number) => {
      if (isWebcamSelected) return;
      const player = playerRef.current;
      if (player === null) return;
      const nextPosition = Math.min(
        player.duration || duration,
        Math.max(0, player.currentTime + seconds),
      );
      requestPlaybackAction('SEEK', nextPosition);
    },
    [duration, isWebcamSelected, requestPlaybackAction],
  );

  const goLive = useCallback(() => {
    const player = playerRef.current;
    requestPlaybackAction('PLAY', player?.duration || duration || 18);
  }, [duration, requestPlaybackAction]);

  const takeSnapshot = useCallback(() => {
    if (!frameCaptureAllowed) return;
    const provider = playerRef.current?.provider;
    const video = isVideoProvider(provider) ? provider.video : undefined;
    if (video === undefined || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (context === null) return;
    // The canvas draws from the raw element, so the CSS grade on
    // `.video-main-feed__media` never reaches the file: this line alone is what
    // makes an exported snapshot monochrome.
    if (snapshotGrayscale) context.filter = 'grayscale(1) contrast(1.15)';
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ff3d00';
    context.font = '22px monospace';
    context.fillText(`${selected?.id ?? 'CAM'} / ${new Date().toISOString()}`, 28, 42);
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `${selected?.id ?? 'camera'}-${Date.now()}.png`;
    link.click();
    // `snapshotGrayscale` belongs here: without it the callback keeps the value
    // it closed over, and the setting would only take effect the next time some
    // unrelated change rebuilt it.
  }, [frameCaptureAllowed, selected?.id, snapshotGrayscale]);

  const togglePictureInPicture = useCallback(() => {
    const player = playerRef.current;
    if (player === null) return;
    void player.enterPictureInPicture().catch(() => undefined);
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (player === null || mediaError || selected === undefined) return;
    // The decode gate is the second input here rather than a second writer:
    // playback intent survives a hidden surface, and this effect re-runs the
    // moment the surface comes back to act on it again.
    if (state.ui.videoPlaying && !decodeSuspended) {
      void player.play().catch(() => undefined);
    } else {
      void player.pause().catch(() => undefined);
    }
  }, [decodeSuspended, mediaError, selected, state.ui.videoPlaying]);

  useEffect(() => {
    const cameraId = selected?.id;
    if (cameraId === undefined || selectedStream?.transport !== 'RTSP_GATEWAY') return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const connect = async (attempt: number): Promise<void> => {
      try {
        const stream = await startNativeCameraStream(cameraId, nativeConsumerId);
        if (stream === null) return;
        if (cancelled) {
          await stopNativeCameraStream(cameraId, nativeConsumerId).catch(() => undefined);
          return;
        }
        setNativeStream(stream);
      } catch {
        if (!cancelled) {
          retryTimer = setTimeout(
            () => void connect(attempt + 1),
            getNativeCameraRetryDelay(attempt, retryProfile),
          );
        }
      }
    };

    void connect(0);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
      void stopNativeCameraStream(cameraId, nativeConsumerId).catch(() => undefined);
    };
  }, [nativeConsumerId, retryProfile, selected?.id, selectedStream?.transport]);

  useEffect(() => {
    const cameraId = selected?.id;
    if (
      cameraId === undefined ||
      selectedStream?.transport !== 'RTSP_GATEWAY' ||
      selectedNativeStream === null ||
      selectedSourceOverride === null
    ) {
      return;
    }
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleRecovery = (attempt: number): void => {
      retryTimer = setTimeout(
        () => {
          void startNativeCameraStream(cameraId, nativeConsumerId)
            .then(async (stream) => {
              if (stream === null) return;
              if (cancelled) {
                await stopNativeCameraStream(cameraId, nativeConsumerId).catch(() => undefined);
                return;
              }
              setNativeStream(stream);
              setSourceOverride((current) => (current?.cameraId === cameraId ? null : current));
              playerRef.current?.startLoading();
            })
            .catch(() => {
              if (!cancelled) scheduleRecovery(attempt + 1);
            });
        },
        getNativeCameraRetryDelay(attempt, retryProfile),
      );
    };

    scheduleRecovery(0);
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) clearTimeout(retryTimer);
    };
  }, [
    nativeConsumerId,
    retryProfile,
    selected?.id,
    selectedNativeStream,
    selectedSourceOverride,
    selectedStream?.transport,
  ]);

  useEffect(() => {
    if (mode === 'archive' && state.ui.videoLive) state.setVideoLive(false);
  }, [mode, state]);

  if (selected === undefined || selectedStream === undefined) return null;
  const activeSelectedSource = selectedSource ?? selectedStream.browserSource;
  const selectedSourceLabel = translate(
    isWebcamSelected
      ? 'video.sourceLabelWebcam'
      : selectedTransport === 'LOCAL_MATERIAL'
        ? 'video.sourceLabelLocalMaterial'
        : selectedTransport === 'RTSP_GATEWAY'
          ? 'video.sourceLabelOptionalLive'
          : 'video.sourceLabelDemoLoop',
  );

  return (
    <div className={`ops-screen video-screen video-screen--${mode}`}>
      <header className="ops-screen__title">
        <div>
          <span>{translate('video.eyebrow')}</span>
          <h1>
            {translate(
              mode === 'archive'
                ? 'video.headingArchive'
                : mode === 'cameras'
                  ? 'video.headingCameras'
                  : 'video.headingLive',
            )}
          </h1>
        </div>
        <nav className="screen-subnav">
          <TerminalButton
            className={mode === 'live' ? 'is-active' : ''}
            onClick={() => router.push('/video')}
          >
            {translate('video.navLive')}
          </TerminalButton>
          <TerminalButton
            className={mode === 'cameras' ? 'is-active' : ''}
            onClick={() => router.push('/video/cameras')}
          >
            {translate('video.navCameras')}
          </TerminalButton>
          <TerminalButton
            className={mode === 'archive' ? 'is-active' : ''}
            onClick={() => router.push('/video/archive')}
          >
            {translate('video.navArchive')}
          </TerminalButton>
        </nav>
      </header>

      <div className="video-layout">
        <div className="video-primary-column">
          <MediaPlayer
            ref={playerRef}
            className={`video-main-feed ${selected.status === 'SIGNAL_LOST' || mediaError ? 'is-signal-lost' : ''}`}
            src={activeSelectedSource}
            poster={selectedStream.thumbnailSource}
            title={`${selected.id} / ${selected.location}`}
            // Autoplay is withheld while the surface is invisible, otherwise a
            // source that finishes loading during that time starts decoding on
            // its own and no state change follows to stop it again.
            autoPlay={!decodeSuspended}
            loop={!isWebcamSelected && loopDemoSource}
            muted={muted}
            // `volume`/`playbackRate` reach the provider the same way `muted`
            // already did: as controlled `<MediaPlayer>` props. Vidstack's own
            // `ready()` re-applies its `$props` after every can-play (a
            // rendition swap included), so an imperative
            // `player.volume = volume` assignment loses that race back to the
            // provider's 1/1 defaults the instant a new source resolves.
            volume={volume}
            playbackRate={playbackRate}
            playsInline
            preload="auto"
            crossOrigin={
              selectedMaterialSourceActive &&
              activeCameraMaterialSource?.transport === 'RANGE_GRANT'
                ? 'anonymous'
                : undefined
            }
            onDoubleClick={fullscreen}
            onLoadedMetadata={() => {
              const reportedDuration = playerRef.current?.duration;
              const nextDuration =
                reportedDuration !== undefined &&
                Number.isFinite(reportedDuration) &&
                reportedDuration > 0
                  ? reportedDuration
                  : 18;
              setDuration(nextDuration);
              if (playerRef.current !== null && !isWebcamSelected) {
                playerRef.current.currentTime = (state.ui.videoPosition / 100) * nextDuration;
              }
            }}
            onDurationChange={(nextDuration) =>
              setDuration(Number.isFinite(nextDuration) && nextDuration > 0 ? nextDuration : 18)
            }
            onTimeUpdate={(detail) => {
              setCurrentTime(detail.currentTime);
              if (isWebcamSelected) return;
              state.setVideoPosition(
                (detail.currentTime / (playerRef.current?.duration || duration)) * 100,
              );
            }}
            onError={() => {
              if (isWebcamSelected) {
                stopWebcam();
                setSourceOverride({
                  cameraId: selected.id,
                  source: selectedStream.fallbackSource,
                });
                setFailedCameraId(null);
                return;
              }
              if (activeSelectedSource !== selectedStream.fallbackSource) {
                setSourceOverride({
                  cameraId: selected.id,
                  source: selectedStream.fallbackSource,
                });
                setFailedCameraId(null);
                return;
              }
              setFailedCameraId(selected.id);
            }}
            onKeyDown={(event) => {
              if (event.key === ' ') {
                event.preventDefault();
                requestPlaybackAction(state.ui.videoPlaying ? 'PAUSE' : 'PLAY');
              }
              if (event.key === 'ArrowLeft') seekBy(-5);
              if (event.key === 'ArrowRight') seekBy(5);
              if (event.key.toLowerCase() === 'f') fullscreen();
              if (event.key.toLowerCase() === 'w') void toggleWebcam();
            }}
            tabIndex={0}
            aria-label={translate('video.streamAriaLabel', { id: selected.id })}
          >
            <MediaProvider mediaProps={{ className: 'video-main-feed__media' }} />
            <div className="video-scanlines" aria-hidden="true" />
            <div
              className="recognition-box"
              style={{
                transform: `translate(${state.ui.ptz.pan * 0.15}%, ${state.ui.ptz.tilt * 0.15}%) scale(${state.ui.ptz.zoom})`,
              }}
            >
              <span>
                {selected.objectId} / {translate('video.trackingLabel')}
              </span>
            </div>
            <header>
              <span>
                <b>{selected.id}</b> / {selected.location}
              </span>
              <i>{selectedSourceLabel}</i>
            </header>
            <div className="video-overlay-left">
              <span>{translate('video.overlayCamera', { id: selected.id })}</span>
              <span>{translate('video.overlayLocation', { sector: selected.sectorId })}</span>
              <span>
                {selected.resolution} / {selected.fps} FPS
              </span>
              <span>
                {selected.codec} / {selected.bitrate}
              </span>
              <span>{translate('video.overlayZoom', { value: state.ui.ptz.zoom.toFixed(1) })}</span>
              <span>{translate('video.overlayAngle', { value: 87 + state.ui.ptz.pan / 10 })}</span>
              <b>{translate('video.stabilizationActive')}</b>
            </div>
            <div className="video-timecode">
              <strong>07:42:{String(Math.floor(currentTime) % 60).padStart(2, '0')}</strong>
              <span>
                {translate(state.ui.videoLive ? 'media.liveLabel' : 'media.archiveLabel')} /{' '}
                {translate(state.ui.videoPlaying ? 'media.playLabel' : 'media.pauseLabel')} /{' '}
                {playbackRate}×
              </span>
            </div>
            {selected.status === 'SIGNAL_LOST' || mediaError ? (
              <div className="video-signal-lost">
                <strong>{translate('overview.metricSignalLost')}</strong>
                <span>{translate('video.switchingToBackup')}</span>
                <TerminalButton
                  onClick={() => {
                    setFailedCameraId(null);
                    setSourceOverride(null);
                    playerRef.current?.startLoading();
                  }}
                >
                  {translate('video.retryStreamButton')}
                </TerminalButton>
              </div>
            ) : null}
          </MediaPlayer>

          <Panel
            title={translate('video.transportTitle')}
            eyebrow={translate('video.transportEyebrow')}
            className="video-transport"
          >
            <div className="transport-controls">
              <TerminalButton
                onClick={() => {
                  requestPlaybackAction('PAUSE', 0);
                }}
              >
                {translate('video.stopButton')}
              </TerminalButton>
              <TerminalButton disabled={isWebcamSelected} onClick={() => seekBy(-1 / selected.fps)}>
                {translate('video.prevFrameButton')}
              </TerminalButton>
              <TerminalButton disabled={isWebcamSelected} onClick={() => seekBy(-seekStepSeconds)}>
                {translate('media.seekBackward', { seconds: seekStepSeconds })}
              </TerminalButton>
              <TerminalButton
                tone="primary"
                className="is-primary"
                onClick={() => requestPlaybackAction(state.ui.videoPlaying ? 'PAUSE' : 'PLAY')}
              >
                {translate(state.ui.videoPlaying ? 'media.pauseButton' : 'media.playButton')}
              </TerminalButton>
              <TerminalButton disabled={isWebcamSelected} onClick={() => seekBy(seekStepSeconds)}>
                {translate('media.seekForward', { seconds: seekStepSeconds })}
              </TerminalButton>
              <TerminalButton disabled={isWebcamSelected} onClick={() => seekBy(1 / selected.fps)}>
                {translate('video.nextFrameButton')}
              </TerminalButton>
              <TerminalButton
                className={state.ui.videoLive ? 'is-live' : ''}
                disabled={isWebcamSelected}
                onClick={goLive}
              >
                {translate('video.goLiveButton')}
              </TerminalButton>
              <TerminalButton disabled={!frameCaptureAllowed} onClick={takeSnapshot}>
                {translate('video.snapButton')}
              </TerminalButton>
              <TerminalButton onClick={togglePictureInPicture}>
                {translate('video.pipButton')}
              </TerminalButton>
              <TerminalButton onClick={fullscreen}>
                {translate('media.fullscreenButton')}
              </TerminalButton>
              <TerminalButton
                className={isWebcamSelected ? 'is-live' : ''}
                disabled={
                  webcamState === 'requesting' ||
                  !selectedStream.webcamEligible ||
                  !webcamCaptureAllowed
                }
                onClick={() => void toggleWebcam()}
              >
                {translate(
                  webcamState === 'requesting'
                    ? 'video.webcamRequestButton'
                    : isWebcamSelected
                      ? 'video.webcamStopButton'
                      : 'video.webcamStartButton',
                )}
              </TerminalButton>
            </div>
            <div className="transport-secondary">
              <TerminalSelect
                className="camera-source-select"
                value={selectedMaterialId ?? demoCameraMaterialOption}
                options={materialSourceOptions}
                onValueChange={assignCameraMaterial}
                label={translate('video.sourceSelectLabel')}
              />
              <TerminalSelect
                value={String(playbackRate)}
                options={playbackRateOptions}
                onValueChange={(value) =>
                  requestPlaybackAction('SET_RATE', currentTime, Number(value))
                }
                label={translate('media.playbackRateLabel')}
                disabled={isWebcamSelected}
              />
              <MaterialRenditionMenu
                className="camera-rendition-menu"
                renditions={cameraRenditions}
                variant={requestedVariant}
                onVariantChange={setChosenVariant}
                outcome={renditionOutcome}
                disabled={isWebcamSelected || selectedMaterial === undefined}
              />
              <TerminalButton onClick={() => setChosenMuted(!muted)}>
                {translate(muted ? 'media.mutedButton' : 'media.audioButton')}
              </TerminalButton>
              <TerminalSlider
                className="video-volume"
                value={volume * 100}
                onValueChange={(value) => setChosenVolume(value / 100)}
                label={translate('video.volumeLabel')}
                min={0}
                max={100}
                step={5}
                showValue={false}
              />
              <span>
                {isWebcamSelected
                  ? translate('video.localDeviceLive')
                  : `${formatTime(currentTime)} / ${formatTime(duration)}`}
              </span>
              <span
                className={`playback-sync-status playback-sync-status--${playbackSyncState.toLowerCase().replaceAll(' ', '-')}`}
                aria-live="polite"
              >
                {translate('video.syncStatusLine', {
                  status:
                    playbackSyncTarget === null
                      ? translate('video.syncLocalSource')
                      : translate(playbackSyncStateMessageIds[playbackSyncState]),
                })}
              </span>
              <span className="webcam-status" aria-live="polite">
                {webcamState === 'denied' ? <b>{translate('video.webcamDenied')}</b> : null}
                {webcamState === 'unavailable' ? (
                  <b>{translate('video.webcamApiUnavailable')}</b>
                ) : null}
                {webcamState === 'ended' ? <b>{translate('video.webcamEnded')}</b> : null}
              </span>
              <span className="camera-material-status" aria-live="polite">
                {selectedMaterialId !== undefined && materialSourceState === 'loading' ? (
                  <b>{translate('video.loadingLocalMaterial')}</b>
                ) : null}
                {selectedMaterialId !== undefined && materialSourceState === 'ready' ? (
                  <b>
                    {translate(
                      activeCameraMaterialSource?.transport === 'RANGE_GRANT'
                        ? 'video.rangeStreamReady'
                        : 'video.materialReady',
                    )}{' '}
                    / {abbreviateMaterialName(selectedMaterial?.displayName ?? '')}
                  </b>
                ) : null}
                {selectedMaterialId !== undefined && materialSourceState === 'missing' ? (
                  <b>{translate('video.materialNotAvailable')}</b>
                ) : null}
                {selectedMaterialId !== undefined && materialSourceState === 'unavailable' ? (
                  <b>
                    {activeCameraMaterialFailure?.message ||
                      translate('video.localMaterialStreamUnavailable')}
                  </b>
                ) : null}
                {selectedMaterialId === undefined && materialCatalogState === 'unavailable' ? (
                  <b>{translate('video.catalogOffline')}</b>
                ) : null}
              </span>
            </div>
            <div className="video-scrubber">
              <span>06:42:00</span>
              <TerminalSlider
                className="video-scrubber__slider"
                value={state.ui.videoPosition}
                onValueChange={seekToPercent}
                label={translate('video.scrubberLabel')}
                disabled={isWebcamSelected}
                min={0}
                max={100}
                step={0.01}
                showValue={false}
              />
              <span>07:42:15</span>
            </div>
            <div className="timeline-events">
              {state.events.slice(0, 12).map((event, index) => (
                <TerminalButton
                  key={event.id}
                  style={{ left: `${5 + index * 7.8}%` }}
                  title={event.title}
                  onClick={() => state.openDrawer('event', event.id)}
                />
              ))}
            </div>
          </Panel>
        </div>

        <Panel
          title={translate('video.cameraGridTitle')}
          eyebrow={translate('video.cameraGridEyebrow', {
            page: cameraPage.page,
            total: cameraPage.totalPages,
            count: cameraPage.totalItems,
          })}
          className="camera-grid-panel"
        >
          <div className="camera-grid-toolbar">
            <TerminalSelect
              value={cameraFilter}
              options={cameraFilterOptions}
              onValueChange={(value) => {
                setChosenFilter(value as CameraRegistryFilter);
                setCameraPageIndex(1);
              }}
              label={translate('video.cameraFilterSelectLabel')}
            />
            <TerminalSelect
              value={cameraSort}
              options={cameraSortOptions}
              onValueChange={(value) => {
                setCameraSort(value as CameraRegistrySort);
                setCameraPageIndex(1);
              }}
              label={translate('video.cameraSortSelectLabel')}
            />
          </div>
          <div className="camera-grid">
            {cameraPage.items.map(({ camera, stream }) => (
              <TerminalButton
                key={camera.id}
                className={`${camera.id === selected.id ? 'is-selected' : ''} ${camera.status === 'SIGNAL_LOST' ? 'is-lost' : ''}`}
                onClick={() => {
                  selectCameraWithSync(camera.id);
                }}
                title={translate('video.openStreamTitle', { location: camera.location })}
              >
                <div className="camera-thumb">
                  <Image
                    src={stream.thumbnailSource}
                    alt={translate('video.cameraImageAlt', {
                      id: camera.id,
                      location: camera.location,
                    })}
                    fill
                    sizes="(max-width: 1500px) 24vw, 16vw"
                  />
                  <span>
                    {translate(
                      camera.status === 'SIGNAL_LOST'
                        ? 'video.thumbNoSignal'
                        : stream.transport === 'LOCAL_MATERIAL'
                          ? 'video.thumbFile'
                          : stream.transport === 'RTSP_GATEWAY'
                            ? 'video.thumbLive'
                            : 'video.thumbDemo',
                    )}
                  </span>
                </div>
                <footer>
                  <strong>{camera.id}</strong>
                  <span>{camera.sectorId}</span>
                  <b>{camera.signal}%</b>
                </footer>
              </TerminalButton>
            ))}
            {cameraPage.items.length >= cameraPageSize ? null : (
              <aside
                className="camera-grid-query-summary"
                aria-label={translate('video.registrySummaryLabel')}
              >
                <header>
                  <strong>{translate('video.registryQueryLabel')}</strong>
                  <span>{translate(registryFilterMessageIds[cameraFilter])}</span>
                </header>
                <dl>
                  <div>
                    <dt>{translate('video.dtMatch')}</dt>
                    <dd>{cameraPage.totalItems}</dd>
                  </div>
                  <div>
                    <dt>{translate('video.dtActive')}</dt>
                    <dd>{cameraRegistryHealth.online}</dd>
                  </div>
                  <div>
                    <dt>{translate('video.registryFilterAlert')}</dt>
                    <dd>{cameraRegistryHealth.alert}</dd>
                  </div>
                  <div>
                    <dt>{translate('video.dtLost')}</dt>
                    <dd>{cameraRegistryHealth.lost}</dd>
                  </div>
                  <div>
                    <dt>{translate('video.dtDemo')}</dt>
                    <dd>{cameraRegistryHealth.demo}</dd>
                  </div>
                  <div>
                    <dt>{translate('video.dtMaterial')}</dt>
                    <dd>{cameraRegistryHealth.materials}</dd>
                  </div>
                  <div>
                    <dt>{translate('video.dtWebcam')}</dt>
                    <dd>{isWebcamSelected ? 1 : 0}</dd>
                  </div>
                  <div>
                    <dt>{translate('video.dtRtspOptIn')}</dt>
                    <dd>{cameraRegistryHealth.gateway}</dd>
                  </div>
                </dl>
                <p>
                  {translate('video.hiddenFeedsNote')} <b>{selected.id}</b>
                </p>
              </aside>
            )}
          </div>
          {/*
            The same control the registries use. It was a second hand-written
            pair of buttons with its own counter, which is how the two drifted
            into disagreeing about what a page is (C22).
          */}
          <RecordPagination
            page={{
              items: cameraPage.items,
              page: cameraPage.page,
              pageSize: cameraPage.pageSize,
              pageCount: cameraPage.totalPages,
              total: cameraPage.totalItems,
            }}
            onPage={setCameraPageIndex}
            label={translate('video.cameraPaginationLabel')}
          />
        </Panel>

        <aside className="video-side-stack">
          <Panel
            title={translate('video.storageTitle')}
            eyebrow={translate('video.storageEyebrow')}
            className="video-storage"
          >
            <dl className="ops-definition-list">
              <div>
                <dt>{translate('video.dtActiveChannels')}</dt>
                <dd>12 / 24</dd>
              </div>
              <div>
                <dt>{translate('video.dtFree')}</dt>
                <dd>12</dd>
              </div>
              <div>
                <dt>{translate('video.dtRecording')}</dt>
                <dd>12</dd>
              </div>
              <div>
                <dt>{translate('media.archiveLabel')}</dt>
                <dd>4.2 TB</dd>
              </div>
            </dl>
            <ProgressBar value={68} tone="ok" />
          </Panel>
          <Panel
            title={translate('drawer.signalLevel')}
            eyebrow={translate('video.liveChannelEyebrow')}
            className="video-signal"
          >
            <Gauge value={selected.signal} label={translate('video.gaugeExcellent')} />
          </Panel>
          <Panel
            title={translate('video.activeChannelTitle')}
            eyebrow={translate('video.activeChannelEyebrow')}
            className="video-channel-info"
          >
            <header>
              <strong>{selected.id}</strong>
              <StatusBadge status={selected.status} />
            </header>
            <dl className="ops-definition-list">
              <div>
                <dt>{translate('video.dtLocation')}</dt>
                <dd>{selected.location}</dd>
              </div>
              <div>
                <dt>{translate('field.stream')}</dt>
                <dd>
                  {selected.resolution} / {selected.fps} FPS
                </dd>
              </div>
              <div>
                <dt>{translate('video.dtTransport')}</dt>
                <dd>
                  {selectedTransport}
                  {selectedSourceOverride === null ? '' : translate('video.fallbackSuffix')}
                </dd>
              </div>
              <div>
                <dt>{translate('field.codec')}</dt>
                <dd>
                  {selected.codec} / {selected.bitrate}
                </dd>
              </div>
              <div>
                <dt>{translate('video.dtUptime')}</dt>
                <dd>{selected.uptime}</dd>
              </div>
              <div>
                <dt>{translate('field.operator')}</dt>
                <dd>{translate('video.operatorSystem')}</dd>
              </div>
              <div>
                <dt>{translate('token.ptz')}</dt>
                <dd>{translate(selected.ptz ? 'video.ptzAvailable' : 'video.ptzFixed')}</dd>
              </div>
            </dl>
          </Panel>
          <Panel
            title={translate('video.securityTitle')}
            eyebrow={translate('video.securityEyebrow')}
            className="video-security"
          >
            <dl className="ops-definition-list">
              <div>
                <dt>{translate('video.dtVpnTunnels')}</dt>
                <dd>12</dd>
              </div>
              <div>
                <dt>{translate('field.encryption')}</dt>
                <dd>AES-256</dd>
              </div>
              <div>
                <dt>{translate('video.dtIntegrity')}</dt>
                <dd className="is-ok">100%</dd>
              </div>
              <div>
                <dt>{translate('video.dtThreats')}</dt>
                <dd className="is-ok">{translate('video.threatsNone')}</dd>
              </div>
            </dl>
          </Panel>
          <Panel
            title={translate('video.eventLogTitle')}
            eyebrow={translate('video.eventLogEyebrow')}
            className="video-events"
          >
            <div className="video-event-log">
              {state.events.slice(0, 5).map((event) => (
                <TerminalButton key={event.id} onClick={() => state.openDrawer('event', event.id)}>
                  <time>{event.timestamp.slice(11, 19)}</time>
                  <span>{event.title}</span>
                </TerminalButton>
              ))}
            </div>
          </Panel>
        </aside>

        <div className="video-lower-grid">
          {mode === 'cameras' ? (
            <PtzPanel />
          ) : (
            <Panel
              title={translate('video.miniMapTitle')}
              eyebrow={translate('video.miniMapEyebrow')}
              className="video-mini-map"
            >
              <TerminalButton
                className="camera-map"
                onClick={() => router.push(`/map?camera=${selected.id}`)}
              >
                <i style={{ left: `${selected.position.x}%`, top: `${selected.position.y}%` }}>
                  {selected.id}
                </i>
                <span>
                  {selected.position.lat}, {selected.position.lng}
                </span>
              </TerminalButton>
            </Panel>
          )}

          <Panel
            title={translate('video.interceptTitle')}
            eyebrow={translate('video.interceptEyebrow')}
            className="video-intercepts"
          >
            <div className="intercept-list">
              {Object.values(state.channels)
                .slice(0, 4)
                .map((channel) => (
                  <TerminalButton
                    key={channel.id}
                    className={channel.id === state.ui.selectedChannelId ? 'is-selected' : ''}
                    onClick={() => state.selectChannel(channel.id)}
                  >
                    <span>
                      <strong>{channel.id}</strong>
                      <small>{channel.name}</small>
                    </span>
                    <svg viewBox="0 0 160 28" preserveAspectRatio="none">
                      <path d="M0 14L10 8 20 19 30 4 40 22 50 11 60 17 70 6 80 23 90 9 100 18 110 5 120 21 130 12 140 17 150 7 160 14" />
                    </svg>
                    <b>{channel.signal}%</b>
                  </TerminalButton>
                ))}
            </div>
            {activeChannel === undefined ? null : (
              <footer>
                <TerminalButton
                  onClick={() => requestPlaybackAction(state.ui.videoPlaying ? 'PAUSE' : 'PLAY')}
                >
                  {translate('video.sampleButton', { icon: state.ui.videoPlaying ? 'Ⅱ' : '▶' })}
                </TerminalButton>
                <TerminalButton onClick={() => state.openDrawer('channel', activeChannel.id)}>
                  {translate('video.transcriptButton')}
                </TerminalButton>
                <TerminalButton>{translate('media.addToCaseButton')}</TerminalButton>
              </footer>
            )}
          </Panel>

          <Panel
            title={translate('video.recognitionTitle')}
            eyebrow={translate('video.recognitionEyebrow')}
            className="video-recognition"
          >
            <nav>
              <TerminalButton className="is-active">
                {translate('video.recognitionPeople')}
              </TerminalButton>
              <TerminalButton>{translate('video.recognitionVehicles')}</TerminalButton>
              <TerminalButton>{translate('video.recognitionPlates')}</TerminalButton>
            </nav>
            <div>
              {Object.values(state.people)
                .slice(0, 3)
                .map((person, index) => (
                  <TerminalButton
                    key={person.id}
                    onClick={() => router.push(`/objects/${person.objectId}`)}
                  >
                    <i>
                      {translate('video.faceLabel', { index: String(index + 1).padStart(2, '0') })}
                    </i>
                    <span>
                      <strong>{person.fullName}</strong>
                      <small>
                        {person.id} / {translate('video.lastLabel')} 07:{39 + index}
                      </small>
                    </span>
                    <b>{94 - index * 6}%</b>
                  </TerminalButton>
                ))}
            </div>
          </Panel>

          <Panel
            title={translate('video.networkTitle')}
            eyebrow={translate('video.networkEyebrow')}
            className="video-network"
          >
            <div className="video-health-grid">
              <span>
                <small>{translate('video.incoming')}</small>
                <strong>{state.metrics.networkIn} Mb/s</strong>
                <Sparkline
                  label={translate('video.incomingTrafficLabel')}
                  values={state.metricsHistory.networkIn}
                  domain={channelDomain('network-in')}
                />
              </span>
              <span>
                <small>{translate('video.outgoing')}</small>
                <strong>{state.metrics.networkOut} Mb/s</strong>
                <Sparkline
                  label={translate('video.outgoingTrafficLabel')}
                  values={state.metricsHistory.networkOut}
                  domain={channelDomain('network-out')}
                />
              </span>
              <span>
                <small>{translate('video.power')}</small>
                <strong>228.4 V</strong>
                <ProgressBar value={76} tone="ok" />
              </span>
              <span>
                <small>{translate('video.backup')}</small>
                <strong>04:18:32</strong>
                <ProgressBar value={88} tone="ok" />
              </span>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

function abbreviateMaterialName(value: string): string {
  const compact = value.trim().replaceAll(/\s+/gu, ' ');
  return compact.length <= 34 ? compact : `${compact.slice(0, 31)}…`;
}

function PtzPanel() {
  const translate = useTranslate();
  const ptz = useOperationsStore((state) => state.ui.ptz);
  // Zoom keeps its own 0.15 step: it is a factor, not an angle, and binding it
  // to a setting measured in degrees would change zoom at the default.
  const step = useNumberSetting('cameras.ptzStep');
  const adjust = useOperationsStore((state) => state.adjustPtz);
  const setSpeed = useOperationsStore((state) => state.setPtzSpeed);
  return (
    <Panel
      title={translate('video.ptzControlTitle')}
      eyebrow={translate('video.ptzControlEyebrow')}
      className="ptz-panel"
    >
      <div className="ptz-pad">
        <TerminalButton onClick={() => adjust('tilt', -step)}>▲</TerminalButton>
        <TerminalButton onClick={() => adjust('pan', -step)}>◀</TerminalButton>
        <TerminalButton
          onClick={() => {
            adjust('pan', -ptz.pan);
            adjust('tilt', -ptz.tilt);
          }}
        >
          ●
        </TerminalButton>
        <TerminalButton onClick={() => adjust('pan', step)}>▶</TerminalButton>
        <TerminalButton onClick={() => adjust('tilt', step)}>▼</TerminalButton>
      </div>
      <div className="ptz-controls">
        <TerminalButton onClick={() => adjust('zoom', 0.15)}>
          {translate('video.zoomInButton')}
        </TerminalButton>
        <TerminalButton onClick={() => adjust('zoom', -0.15)}>
          {translate('video.zoomOutButton')}
        </TerminalButton>
        <TerminalButton>{translate('video.focusInButton')}</TerminalButton>
        <TerminalButton>{translate('video.focusOutButton')}</TerminalButton>
        <TerminalButton>{translate('video.irisOpenButton')}</TerminalButton>
        <TerminalButton>{translate('video.irisCloseButton')}</TerminalButton>
      </div>
      <div className="ptz-presets">
        {[1, 2, 3, 4].map((preset) => (
          <TerminalButton key={preset}>
            {translate('video.presetButton', { n: preset })}
          </TerminalButton>
        ))}
      </div>
      <TerminalSlider
        className="ptz-speed"
        label={translate('video.ptzSpeedLabel')}
        showValue
        min={10}
        max={100}
        value={ptz.speed}
        onValueChange={setSpeed}
      />
      <footer>
        {translate('video.ptzFooter', {
          pan: ptz.pan.toFixed(0),
          tilt: ptz.tilt.toFixed(0),
          zoom: ptz.zoom.toFixed(2),
        })}
      </footer>
    </Panel>
  );
}
