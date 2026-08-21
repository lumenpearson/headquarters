import { TerminalButton } from '@gremuchaya/ui/primitives';

import { AssetSurface } from './AssetSurface';
import {
  booleanValue,
  numberValue,
  recordArray,
  recordValue,
  stringArray,
  textValue,
  type Payload,
} from './payload';

export function IdleModule({ payload }: { readonly payload: Payload }) {
  return (
    <div className="idle-module">
      <div className="idle-module__reticle" />
      <p>{textValue(payload, 'title', 'ОПЕРАТИВНЫЙ КОНТУР')}</p>
      <span>СИСТЕМА ГОТОВА</span>
    </div>
  );
}

export function MapModule({ payload }: { readonly payload: Payload }) {
  const markers = recordArray(payload, 'markers');
  const readout = recordValue(payload, 'readout');
  return (
    <div className="module-stack">
      <div className="module-heading">
        <span>GEO / LOCAL</span>
        <strong>{textValue(payload, 'title', 'КАРТА')}</strong>
      </div>
      <AssetSurface assetId={textValue(payload, 'mapAsset')} tone="map">
        <svg className="map-routes" viewBox="0 0 1000 600" aria-hidden="true">
          <path d="M80 490C220 360 310 420 430 288S740 186 920 84" />
        </svg>
        {markers.map((marker) => (
          <div
            key={textValue(marker, 'id')}
            className={`map-marker ${booleanValue(marker, 'pulse') ? 'is-pulsing' : ''}`}
            style={{
              left: `${numberValue(marker, 'x') * 100}%`,
              top: `${numberValue(marker, 'y') * 100}%`,
            }}
          >
            <i />
            <span>{textValue(marker, 'label')}</span>
          </div>
        ))}
        <div className="telemetry">
          <span>{textValue(readout, 'object')}</span>
          <strong>{textValue(readout, 'speed')}</strong>
          <span>{textValue(readout, 'signal')}</span>
          <small>{textValue(readout, 'address', '')}</small>
        </div>
      </AssetSurface>
    </div>
  );
}

export function SatelliteModule({ payload }: { readonly payload: Payload }) {
  const target = recordValue(payload, 'target');
  const stage = textValue(payload, 'lossStage', 'clean');
  return (
    <div className={`module-stack satellite satellite--${stage}`}>
      <div className="module-heading">
        <span>{textValue(payload, 'sensorLabel', 'OPTICAL / LOCAL')}</span>
        <strong>{textValue(payload, 'mode')}</strong>
      </div>
      <AssetSurface assetId={textValue(payload, 'assetId')} tone="video">
        <div
          className="target-box"
          style={{
            left: `${numberValue(target, 'x', 0.5) * 100}%`,
            top: `${numberValue(target, 'y', 0.5) * 100}%`,
          }}
        >
          <span>{textValue(target, 'label')}</span>
        </div>
        <div className="satellite-readout">
          <b>{textValue(payload, 'coordinates')}</b>
          <span>ZOOM ×{numberValue(payload, 'zoom', 1).toFixed(1)}</span>
          <span>SIGNAL {numberValue(payload, 'signalQuality')}%</span>
        </div>
        {stage === 'lost' ? <div className="signal-lost">SIGNAL LOST</div> : null}
      </AssetSurface>
    </div>
  );
}

export function CctvModule({ payload }: { readonly payload: Payload }) {
  const mosaic = stringArray(payload, 'mosaic');
  return (
    <div className="module-stack">
      <div className="module-heading">
        <span>{textValue(payload, 'cameraId')}</span>
        <strong>{textValue(payload, 'location')}</strong>
        <em className="online-dot">REC</em>
      </div>
      <AssetSurface assetId={textValue(payload, 'assetId')} tone="video">
        {mosaic.length > 0 ? (
          <div className="cctv-mosaic">
            {mosaic.map((asset, index) => (
              <div
                key={asset}
                className={index === numberValue(payload, 'selectedCamera') ? 'is-selected' : ''}
              >
                <span>CAM {String(index + 1).padStart(2, '0')}</span>
              </div>
            ))}
          </div>
        ) : null}
        <div className="cctv-time">
          {textValue(payload, 'timestamp')} ·{' '}
          {booleanValue(payload, 'muted', true) ? 'MUTED' : 'AUDIO ON'} ·{' '}
          {booleanValue(payload, 'playing', true) ? 'PLAY' : 'FREEZE'}
        </div>
      </AssetSurface>
    </div>
  );
}

export function NewsModule({ payload }: { readonly payload: Payload }) {
  return (
    <div className="module-stack">
      <AssetSurface assetId={textValue(payload, 'assetId', '')} tone="video">
        <div className="news-bug">{textValue(payload, 'mode', 'LIVE')}</div>
        <div className="news-lower">
          <strong>{textValue(payload, 'title')}</strong>
          <span>{textValue(payload, 'lowerThird')}</span>
        </div>
      </AssetSurface>
    </div>
  );
}

export function PhotoArchiveModule({ payload }: { readonly payload: Payload }) {
  const assets = stringArray(payload, 'assetIds');
  const selected = numberValue(payload, 'selectedIndex');
  return (
    <div className="photo-archive">
      <div className="module-heading">
        <span>ARCHIVE / PHOTO</span>
        <strong>{textValue(payload, 'title')}</strong>
      </div>
      <div className={`photo-grid ${booleanValue(payload, 'comparison') ? 'is-comparison' : ''}`}>
        {assets.map((asset, index) => (
          <TerminalButton key={asset} className={index === selected ? 'is-selected' : ''}>
            <AssetSurface assetId={asset} />
            <span>{String(index + 1).padStart(2, '0')}</span>
          </TerminalButton>
        ))}
      </div>
    </div>
  );
}

export function AudioModule({ payload }: { readonly payload: Payload }) {
  const channels = recordArray(payload, 'channels');
  return (
    <div className="audio-module">
      <div className="module-heading">
        <span>AUDIO / SYNC</span>
        <strong>{textValue(payload, 'timestamp')}</strong>
      </div>
      {channels.map((channel) => (
        <div className="audio-channel" key={textValue(channel, 'id')}>
          <span>{textValue(channel, 'label')}</span>
          <svg viewBox="0 0 600 70" preserveAspectRatio="none">
            <path d="M0 35L25 24 50 44 75 12 100 55 125 29 150 38 175 16 200 52 225 22 250 41 275 8 300 57 325 33 350 46 375 18 400 51 425 27 450 38 475 14 500 48 525 31 550 42 575 25 600 35" />
          </svg>
          <b>{Math.round(numberValue(channel, 'level') * 100)}%</b>
        </div>
      ))}
    </div>
  );
}
