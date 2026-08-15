'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TerminalButton, TerminalSelect, TerminalSlider } from '@gremuchaya/ui/primitives';

import { Gauge, Panel, ProgressBar, Sparkline, StatusBadge } from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

const surveillanceSource = '/assets/video/surveillance-k17.webm';

const playbackRateOptions = [0.5, 1, 1.5, 2, 4].map((rate) => ({
  value: String(rate),
  label: `${rate}×`,
}));

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '00:00';
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(wholeSeconds / 60);
  const remainder = wholeSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

export function VideoScreen({ mode }: { readonly mode: 'live' | 'cameras' | 'archive' }) {
  const router = useRouter();
  const state = useOperationsStore((value) => value);
  const feedRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(18);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [volume, setVolume] = useState(0.35);
  const [muted, setMuted] = useState(true);
  const [mediaError, setMediaError] = useState(false);
  const selected = state.cameras[state.ui.selectedCameraId] ?? Object.values(state.cameras)[0];
  const activeChannel =
    state.channels[state.ui.selectedChannelId] ?? Object.values(state.channels)[0];
  const cameraWall = useMemo(() => Object.values(state.cameras).slice(0, 12), [state.cameras]);

  const fullscreen = useCallback(() => {
    if (feedRef.current !== null) void feedRef.current.requestFullscreen();
  }, []);

  const seekToPercent = useCallback(
    (percent: number) => {
      const nextPercent = Math.min(100, Math.max(0, percent));
      if (videoRef.current !== null) {
        videoRef.current.currentTime = (nextPercent / 100) * (duration || 18);
      }
      state.setVideoPosition(nextPercent);
      state.setVideoLive(nextPercent >= 99.5);
    },
    [duration, state],
  );

  const seekBy = useCallback(
    (seconds: number) => {
      const video = videoRef.current;
      if (video === null) return;
      video.currentTime = Math.min(
        video.duration || duration,
        Math.max(0, video.currentTime + seconds),
      );
      state.setVideoPosition((video.currentTime / (video.duration || duration)) * 100);
      state.setVideoLive(false);
    },
    [duration, state],
  );

  const goLive = useCallback(() => {
    const video = videoRef.current;
    if (video !== null) {
      video.currentTime = Math.max(0, (video.duration || duration) - 0.12);
      void video.play();
    }
    state.setVideoPosition(100);
    state.setVideoLive(true);
    if (!state.ui.videoPlaying) state.toggleVideo();
  }, [duration, state]);

  const takeSnapshot = useCallback(() => {
    const video = videoRef.current;
    if (video === null || video.videoWidth === 0 || video.videoHeight === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (context === null) return;
    context.filter = 'grayscale(1) contrast(1.15)';
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ff3d00';
    context.font = '22px monospace';
    context.fillText(`${selected?.id ?? 'CAM'} / ${new Date().toISOString()}`, 28, 42);
    const link = document.createElement('a');
    link.href = canvas.toDataURL('image/png');
    link.download = `${selected?.id ?? 'camera'}-${Date.now()}.png`;
    link.click();
  }, [selected?.id]);

  const togglePictureInPicture = useCallback(() => {
    const video = videoRef.current;
    if (video === null || !document.pictureInPictureEnabled) return;
    if (document.pictureInPictureElement !== null) {
      void document.exitPictureInPicture();
    } else {
      void video.requestPictureInPicture();
    }
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) return;
    video.playbackRate = playbackRate;
    video.volume = volume;
    video.muted = muted;
  }, [muted, playbackRate, volume]);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null || mediaError || selected === undefined) return;
    if (state.ui.videoPlaying) {
      void video.play().catch(() => undefined);
    } else {
      video.pause();
    }
  }, [mediaError, selected, state.ui.videoPlaying]);

  useEffect(() => {
    if (mode === 'archive' && state.ui.videoLive) state.setVideoLive(false);
  }, [mode, state]);

  if (selected === undefined) return null;

  return (
    <div className={`ops-screen video-screen video-screen--${mode}`}>
      <header className="ops-screen__title">
        <div>
          <span>VIDEO / LOCAL MEDIA MATRIX</span>
          <h1>
            {mode === 'archive'
              ? 'ВИДЕОАРХИВ'
              : mode === 'cameras'
                ? 'ЦЕНТР КАМЕР / VIDEO WALL'
                : 'ВИДЕО / ПРЯМОЙ ЭФИР'}
          </h1>
        </div>
        <nav className="screen-subnav">
          <TerminalButton
            className={mode === 'live' ? 'is-active' : ''}
            onClick={() => router.push('/video')}
          >
            [L] LIVE
          </TerminalButton>
          <TerminalButton
            className={mode === 'cameras' ? 'is-active' : ''}
            onClick={() => router.push('/video/cameras')}
          >
            [C] CAMERAS
          </TerminalButton>
          <TerminalButton
            className={mode === 'archive' ? 'is-active' : ''}
            onClick={() => router.push('/video/archive')}
          >
            [A] ARCHIVE
          </TerminalButton>
        </nav>
      </header>

      <div className="video-layout">
        <div className="video-primary-column">
          <section
            ref={feedRef}
            className={`video-main-feed ${selected.status === 'SIGNAL_LOST' || mediaError ? 'is-signal-lost' : ''}`}
            onDoubleClick={fullscreen}
            onKeyDown={(event) => {
              if (event.key === ' ') {
                event.preventDefault();
                state.toggleVideo();
              }
              if (event.key === 'ArrowLeft') seekBy(-5);
              if (event.key === 'ArrowRight') seekBy(5);
              if (event.key.toLowerCase() === 'f') fullscreen();
            }}
            tabIndex={0}
            aria-label={`Видеопоток ${selected.id}`}
          >
            <video
              ref={videoRef}
              src={surveillanceSource}
              poster="/assets/video/camera-01.webp"
              autoPlay
              loop
              muted={muted}
              playsInline
              preload="auto"
              onLoadedMetadata={(event) => {
                const nextDuration = event.currentTarget.duration || 18;
                setDuration(nextDuration);
                event.currentTarget.currentTime = (state.ui.videoPosition / 100) * nextDuration;
              }}
              onDurationChange={(event) => setDuration(event.currentTarget.duration || 18)}
              onTimeUpdate={(event) => {
                const video = event.currentTarget;
                setCurrentTime(video.currentTime);
                state.setVideoPosition((video.currentTime / (video.duration || duration)) * 100);
              }}
              onPlay={() => {
                if (!state.ui.videoPlaying) state.toggleVideo();
              }}
              onPause={() => {
                if (state.ui.videoPlaying) state.toggleVideo();
              }}
              onError={() => setMediaError(true)}
            />
            <div className="video-scanlines" aria-hidden="true" />
            <div
              className="recognition-box"
              style={{
                transform: `translate(${state.ui.ptz.pan * 0.15}%, ${state.ui.ptz.tilt * 0.15}%) scale(${state.ui.ptz.zoom})`,
              }}
            >
              <span>{selected.objectId} / TRACKING</span>
            </div>
            <header>
              <span>
                <b>{selected.id}</b> / {selected.location}
              </span>
              <i>{selected.recording ? '● ПРЯМОЙ ЭФИР / REC' : '○ STBY'}</i>
            </header>
            <div className="video-overlay-left">
              <span>КАМЕРА {selected.id}</span>
              <span>ЛОКАЦИЯ {selected.sectorId}</span>
              <span>
                {selected.resolution} / {selected.fps} FPS
              </span>
              <span>
                {selected.codec} / {selected.bitrate}
              </span>
              <span>ЗУМ {state.ui.ptz.zoom.toFixed(1)}×</span>
              <span>УГОЛ {87 + state.ui.ptz.pan / 10}°</span>
              <b>СТАБИЛИЗАЦИЯ АКТИВНА</b>
            </div>
            <div className="video-timecode">
              <strong>07:42:{String(Math.floor(currentTime) % 60).padStart(2, '0')}</strong>
              <span>
                {state.ui.videoLive ? 'LIVE' : 'ARCHIVE'} /{' '}
                {state.ui.videoPlaying ? 'PLAY' : 'PAUSE'} / {playbackRate}×
              </span>
            </div>
            {selected.status === 'SIGNAL_LOST' || mediaError ? (
              <div className="video-signal-lost">
                <strong>ПОТЕРЯ СИГНАЛА</strong>
                <span>ПЕРЕКЛЮЧЕНИЕ НА РЕЗЕРВНЫЙ КАНАЛ</span>
                <TerminalButton
                  onClick={() => {
                    setMediaError(false);
                    videoRef.current?.load();
                  }}
                >
                  [R] RETRY STREAM
                </TerminalButton>
              </div>
            ) : null}
          </section>

          <Panel
            title="УПРАВЛЕНИЕ ПОТОКОМ"
            eyebrow="TIMELINE / TRANSPORT"
            className="video-transport"
          >
            <div className="transport-controls">
              <TerminalButton
                onClick={() => {
                  seekToPercent(0);
                  if (state.ui.videoPlaying) state.toggleVideo();
                }}
              >
                [■] STOP
              </TerminalButton>
              <TerminalButton onClick={() => seekBy(-1 / selected.fps)}>[|◀] FRAME</TerminalButton>
              <TerminalButton onClick={() => seekBy(-10)}>[◀] -10S</TerminalButton>
              <TerminalButton
                tone="primary"
                className="is-primary"
                onClick={() => state.toggleVideo()}
              >
                {state.ui.videoPlaying ? '[Ⅱ] PAUSE' : '[▶] PLAY'}
              </TerminalButton>
              <TerminalButton onClick={() => seekBy(10)}>[▶] +10S</TerminalButton>
              <TerminalButton onClick={() => seekBy(1 / selected.fps)}>[▶|] FRAME</TerminalButton>
              <TerminalButton className={state.ui.videoLive ? 'is-live' : ''} onClick={goLive}>
                [●] LIVE
              </TerminalButton>
              <TerminalButton onClick={takeSnapshot}>[S] SNAP</TerminalButton>
              <TerminalButton onClick={togglePictureInPicture}>[P] PIP</TerminalButton>
              <TerminalButton onClick={fullscreen}>[F] FULL</TerminalButton>
            </div>
            <div className="transport-secondary">
              <TerminalSelect
                value={String(playbackRate)}
                options={playbackRateOptions}
                onValueChange={(value) => setPlaybackRate(Number(value))}
                label="Скорость воспроизведения"
              />
              <TerminalButton onClick={() => setMuted((value) => !value)}>
                {muted ? '[M] MUTED' : '[M] AUDIO'}
              </TerminalButton>
              <TerminalSlider
                className="video-volume"
                value={volume * 100}
                onValueChange={(value) => setVolume(value / 100)}
                label="Громкость"
                min={0}
                max={100}
                step={5}
                showValue={false}
              />
              <span>
                {formatTime(currentTime)} / {formatTime(duration)}
              </span>
            </div>
            <div className="video-scrubber">
              <span>06:42:00</span>
              <TerminalSlider
                className="video-scrubber__slider"
                value={state.ui.videoPosition}
                onValueChange={seekToPercent}
                label="Позиция видеопотока"
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
          title="СЕТКА КАМЕР"
          eyebrow={`ACTIVE / ${cameraWall.length}`}
          className="camera-grid-panel"
        >
          <div className="camera-grid">
            {cameraWall.map((camera, index) => (
              <TerminalButton
                key={camera.id}
                className={`${camera.id === selected.id ? 'is-selected' : ''} ${camera.status === 'SIGNAL_LOST' ? 'is-lost' : ''}`}
                onClick={() => state.selectCamera(camera.id)}
                title={`${camera.location} / открыть поток`}
              >
                <div className="camera-thumb">
                  <Image
                    src={`/assets/video/camera-${String(index + 1).padStart(2, '0')}.webp`}
                    alt={`Камера ${camera.id}: ${camera.location}`}
                    fill
                    sizes="(max-width: 1500px) 24vw, 16vw"
                  />
                  <span>{camera.status === 'SIGNAL_LOST' ? 'NO SIGNAL' : '● LIVE'}</span>
                </div>
                <footer>
                  <strong>{camera.id}</strong>
                  <span>{camera.sectorId}</span>
                  <b>{camera.signal}%</b>
                </footer>
              </TerminalButton>
            ))}
          </div>
        </Panel>

        <aside className="video-side-stack">
          <Panel title="ХРАНИЛИЩЕ / КАНАЛЫ" eyebrow="RECORDING MATRIX" className="video-storage">
            <dl className="ops-definition-list">
              <div>
                <dt>АКТИВНЫЕ КАНАЛЫ</dt>
                <dd>12 / 24</dd>
              </div>
              <div>
                <dt>СВОБОДНЫЕ</dt>
                <dd>12</dd>
              </div>
              <div>
                <dt>ЗАПИСЬ</dt>
                <dd>12</dd>
              </div>
              <div>
                <dt>АРХИВ</dt>
                <dd>4.2 TB</dd>
              </div>
            </dl>
            <ProgressBar value={68} tone="ok" />
          </Panel>
          <Panel title="УРОВЕНЬ СИГНАЛА" eyebrow="LIVE CHANNEL" className="video-signal">
            <Gauge value={selected.signal} label="ОТЛИЧНЫЙ" />
          </Panel>
          <Panel title="АКТИВНЫЙ КАНАЛ" eyebrow="CAMERA / TELEMETRY" className="video-channel-info">
            <header>
              <strong>{selected.id}</strong>
              <StatusBadge status={selected.status} />
            </header>
            <dl className="ops-definition-list">
              <div>
                <dt>LOCATION</dt>
                <dd>{selected.location}</dd>
              </div>
              <div>
                <dt>STREAM</dt>
                <dd>
                  {selected.resolution} / {selected.fps} FPS
                </dd>
              </div>
              <div>
                <dt>CODEC</dt>
                <dd>
                  {selected.codec} / {selected.bitrate}
                </dd>
              </div>
              <div>
                <dt>UPTIME</dt>
                <dd>{selected.uptime}</dd>
              </div>
              <div>
                <dt>OPERATOR</dt>
                <dd>СИСТЕМА</dd>
              </div>
              <div>
                <dt>PTZ</dt>
                <dd>{selected.ptz ? 'AVAILABLE' : 'FIXED'}</dd>
              </div>
            </dl>
          </Panel>
          <Panel title="ЗАЩИЩЁННАЯ СЕТЬ" eyebrow="SECURITY" className="video-security">
            <dl className="ops-definition-list">
              <div>
                <dt>VPN-ТУННЕЛИ</dt>
                <dd>12</dd>
              </div>
              <div>
                <dt>ШИФРОВАНИЕ</dt>
                <dd>AES-256</dd>
              </div>
              <div>
                <dt>ЦЕЛОСТНОСТЬ</dt>
                <dd className="is-ok">100%</dd>
              </div>
              <div>
                <dt>УГРОЗЫ</dt>
                <dd className="is-ok">НЕ ОБНАРУЖЕНЫ</dd>
              </div>
            </dl>
          </Panel>
          <Panel title="ЖУРНАЛ СОБЫТИЙ" eyebrow="LATEST / 05" className="video-events">
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
            <Panel title="СПУТНИКОВАЯ КАРТА" eyebrow="GEO / CAMERA" className="video-mini-map">
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

          <Panel title="ПЕРЕХВАТ СВЯЗИ" eyebrow="AUDIO / INTERCEPT" className="video-intercepts">
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
                <TerminalButton onClick={() => state.toggleVideo()}>
                  [{state.ui.videoPlaying ? 'Ⅱ' : '▶'}] SAMPLE
                </TerminalButton>
                <TerminalButton onClick={() => state.openDrawer('channel', activeChannel.id)}>
                  [T] TRANSCRIPT
                </TerminalButton>
                <TerminalButton>[+] ADD TO CASE</TerminalButton>
              </footer>
            )}
          </Panel>

          <Panel title="РАСПОЗНАВАНИЕ" eyebrow="LOCAL AI / SYNTHETIC" className="video-recognition">
            <nav>
              <TerminalButton className="is-active">ЛЮДИ</TerminalButton>
              <TerminalButton>ТРАНСПОРТ</TerminalButton>
              <TerminalButton>НОМЕРА</TerminalButton>
            </nav>
            <div>
              {Object.values(state.people)
                .slice(0, 3)
                .map((person, index) => (
                  <TerminalButton
                    key={person.id}
                    onClick={() => router.push(`/objects/${person.objectId}`)}
                  >
                    <i>[FACE {String(index + 1).padStart(2, '0')}]</i>
                    <span>
                      <strong>{person.fullName}</strong>
                      <small>
                        {person.id} / LAST 07:{39 + index}
                      </small>
                    </span>
                    <b>{94 - index * 6}%</b>
                  </TerminalButton>
                ))}
            </div>
          </Panel>

          <Panel title="СЕТЬ / ПИТАНИЕ" eyebrow="CHANNEL HEALTH" className="video-network">
            <div className="video-health-grid">
              <span>
                <small>INCOMING</small>
                <strong>{state.metrics.networkIn} Mb/s</strong>
                <Sparkline
                  label="Входящий трафик"
                  values={[38, 56, 42, 69, 54, 82, 71, state.metrics.networkIn / 4]}
                />
              </span>
              <span>
                <small>OUTGOING</small>
                <strong>{state.metrics.networkOut} Mb/s</strong>
                <Sparkline
                  label="Исходящий трафик"
                  values={[28, 35, 30, 44, 38, 52, 47, state.metrics.networkOut / 3]}
                />
              </span>
              <span>
                <small>POWER</small>
                <strong>228.4 V</strong>
                <ProgressBar value={76} tone="ok" />
              </span>
              <span>
                <small>BACKUP</small>
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

function PtzPanel() {
  const ptz = useOperationsStore((state) => state.ui.ptz);
  const adjust = useOperationsStore((state) => state.adjustPtz);
  const setSpeed = useOperationsStore((state) => state.setPtzSpeed);
  return (
    <Panel title="PTZ CONTROL" eyebrow="VIRTUAL CROP / LOCAL" className="ptz-panel">
      <div className="ptz-pad">
        <TerminalButton onClick={() => adjust('tilt', -5)}>▲</TerminalButton>
        <TerminalButton onClick={() => adjust('pan', -5)}>◀</TerminalButton>
        <TerminalButton
          onClick={() => {
            adjust('pan', -ptz.pan);
            adjust('tilt', -ptz.tilt);
          }}
        >
          ●
        </TerminalButton>
        <TerminalButton onClick={() => adjust('pan', 5)}>▶</TerminalButton>
        <TerminalButton onClick={() => adjust('tilt', 5)}>▼</TerminalButton>
      </div>
      <div className="ptz-controls">
        <TerminalButton onClick={() => adjust('zoom', 0.15)}>[+] ZOOM</TerminalButton>
        <TerminalButton onClick={() => adjust('zoom', -0.15)}>[-] ZOOM</TerminalButton>
        <TerminalButton>[+] FOCUS</TerminalButton>
        <TerminalButton>[-] FOCUS</TerminalButton>
        <TerminalButton>[+] IRIS</TerminalButton>
        <TerminalButton>[-] IRIS</TerminalButton>
      </div>
      <div className="ptz-presets">
        {[1, 2, 3, 4].map((preset) => (
          <TerminalButton key={preset}>PRESET {preset}</TerminalButton>
        ))}
      </div>
      <TerminalSlider
        className="ptz-speed"
        label="PTZ SPEED"
        showValue
        min={10}
        max={100}
        value={ptz.speed}
        onValueChange={setSpeed}
      />
      <footer>
        PAN {ptz.pan.toFixed(0)} / TILT {ptz.tilt.toFixed(0)} / ZOOM {ptz.zoom.toFixed(2)}×
      </footer>
    </Panel>
  );
}
