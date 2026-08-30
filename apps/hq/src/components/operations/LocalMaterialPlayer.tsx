'use client';

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  Controls,
  MediaPlayer,
  MediaProvider,
  TimeSlider,
  Track,
  type AudioSrc,
  type MediaPlayerInstance,
  type VideoSrc,
} from '@vidstack/react';
import {
  TerminalButton,
  TerminalIconButton,
  TerminalPopover,
  TerminalSelect,
  TerminalSlider,
  TerminalSwitch,
} from '@gremuchaya/ui/primitives';

import { useBooleanSetting, useNumberSetting } from '@/application/personalization/useSetting';

import type { MaterialSubtitleTrack } from './materialSubtitleTracks';

/** What a caller may drive imperatively, for the annotation panel's "jump to" control. */
export interface LocalMaterialPlayerHandle {
  seekTo(seconds: number): void;
}

/**
 * `player.defaultRate`'s own enum (packages/settings-schema): the settings
 * menu offers exactly the speeds the setting can be left at, not a second,
 * disagreeing list.
 */
const playbackRateOptions = [0.5, 1, 1.5, 2].map((rate) => ({
  value: String(rate),
  label: `${rate}×`,
}));

export const LocalMaterialPlayer = forwardRef<
  LocalMaterialPlayerHandle,
  {
    readonly sourceUrl: string;
    /**
     * The material's own media type.
     *
     * A `blob:` URL carries no extension, so a player handed the bare string
     * guesses -- and the guess is `video/mp4` for everything, which means an
     * imported `.webm` never finds a loader and the surface sits empty. The
     * caller knows the type the library recorded; naming it here is the
     * difference between a preview that plays and one that reports nothing at
     * all. `VideoScreen` already states it the same way for camera sources.
     */
    readonly mimeType?: string;
    readonly title: string;
    /**
     * The quality menu, passed in rather than built here: which renditions exist
     * is the library's answer, and this player holds a URL and no library.
     */
    readonly quality?: ReactNode;
    /** Subtitle tracks a caller already resolved to safe `text/vtt` blob URLs. */
    readonly tracks?: readonly MaterialSubtitleTrack[];
    /** Mirrors the player's own `currentTime` state, for a caller that annotates by timestamp. */
    readonly onTimeUpdate?: (currentTime: number) => void;
    /**
     * Vidstack's `end` event, not `ended` and not a `currentTime` reading
     * close to `duration`: `end` is the one of the two that still fires when
     * `loop` is on, so a caller that remembers position by timestamp gets one
     * "watched to completion" signal regardless of the loop setting, without
     * guessing how close to `duration` counts as close enough.
     */
    readonly onEnd?: () => void;
    readonly autoPlay?: boolean;
    readonly loop?: boolean;
    /**
     * Seconds to seek to once the source is ready to play -- read once, at
     * construction: a caller seeds this from a remembered position, and a
     * later change (the caller re-rendering with a different value) must not
     * yank playback back a second time.
     */
    readonly initialTime?: number;
  }
>(function LocalMaterialPlayer(
  {
    sourceUrl,
    mimeType,
    title,
    quality,
    tracks = [],
    onTimeUpdate,
    onEnd,
    autoPlay = false,
    loop = false,
    initialTime = 0,
  },
  handleRef,
) {
  const playerRef = useRef<MediaPlayerInstance>(null);
  const [paused, setPaused] = useState(true);
  const seekStep = useNumberSetting('player.seekStep');
  const configuredRate = useNumberSetting('player.defaultRate');
  const configuredVolumePercent = useNumberSetting('player.defaultVolume');
  const configuredMuted = useBooleanSetting('player.startMuted');
  const hideDelayMs = useNumberSetting('player.controlsHideDelayMs');
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  // Mirrors `<Track default>`: the first track shows until the operator hides it.
  const [captionsOn, setCaptionsOn] = useState(true);

  /*
   * The chosen-vs-configured pattern `VideoScreen` already uses: a rate,
   * volume or mute the operator picks on this surface outlives a later move
   * of the setting, and a surface nobody touched follows the setting wherever
   * it goes.
   */
  const [chosenRate, setChosenRate] = useState<number | null>(null);
  const playbackRate = chosenRate ?? configuredRate;
  const [chosenVolume, setChosenVolume] = useState<number | null>(null);
  const volume = chosenVolume ?? configuredVolumePercent / 100;
  const [chosenMuted, setChosenMuted] = useState<boolean | null>(null);
  const muted = chosenMuted ?? configuredMuted;

  /*
   * Playback position across a rendition swap: the caller keeps this instance
   * mounted and only changes `sourceUrl`, so a plain `<video>` would restart
   * at zero. The position at the moment of the swap is captured here and
   * reapplied once the new source answers `canplay`; `initialTime` seeds the
   * same mechanism once, for a caller resuming a remembered position.
   */
  const previousSourceUrlRef = useRef(sourceUrl);
  const latestCurrentTimeRef = useRef(0);
  const pendingSeekRef = useRef<number | null>(initialTime > 0 ? initialTime : null);
  useEffect(() => {
    if (previousSourceUrlRef.current === sourceUrl) return;
    previousSourceUrlRef.current = sourceUrl;
    if (latestCurrentTimeRef.current > 0) pendingSeekRef.current = latestCurrentTimeRef.current;
  }, [sourceUrl]);

  /*
   * Reveal state for the overlay controls: hidden until the pointer is over
   * the viewing area or a control inside it holds focus, so a keyboard user
   * tabbing in and a coarse pointer tapping the surface both reach the same
   * result a fine pointer's hover does (R-accessibility, not optional here).
   * `player.controlsHideDelayMs` is spent as the single grace delay before
   * hiding again once neither is true -- not a reimplementation of Vidstack's
   * own idle/activity tracking, which the DOM structure below still uses for
   * the `Controls.Root`/`Controls.Group` pointer-events wiring.
   */
  const [controlsVisible, setControlsVisible] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const hoveredRef = useRef(false);
  const focusedRef = useRef(false);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = () => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  };
  const revealControls = () => {
    clearHideTimer();
    setControlsVisible(true);
  };
  const scheduleHideControls = () => {
    if (hoveredRef.current || focusedRef.current) return;
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), hideDelayMs);
  };
  useEffect(() => clearHideTimer, []);
  const controlsRevealed = controlsVisible || settingsOpen;

  const togglePlayback = () => {
    const player = playerRef.current;
    if (player === null) return;
    if (player.paused) void player.play().catch(() => undefined);
    else void player.pause().catch(() => undefined);
  };

  const applyCaptions = (next: boolean) => {
    setCaptionsOn(next);
    const player = playerRef.current;
    if (player === null) return;
    for (const track of player.textTracks.getByKind(['subtitles', 'captions'])) {
      track.mode = next ? 'showing' : 'disabled';
    }
  };

  useImperativeHandle(
    handleRef,
    () => ({
      seekTo(seconds) {
        const player = playerRef.current;
        if (player === null) return;
        player.currentTime = Math.max(0, seconds);
      },
    }),
    [],
  );

  /*
   * A `blob:` URL states no type, so Vidstack is told one. Without it the
   * player assumes `video/mp4` for every source and an imported `.webm`
   * finds no loader at all; with it, the library's own recorded type is what
   * chooses the loader. A caller that names no type keeps the bare string,
   * which is the right behaviour for an `http://127.0.0.1:` range URL whose
   * extension the provider can read for itself.
   */
  const mediaSource = useMemo((): string | AudioSrc | VideoSrc => {
    if (mimeType === undefined) return sourceUrl;
    return mimeType.startsWith('audio/')
      ? ({ src: sourceUrl, type: mimeType } as AudioSrc)
      : ({ src: sourceUrl, type: mimeType } as VideoSrc);
  }, [mimeType, sourceUrl]);

  return (
    <section className="local-material-player">
      <MediaPlayer
        ref={playerRef}
        className="local-material-player__surface"
        src={mediaSource}
        title={title}
        playsInline
        muted={muted}
        // `volume`/`playbackRate` reach the provider the same way `muted`
        // already did: as controlled `<MediaPlayer>` props, not an imperative
        // assignment. Vidstack's own `ready()` re-applies its `$props` after
        // every can-play (a rendition swap included), so setting
        // `player.volume`/`player.playbackRate` directly loses that race back
        // to the provider's 1/1 defaults the instant a new source resolves.
        volume={volume}
        playbackRate={playbackRate}
        autoPlay={autoPlay}
        loop={loop}
        preload="metadata"
        crossOrigin={sourceUrl.startsWith('http://127.0.0.1:') ? 'anonymous' : undefined}
        aria-label={`Локальный медиаплеер: ${title}`}
        onCanPlay={(detail) => {
          setDuration(detail.duration);
          const pending = pendingSeekRef.current;
          if (pending === null) return;
          pendingSeekRef.current = null;
          const player = playerRef.current;
          if (player === null) return;
          player.currentTime = detail.duration > 0 ? Math.min(pending, detail.duration) : pending;
        }}
        onTimeUpdate={(detail) => {
          latestCurrentTimeRef.current = detail.currentTime;
          setCurrentTime(detail.currentTime);
          onTimeUpdate?.(detail.currentTime);
        }}
        onEnd={() => onEnd?.()}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
        onPointerEnter={() => {
          hoveredRef.current = true;
          revealControls();
        }}
        onPointerLeave={() => {
          hoveredRef.current = false;
          scheduleHideControls();
        }}
        onFocus={() => {
          focusedRef.current = true;
          revealControls();
        }}
        onBlur={() => {
          focusedRef.current = false;
          scheduleHideControls();
        }}
      >
        <MediaProvider mediaProps={{ className: 'local-material-player__media' }}>
          {tracks.map((track) => (
            <Track
              key={track.id}
              src={track.url}
              kind="subtitles"
              label={track.label}
              lang={track.srcLang}
              default={track.default}
            />
          ))}
        </MediaProvider>

        <Controls.Root className="local-material-player__controls-root">
          <Controls.Group className="local-material-player__controls-group">
            <div
              className="local-material-player__hover-row"
              data-revealed={controlsRevealed ? 'true' : 'false'}
            >
              <TerminalButton size="small" tone="primary" onClick={togglePlayback}>
                {paused ? '[▶] PLAY' : '[Ⅱ] PAUSE'}
              </TerminalButton>
              <TerminalButton
                size="small"
                onClick={() => {
                  const player = playerRef.current;
                  if (player === null) return;
                  player.currentTime = Math.max(0, player.currentTime - seekStep);
                }}
              >
                [◀] -{seekStep}S
              </TerminalButton>
              <TerminalButton
                size="small"
                onClick={() => {
                  const player = playerRef.current;
                  if (player === null) return;
                  player.currentTime = Math.min(
                    player.duration || duration,
                    player.currentTime + seekStep,
                  );
                }}
              >
                [▶] +{seekStep}S
              </TerminalButton>
              <TerminalButton size="small" onClick={() => setChosenMuted(!muted)}>
                {muted ? '[M] MUTED' : '[M] AUDIO'}
              </TerminalButton>
              <span className="local-material-player__time-readout">
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
              <TerminalButton
                size="small"
                onClick={() => void playerRef.current?.enterFullscreen().catch(() => undefined)}
              >
                [F] FULL
              </TerminalButton>
            </div>
          </Controls.Group>

          {/*
            No `--persistent` modifier here: unlike the group above, this
            one's content (`.local-material-player__persistent-row`) is never
            gated behind `data-revealed`, so it needs no group-level class of
            its own -- one existed here once with no matching CSS rule.
          */}
          <Controls.Group className="local-material-player__controls-group">
            <div className="local-material-player__persistent-row">
              <TimeSlider.Root
                className="local-material-player__time-slider"
                aria-label="Позиция воспроизведения"
              >
                <TimeSlider.Track className="local-material-player__time-track">
                  <TimeSlider.Progress className="local-material-player__time-buffered" />
                  <TimeSlider.TrackFill className="local-material-player__time-fill" />
                </TimeSlider.Track>
                <TimeSlider.Thumb className="local-material-player__time-thumb" />
              </TimeSlider.Root>
              <TerminalPopover
                title="НАСТРОЙКИ ПЛЕЕРА"
                side="top"
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                className="local-material-player__settings-popover"
                trigger={
                  <TerminalIconButton
                    label="Настройки плеера"
                    size="small"
                    className="local-material-player__settings-trigger"
                  >
                    [⚙]
                  </TerminalIconButton>
                }
              >
                <div className="local-material-player__settings-panel">
                  {quality}
                  <label className="local-material-player__settings-row">
                    <span>СКОРОСТЬ</span>
                    <TerminalSelect
                      value={String(playbackRate)}
                      options={playbackRateOptions}
                      onValueChange={(value) => setChosenRate(Number(value))}
                      label="Скорость воспроизведения"
                    />
                  </label>
                  <TerminalSlider
                    label="ГРОМКОСТЬ"
                    value={Math.round(volume * 100)}
                    onValueChange={(value) => setChosenVolume(value / 100)}
                    min={0}
                    max={100}
                    step={5}
                  />
                  {tracks.length > 0 ? (
                    <label className="local-material-player__settings-row">
                      <span>СУБТИТРЫ</span>
                      <TerminalSwitch
                        label="Показывать субтитры"
                        checked={captionsOn}
                        onCheckedChange={applyCaptions}
                        onLabel="[CC] SUBS ON"
                        offLabel="[CC] SUBS OFF"
                      />
                    </label>
                  ) : null}
                </div>
              </TerminalPopover>
            </div>
          </Controls.Group>
        </Controls.Root>
      </MediaPlayer>
    </section>
  );
});

function formatTime(seconds: number): string {
  const wholeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${String(Math.floor(wholeSeconds / 60)).padStart(2, '0')}:${String(
    wholeSeconds % 60,
  ).padStart(2, '0')}`;
}
