'use client';

import {
  forwardRef,
  useImperativeHandle,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { MediaPlayer, MediaProvider, Track, type MediaPlayerInstance } from '@vidstack/react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useNumberSetting } from '@/application/personalization/useSetting';

import type { MaterialSubtitleTrack } from './materialSubtitleTracks';

/** What a caller may drive imperatively, for the annotation panel's "jump to" control. */
export interface LocalMaterialPlayerHandle {
  seekTo(seconds: number): void;
}

export const LocalMaterialPlayer = forwardRef<
  LocalMaterialPlayerHandle,
  {
    readonly sourceUrl: string;
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
  }
>(function LocalMaterialPlayer(
  { sourceUrl, title, quality, tracks = [], onTimeUpdate },
  handleRef,
) {
  const playerRef = useRef<MediaPlayerInstance>(null);
  const [paused, setPaused] = useState(true);
  const seekStep = useNumberSetting('player.seekStep');
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  // Mirrors `<Track default>`: the first track shows until the operator hides it.
  const [captionsOn, setCaptionsOn] = useState(true);

  const togglePlayback = () => {
    const player = playerRef.current;
    if (player === null) return;
    if (player.paused) void player.play().catch(() => undefined);
    else void player.pause().catch(() => undefined);
  };

  const toggleCaptions = () => {
    const player = playerRef.current;
    if (player === null) return;
    const next = !captionsOn;
    setCaptionsOn(next);
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

  return (
    <section className="local-material-player">
      <MediaPlayer
        ref={playerRef}
        className="local-material-player__surface"
        src={sourceUrl}
        title={title}
        playsInline
        muted={muted}
        preload="metadata"
        crossOrigin={sourceUrl.startsWith('http://127.0.0.1:') ? 'anonymous' : undefined}
        aria-label={`Локальный медиаплеер: ${title}`}
        onCanPlay={(detail) => setDuration(detail.duration)}
        onTimeUpdate={(detail) => {
          setCurrentTime(detail.currentTime);
          onTimeUpdate?.(detail.currentTime);
        }}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
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
      </MediaPlayer>
      <footer
        className="local-material-player__controls"
        style={
          {
            '--local-player-buttons': tracks.length > 0 ? 6 : 5,
          } as CSSProperties
        }
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
        <TerminalButton
          size="small"
          onClick={() => {
            const player = playerRef.current;
            if (player === null) return;
            player.muted = !player.muted;
            setMuted(player.muted);
          }}
        >
          {muted ? '[M] MUTED' : '[M] AUDIO'}
        </TerminalButton>
        {tracks.length > 0 ? (
          <TerminalButton size="small" aria-pressed={captionsOn} onClick={toggleCaptions}>
            {captionsOn ? '[CC] SUBS ON' : '[CC] SUBS OFF'}
          </TerminalButton>
        ) : null}
        <TerminalButton
          size="small"
          onClick={() => void playerRef.current?.enterFullscreen().catch(() => undefined)}
        >
          [F] FULL
        </TerminalButton>
        <span>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
        {quality}
      </footer>
    </section>
  );
});

function formatTime(seconds: number): string {
  const wholeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${String(Math.floor(wholeSeconds / 60)).padStart(2, '0')}:${String(
    wholeSeconds % 60,
  ).padStart(2, '0')}`;
}
