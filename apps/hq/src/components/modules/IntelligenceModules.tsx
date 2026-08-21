import { AssetSurface } from './AssetSurface';
import { numberValue, recordArray, stringArray, textValue, type Payload } from './payload';

export function DossierModule({ payload }: { readonly payload: Payload }) {
  const photos = stringArray(payload, 'portraitAssetIds');
  return (
    <div className="dossier-module">
      <header>
        <span>{textValue(payload, 'category')}</span>
        <strong>{textValue(payload, 'displayName')}</strong>
        <em>{textValue(payload, 'status')}</em>
      </header>
      <div className="dossier-body">
        <div className="dossier-portrait">
          <AssetSurface assetId={photos[0]} />
        </div>
        <div className="dossier-copy">
          <p>{textValue(payload, 'summary')}</p>
          <ul>
            {stringArray(payload, 'facts').map((fact) => (
              <li key={fact}>{fact}</li>
            ))}
          </ul>
          <div>
            {stringArray(payload, 'relatedMaterials').map((material) => (
              <span key={material}>{material}</span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function OsintModule({ payload }: { readonly payload: Payload }) {
  const results = recordArray(payload, 'results');
  return (
    <div className="osint-module">
      <div className="module-heading">
        <span>OSINT / {textValue(payload, 'stage')}</span>
        <strong>{textValue(payload, 'title')}</strong>
      </div>
      <div className="search-line">
        <span>›</span>
        <b>{textValue(payload, 'query')}</b>
        <i />
      </div>
      <div className="osint-results">
        {results.map((result, index) => (
          <div key={textValue(result, 'id')}>
            <AssetSurface assetId={textValue(result, 'assetId', '')} />
            <span>{String(index + 1).padStart(2, '0')}</span>
            <strong>{textValue(result, 'title')}</strong>
            <small>{textValue(result, 'metadata')}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FaceModule({ payload }: { readonly payload: Payload }) {
  const state = textValue(payload, 'state');
  return (
    <div className={`face-module face-module--${state.toLowerCase()}`}>
      <div className="module-heading">
        <span>BIOMETRIC / LOCAL</span>
        <strong>{state}</strong>
      </div>
      <div className="face-compare">
        <AssetSurface assetId={textValue(payload, 'sourceAssetId', '')}>
          <div className="face-box" />
        </AssetSurface>
        <div className="face-score">
          <span>COMPARE</span>
          <strong>{numberValue(payload, 'similarity')}%</strong>
          <i />
        </div>
        <AssetSurface assetId={textValue(payload, 'archiveAssetId', '')} />
      </div>
      <footer>{textValue(payload, 'candidateName', 'НЕУСТАНОВЛЕННОЕ ЛИЦО')}</footer>
    </div>
  );
}

export function VehicleModule({ payload }: { readonly payload: Payload }) {
  const vehicles = recordArray(payload, 'vehicles');
  return (
    <div className="module-stack">
      <div className="module-heading">
        <span>VEHICLE / TRACK</span>
        <strong>{textValue(payload, 'title')}</strong>
      </div>
      <AssetSurface assetId={textValue(payload, 'assetId')} tone="video">
        {vehicles.map((vehicle) => (
          <div
            key={textValue(vehicle, 'id')}
            className={`vehicle-box ${vehicle.active === true ? 'is-active' : ''}`}
            style={{
              left: `${numberValue(vehicle, 'x') * 100}%`,
              top: `${numberValue(vehicle, 'y') * 100}%`,
              width: `${numberValue(vehicle, 'width') * 100}%`,
              height: `${numberValue(vehicle, 'height') * 100}%`,
            }}
          >
            <span>
              {textValue(vehicle, 'label')} / {textValue(vehicle, 'class')}
            </span>
          </div>
        ))}
      </AssetSurface>
    </div>
  );
}

export function GraphModule({ payload }: { readonly payload: Payload }) {
  const nodes = recordArray(payload, 'nodes');
  const edges = recordArray(payload, 'edges');
  const byId = new Map(nodes.map((node) => [textValue(node, 'id'), node]));
  return (
    <div className="graph-module">
      <div className="module-heading">
        <span>{textValue(payload, 'stage')}</span>
        <strong>{textValue(payload, 'title')}</strong>
      </div>
      <svg viewBox="0 0 1000 620">
        {edges.map((edge, index) => {
          const from = byId.get(textValue(edge, 'from'));
          const to = byId.get(textValue(edge, 'to'));
          if (from === undefined || to === undefined) return null;
          return (
            <line
              key={`${textValue(edge, 'from')}-${textValue(edge, 'to')}-${index}`}
              x1={numberValue(from, 'x') * 1000}
              y1={numberValue(from, 'y') * 620}
              x2={numberValue(to, 'x') * 1000}
              y2={numberValue(to, 'y') * 620}
              className={edge.active === true ? 'is-active' : ''}
            />
          );
        })}
      </svg>
      {nodes.map((node) => (
        <div
          className={`graph-node graph-node--${textValue(node, 'kind')}`}
          key={textValue(node, 'id')}
          style={{
            left: `${numberValue(node, 'x') * 100}%`,
            top: `${numberValue(node, 'y') * 100}%`,
          }}
        >
          <i />
          <span>{textValue(node, 'label')}</span>
        </div>
      ))}
    </div>
  );
}

export function CommsModule({ payload }: { readonly payload: Payload }) {
  const hops = recordArray(payload, 'hops');
  return (
    <div className="comms-module">
      <div className="module-heading">
        <span>INTERCEPT / VOICE</span>
        <strong>{textValue(payload, 'status')}</strong>
      </div>
      <div className="comms-target">
        <span>АБОНЕНТ</span>
        <strong>{textValue(payload, 'target')}</strong>
        <small>ИСТОЧНИК: {textValue(payload, 'source')}</small>
      </div>
      <div className="comms-network">
        {hops.map((hop) => (
          <div
            key={textValue(hop, 'label')}
            style={{
              left: `${numberValue(hop, 'x') * 100}%`,
              top: `${numberValue(hop, 'y') * 100}%`,
            }}
          >
            <i />
            <span>{textValue(hop, 'label')}</span>
          </div>
        ))}
      </div>
      <footer>
        {textValue(payload, 'status') === 'CONNECTED' ? 'КАНАЛ ОТКРЫТ' : 'ВХОДЯЩЕЕ СОЕДИНЕНИЕ'}
      </footer>
    </div>
  );
}
