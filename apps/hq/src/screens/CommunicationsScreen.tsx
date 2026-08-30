'use client';

import { useMemo, useState } from 'react';
import { TerminalButton } from '@gremuchaya/ui/primitives';

import { dateTimeFormat } from '@/application/localization/intl';
import { useTranslate } from '@/application/localization/locale';
import { channelDomain } from '@/application/simulation/simulationCurves';
import { TileGrid, type ScreenTile } from '@/components/layout/TileGrid';
import { Panel, ProgressBar, Sparkline, StatusBadge } from '@/components/operations/OpsUi';
import { useOperationsStore } from '@/state/operationsStore';

const clockParts = { timeStyle: 'medium' } as const;

export function CommunicationsScreen() {
  const translate = useTranslate();
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
        title: translate('comms.channelsTitle'),
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
          <Panel
            title={translate('comms.channelsTitle')}
            eyebrow={translate('comms.channelsEyebrow')}
            className="channel-matrix"
          >
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
        title: translate('comms.activeChannelTitle'),
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
            title={translate('comms.activeChannelTitle')}
            eyebrow={selected?.id ?? translate('comms.noChannelEyebrow')}
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
                    <span>{translate('comms.liveAudioBufferLabel')}</span>
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
                    {muted.includes(selected.id)
                      ? translate('comms.mutedButton')
                      : translate('comms.muteButton')}
                  </TerminalButton>
                  <TerminalButton
                    className={solo === selected.id ? 'is-active' : ''}
                    onClick={() => setSolo((id) => (id === selected.id ? null : selected.id))}
                  >
                    {translate('comms.soloButton')}
                  </TerminalButton>
                  <TerminalButton onClick={() => state.toggleVideo()}>
                    {translate('comms.sampleButton', {
                      icon: state.ui.videoPlaying ? 'Ⅱ' : '▶',
                    })}
                  </TerminalButton>
                  <TerminalButton onClick={() => state.openDrawer('channel', selected.id)}>
                    {translate('comms.transcriptButton')}
                  </TerminalButton>
                  <TerminalButton>{translate('comms.markEventButton')}</TerminalButton>
                  <TerminalButton>{translate('drawer.attachToCase')}</TerminalButton>
                </div>
                <dl className="ops-definition-list">
                  <div>
                    <dt>{translate('field.encryption')}</dt>
                    <dd>{selected.encryption}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.operator')}</dt>
                    <dd>{selected.operator}</dd>
                  </div>
                  <div>
                    <dt>{translate('field.load')}</dt>
                    <dd>{selected.load}%</dd>
                  </div>
                  <div>
                    <dt>{translate('field.packetLoss')}</dt>
                    <dd>{selected.packetLoss}%</dd>
                  </div>
                  <div>
                    <dt>{translate('field.latency')}</dt>
                    <dd>
                      {selected.latency} {translate('unit.ms')}
                    </dd>
                  </div>
                  <div>
                    <dt>{translate('field.signal')}</dt>
                    <dd>{selected.signal}%</dd>
                  </div>
                </dl>
              </>
            )}
          </Panel>
        ),
      },
      {
        title: translate('comms.transcriptTitle'),
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
            title={translate('comms.transcriptTitle')}
            eyebrow={translate('comms.transcriptEyebrow')}
            className="communications-transcript"
          >
            <pre>{selected?.transcript.join('\n\n') ?? translate('comms.noChannelAssigned')}</pre>
            <footer>{translate('comms.transcriptFooterLabel')}</footer>
          </Panel>
        ),
      },
      {
        title: translate('comms.trafficTitle'),
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
            title={translate('comms.trafficTitle')}
            eyebrow={translate('comms.trafficEyebrow')}
            className="communications-traffic"
          >
            <div className="traffic-metrics">
              <span>
                <small>{translate('comms.inLabel')}</small>
                <strong>
                  {state.metrics.networkIn} {translate('unit.mbps')}
                </strong>
                <Sparkline
                  values={state.metricsHistory.networkIn}
                  domain={channelDomain('network-in')}
                  label={translate('comms.inboundTrafficLabel')}
                />
              </span>
              <span>
                <small>{translate('comms.outLabel')}</small>
                <strong>
                  {state.metrics.networkOut} {translate('unit.mbps')}
                </strong>
                <Sparkline
                  values={state.metricsHistory.networkOut}
                  domain={channelDomain('network-out')}
                  label={translate('comms.outboundTrafficLabel')}
                />
              </span>
              <span>
                <small>{translate('comms.avgLatencyLabel')}</small>
                <strong>
                  {Math.round(
                    Object.values(state.channels).reduce(
                      (sum, channel) => sum + channel.latency,
                      0,
                    ) / Object.values(state.channels).length,
                  )}{' '}
                  {translate('unit.ms')}
                </strong>
                <ProgressBar value={68} tone="ok" />
              </span>
            </div>
          </Panel>
        ),
      },
      {
        title: translate('comms.logTitle'),
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
          <Panel
            title={translate('comms.logTitle')}
            eyebrow={translate('comms.logEyebrow')}
            className="message-log"
          >
            <div className="event-feed">
              {state.events
                .filter((event) => event.type.startsWith('communication'))
                .slice(0, presentation === 'full' ? 10 : 4)
                .map((event) => (
                  <TerminalButton
                    key={event.id}
                    onClick={() => state.openDrawer('event', event.id)}
                  >
                    <time>{dateTimeFormat(clockParts).format(new Date(event.timestamp))}</time>
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
    [muted, selected, solo, state, translate],
  );

  return (
    <div className="ops-screen communications-screen">
      <header className="ops-screen__title">
        <div>
          <span>{translate('comms.headerEyebrow')}</span>
          <h1>{translate('comms.headerTitle')}</h1>
        </div>
        <div className="comms-summary">
          <span>
            <small>{translate('comms.channelsCountLabel')}</small>
            <strong>{Object.keys(state.channels).length}</strong>
          </span>
          <span>
            <small>{translate('comms.securedCountLabel')}</small>
            <strong>
              {
                Object.values(state.channels).filter((channel) => channel.status === 'SECURED')
                  .length
              }
            </strong>
          </span>
          <span>
            <small>{translate('comms.interceptsCountLabel')}</small>
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
