import { AssetSurface } from './AssetSurface';
import { matrix, numberValue, recordArray, stringArray, textValue, type Payload } from './payload';

export function SystemTablesModule({ payload }: { readonly payload: Payload }) {
  const columns = stringArray(payload, 'columns');
  const rows = matrix(payload, 'rows');
  return (
    <div className="system-table">
      <div className="module-heading">
        <span>SYSTEM / LOCAL</span>
        <strong>{textValue(payload, 'title')}</strong>
      </div>
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${index}-${String(row[0])}`}>
              {row.map((cell, cellIndex) => (
                <td key={`${cellIndex}-${String(cell)}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InterrogationModule({ payload }: { readonly payload: Payload }) {
  return (
    <div className="module-stack">
      <div className="module-heading">
        <span>{textValue(payload, 'room')}</span>
        <strong>INTERROGATION / ARCHIVE</strong>
      </div>
      <AssetSurface assetId={textValue(payload, 'assetId')} tone="video">
        <div className="cctv-time">
          {textValue(payload, 'timestamp')} · {textValue(payload, 'audioChannel')} ·{' '}
          {payload.playing === false ? 'FREEZE' : 'PLAY'}
        </div>
      </AssetSurface>
    </div>
  );
}

export function SecurityModule({ payload }: { readonly payload: Payload }) {
  const status = textValue(payload, 'status');
  return (
    <div className={`security-module security-module--${status.replace(' ', '-').toLowerCase()}`}>
      <AssetSurface assetId={textValue(payload, 'assetId', '')} tone="video">
        <div className="security-status">
          <span>{textValue(payload, 'cameraId')}</span>
          <strong>{status}</strong>
          <small>
            {status === 'RECONNECTING'
              ? `ATTEMPT ${numberValue(payload, 'attempt')}`
              : 'SECURE LOCAL CHANNEL'}
          </small>
        </div>
      </AssetSurface>
    </div>
  );
}

export function PrintModule({ payload }: { readonly payload: Payload }) {
  return (
    <div className="print-module">
      <span>LOCAL PRINT SPOOLER</span>
      <strong>{textValue(payload, 'documentLabel')}</strong>
      <div>
        <i style={{ width: `${numberValue(payload, 'progress')}%` }} />
      </div>
      <b>
        {textValue(payload, 'status')} / {numberValue(payload, 'progress')}%
      </b>
      <small>{textValue(payload, 'jobId')}</small>
    </div>
  );
}

export function AccessModule({ payload }: { readonly payload: Payload }) {
  return (
    <div className="access-module">
      <span>{textValue(payload, 'checkpoint')}</span>
      <strong>{textValue(payload, 'status')}</strong>
      <p>{textValue(payload, 'subject')}</p>
      <small>{textValue(payload, 'timestamp')}</small>
    </div>
  );
}

export function ExplorerModule({ payload }: { readonly payload: Payload }) {
  return (
    <div className="embedded-explorer">
      <span>VIRTUAL EXPLORER</span>
      <strong>{textValue(payload, 'path', '/')}</strong>
      <div>
        {['ДЕЛА', 'МЕДИА', 'КАРТЫ', 'ВХОДЯЩИЕ'].map((name) => (
          <p key={name}>▱ {name}</p>
        ))}
      </div>
    </div>
  );
}

export function GenericSystemModule({
  payload,
  label,
}: {
  readonly payload: Payload;
  readonly label: string;
}) {
  return (
    <div className="generic-module">
      <span>{label}</span>
      <strong>{textValue(payload, 'title', label)}</strong>
      <pre>{JSON.stringify(payload, null, 2)}</pre>
    </div>
  );
}

export function AudioFallback({ payload }: { readonly payload: Payload }) {
  return <div>{recordArray(payload, 'channels').length}</div>;
}
