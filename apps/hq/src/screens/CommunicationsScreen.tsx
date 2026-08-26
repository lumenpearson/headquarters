'use client';

import { useMemo, useState } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { channelDomain } from '@/application/simulation/simulationCurves';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { Panel, ProgressBar, Sparkline, StatusBadge } from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

export function CommunicationsScreen() {
  const state = useOperationsStore((value) => value);
  const [muted, setMuted] = useState<readonly string[]>([]);
  const [solo, setSolo] = useState<string | null>(null);
  const selected = state.channels[state.ui.selectedChannelId] ?? Object.values(state.channels)[0];

  /*
   * A master and its detail cannot be sent to different places: `active` and
   * `transcript` show whichever channel was picked in `channels`, and a route
   * that showed a different channel would be worse than saying they did not
   * fit. `traffic` and `log` are readings of records that `/system` and
   * `/analytics` hold in full, so those two do name a route.
   */
  const tiles: readonly ScreenTile[] = useMemo(
    () => [
      {
        title: 'АКТИВНЫЕ КАНАЛЫ',
        category: 'records',
        descriptor: {
          id: 'channels',
          priority: 100,
          variants: [
            { presentation: 'full', columns: 1, rows: 2 },
            { presentation: 'compact', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
        },
        render: () => (
          <Panel title="АКТИВНЫЕ КАНАЛЫ" eyebrow="CHANNEL MATRIX / LIVE" className="channel-matrix">
            <div className="channel-list">
              {Object.values(state.channels).map((channel) => (
                <TerminalButton
                  key={channel.id}
                  className={`${channel.id === selected?.id ? 'is-selected' : ''} ${muted.includes(channel.id) ? 'is-muted' : ''}`}
                  onClick={() => state.selectChannel(channel.id)}
                >
                  <span>
                    <strong>{channel.id}</strong>
                    <small>{channel.name}</small>
                  </span>
                  <i>{channel.kind.toUpperCase()}</i>
                  <ProgressBar
                    value={channel.signal}
                    tone={channel.status === 'SIGNAL_LOST' ? 'critical' : 'ok'}
                  />
                  <b>{channel.latency}ms</b>
                  <StatusBadge status={channel.status} />
                </TerminalButton>
              ))}
            </div>
          </Panel>
        ),
      },
      {
        title: 'АКТИВНЫЙ КАНАЛ',
        category: 'detail',
        descriptor: {
          id: 'active',
          priority: 95,
          variants: [
            { presentation: 'full', columns: 2, rows: 2 },
            { presentation: 'compact', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: (presentation) => (
          <Panel
            title="АКТИВНЫЙ КАНАЛ"
            eyebrow={selected?.id ?? 'NO CHANNEL'}
            className="active-channel-panel"
          >
            {selected === undefined ? null : (
              <>
                <header>
                  <div>
                    <span>{selected.kind.toUpperCase()}</span>
                    <strong>{selected.name}</strong>
                  </div>
                  <StatusBadge status={selected.status} />
                </header>
                {presentation === 'full' ? (
                  <div className="large-waveform">
                    <svg viewBox="0 0 900 180" preserveAspectRatio="none">
                      <path d="M0 90L20 65 40 118 60 38 80 142 100 79 120 102 140 54 160 127 180 69 200 98 220 31 240 151 260 84 280 106 300 48 320 132 340 73 360 113 380 35 400 145 420 81 440 99 460 42 480 136 500 68 520 116 540 51 560 128 580 77 600 103 620 28 640 154 660 86 680 108 700 45 720 139 740 71 760 119 780 57 800 125 820 76 840 106 860 39 880 141 900 90" />
                    </svg>
                    <span>LIVE AUDIO / BUFFER 00:00:18.420</span>
                  </div>
                ) : null}
                <div className="channel-actions">
                  <TerminalButton
                    onClick={() =>
                      setMuted((items) =>
                        items.includes(selected.id)
                          ? items.filter((id) => id !== selected.id)
                          : [...items, selected.id],
                      )
                    }
                  >
                    [{muted.includes(selected.id) ? 'MUTED' : 'MUTE'}]
                  </TerminalButton>
                  <TerminalButton
                    className={solo === selected.id ? 'is-active' : ''}
                    onClick={() => setSolo((id) => (id === selected.id ? null : selected.id))}
                  >
                    [SOLO]
                  </TerminalButton>
                  <TerminalButton onClick={() => state.toggleVideo()}>
                    [{state.ui.videoPlaying ? 'Ⅱ' : '▶'}] SAMPLE
                  </TerminalButton>
                  <TerminalButton onClick={() => state.openDrawer('channel', selected.id)}>
                    [T] TRANSCRIPT
                  </TerminalButton>
                  <TerminalButton>[M] MARK EVENT</TerminalButton>
                  <TerminalButton>[+] ATTACH TO CASE</TerminalButton>
                </div>
                <dl className="ops-definition-list">
                  <div>
                    <dt>ШИФРОВАНИЕ</dt>
                    <dd>{selected.encryption}</dd>
                  </div>
                  <div>
                    <dt>ОПЕРАТОР</dt>
                    <dd>{selected.operator}</dd>
                  </div>
                  <div>
                    <dt>LOAD</dt>
                    <dd>{selected.load}%</dd>
                  </div>
                  <div>
                    <dt>PACKET LOSS</dt>
                    <dd>{selected.packetLoss}%</dd>
                  </div>
                  <div>
                    <dt>LATENCY</dt>
                    <dd>{selected.latency} MS</dd>
                  </div>
                  <div>
                    <dt>SIGNAL</dt>
                    <dd>{selected.signal}%</dd>
                  </div>
                </dl>
              </>
            )}
          </Panel>
        ),
      },
      {
        title: 'ТРАНСКРИПТ',
        category: 'detail',
        descriptor: {
          id: 'transcript',
          priority: 85,
          variants: [
            { presentation: 'full', columns: 1, rows: 2 },
            { presentation: 'compact', columns: 1, rows: 1 },
          ],
          canStretchVertically: true,
          hideWhenOverflow: true,
        },
        render: () => (
          <Panel
            title="ТРАНСКРИПТ"
            eyebrow="VOICE TO TEXT / LOCAL"
            className="communications-transcript"
          >
            <pre>{selected?.transcript.join('\n\n') ?? 'КАНАЛ НЕ НАЗНАЧЕН'}</pre>
            <footer>LANG: RU / CONFIDENCE 96.2% / LOCAL MODEL</footer>
          </Panel>
        ),
      },
      {
        title: 'ТРАФИК / ЗАДЕРЖКА',
        category: 'telemetry',
        descriptor: {
          id: 'traffic',
          priority: 80,
          variants: [{ presentation: 'full', columns: 1, rows: 1 }],
          canStretchHorizontally: true,
          canStretchVertically: true,
          relocationRoute: '/system',
        },
        render: () => (
          <Panel
            title="ТРАФИК / ЗАДЕРЖКА"
            eyebrow="NETWORK / 60 MIN"
            className="communications-traffic"
          >
            <div className="traffic-metrics">
              <span>
                <small>IN</small>
                <strong>{state.metrics.networkIn} MB/S</strong>
                <Sparkline
                  values={state.metricsHistory.networkIn}
                  domain={channelDomain('network-in')}
                  label="Входящий трафик"
                />
              </span>
              <span>
                <small>OUT</small>
                <strong>{state.metrics.networkOut} MB/S</strong>
                <Sparkline
                  values={state.metricsHistory.networkOut}
                  domain={channelDomain('network-out')}
                  label="Исходящий трафик"
                />
              </span>
              <span>
                <small>AVG LATENCY</small>
                <strong>
                  {Math.round(
                    Object.values(state.channels).reduce(
                      (sum, channel) => sum + channel.latency,
                      0,
                    ) / Object.values(state.channels).length,
                  )}{' '}
                  MS
                </strong>
                <ProgressBar value={68} tone="ok" />
              </span>
            </div>
          </Panel>
        ),
      },
      {
        title: 'ЖУРНАЛ СООБЩЕНИЙ',
        category: 'events',
        descriptor: {
          id: 'log',
          priority: 75,
          variants: [
            { presentation: 'full', columns: 2, rows: 1 },
            { presentation: 'minimal', columns: 1, rows: 1 },
          ],
          canStretchHorizontally: true,
          relocationRoute: '/analytics',
        },
        render: (presentation) => (
          <Panel title="ЖУРНАЛ СООБЩЕНИЙ" eyebrow="MESSAGE LOG / AUDIT" className="message-log">
            <div className="event-feed">
              {state.events
                .filter((event) => event.type.startsWith('communication'))
                .slice(0, presentation === 'full' ? 10 : 4)
                .map((event) => (
                  <TerminalButton
                    key={event.id}
                    onClick={() => state.openDrawer('event', event.id)}
                  >
                    <time>{new Date(event.timestamp).toLocaleTimeString('ru-RU')}</time>
                    <i className={`severity-dot severity-dot--${event.severity}`} />
                    <span>
                      <strong>{event.title}</strong>
                      <small>{event.description}</small>
                    </span>
                  </TerminalButton>
                ))}
            </div>
          </Panel>
        ),
      },
    ],
    [muted, selected, solo, state],
  );

  return (
    <div className="ops-screen communications-screen">
      <header className="ops-screen__title">
        <div>
          <span>COMMS / ENCRYPTED / LOCAL</span>
          <h1>ЦЕНТР ЗАЩИЩЁННОЙ СВЯЗИ</h1>
        </div>
        <div className="comms-summary">
          <span>
            <small>CHANNELS</small>
            <strong>{Object.keys(state.channels).length}</strong>
          </span>
          <span>
            <small>SECURED</small>
            <strong>
              {
                Object.values(state.channels).filter((channel) => channel.status === 'SECURED')
                  .length
              }
            </strong>
          </span>
          <span>
            <small>INTERCEPTS</small>
            <strong>
              {
                Object.values(state.channels).filter((channel) => channel.kind === 'intercept')
                  .length
              }
            </strong>
          </span>
        </div>
      </header>
      <TileGrid
        tiles={tiles}
        columns={3}
        className="communications-layout"
        screen="communications"
      />
    </div>
  );
}
