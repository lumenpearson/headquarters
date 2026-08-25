'use client';

import { useRef, useState } from 'react';
import { MediaPlayer, MediaProvider, type MediaPlayerInstance } from '@vidstack/react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { useNumberSetting } from '@/application/personalization/useSetting';

export function LocalMaterialPlayer({
  sourceUrl,
  title,
}: {
  readonly sourceUrl: string;
  readonly title: string;
}) {
  const playerRef = useRef<MediaPlayerInstance>(null);
  const [paused, setPaused] = useState(true);
  const seekStep = useNumberSetting('player.seekStep');
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  const togglePlayback = () => {
    const player = playerRef.current;
    if (player === null) return;
    if (player.paused) void player.play().catch(() => undefined);
    else void player.pause().catch(() => undefined);
  };

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
        onTimeUpdate={(detail) => setCurrentTime(detail.currentTime)}
        onPlay={() => setPaused(false)}
        onPause={() => setPaused(true)}
      >
        <MediaProvider mediaProps={{ className: 'local-material-player__media' }} />
      </MediaPlayer>
      <footer className="local-material-player__controls">
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
        <TerminalButton
          size="small"
          onClick={() => void playerRef.current?.enterFullscreen().catch(() => undefined)}
        >
          [F] FULL
        </TerminalButton>
        <span>
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>
      </footer>
    </section>
  );
}

function formatTime(seconds: number): string {
  const wholeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${String(Math.floor(wholeSeconds / 60)).padStart(2, '0')}:${String(
    wholeSeconds % 60,
  ).padStart(2, '0')}`;
}
