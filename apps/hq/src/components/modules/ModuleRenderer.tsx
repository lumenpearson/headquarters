import type { ModuleId, ModulePayload } from '@gremuchaya/domain';

import {
  AudioModule,
  CctvModule,
  IdleModule,
  MapModule,
  NewsModule,
  PhotoArchiveModule,
  SatelliteModule,
} from './VisualModules';
import {
  CommsModule,
  DossierModule,
  FaceModule,
  GraphModule,
  OsintModule,
  VehicleModule,
} from './IntelligenceModules';
import {
  AccessModule,
  ExplorerModule,
  InterrogationModule,
  PrintModule,
  SecurityModule,
  SystemTablesModule,
} from './SystemModules';

export function ModuleRenderer({
  module,
  payload,
}: {
  readonly module: ModuleId;
  readonly payload: ModulePayload;
}) {
  switch (module) {
    case 'idle':
      return <IdleModule payload={payload} />;
    case 'map':
      return <MapModule payload={payload} />;
    case 'satellite':
      return <SatelliteModule payload={payload} />;
    case 'cctv':
      return <CctvModule payload={payload} />;
    case 'dossier':
      return <DossierModule payload={payload} />;
    case 'osint':
      return <OsintModule payload={payload} />;
    case 'face-recognition':
      return <FaceModule payload={payload} />;
    case 'vehicle-recognition':
      return <VehicleModule payload={payload} />;
    case 'comms':
      return <CommsModule payload={payload} />;
    case 'graph':
      return <GraphModule payload={payload} />;
    case 'news':
      return <NewsModule payload={payload} />;
    case 'access':
      return <AccessModule payload={payload} />;
    case 'system-tables':
      return <SystemTablesModule payload={payload} />;
    case 'audio':
      return <AudioModule payload={payload} />;
    case 'photo-archive':
      return <PhotoArchiveModule payload={payload} />;
    case 'interrogation':
      return <InterrogationModule payload={payload} />;
    case 'security':
      return <SecurityModule payload={payload} />;
    case 'explorer':
      return <ExplorerModule payload={payload} />;
    case 'print':
      return <PrintModule payload={payload} />;
  }
}
