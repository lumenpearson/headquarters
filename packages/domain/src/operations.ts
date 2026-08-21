export type OpsStatus =
  | 'ACTIVE'
  | 'READY'
  | 'NORMAL'
  | 'SECURED'
  | 'IN_PROGRESS'
  | 'WAITING'
  | 'RESERVE'
  | 'WATCHED'
  | 'RESTRICTED'
  | 'SIGNAL_LOST'
  | 'ALERT'
  | 'CRITICAL'
  | 'NEUTRALIZED'
  | 'ARCHIVED';

export type OpsSeverity = 'info' | 'normal' | 'warning' | 'critical';
export type AlertLifecycle = 'NEW' | 'ACKNOWLEDGED' | 'IN_PROGRESS' | 'RESOLVED';
export type ObjectKind =
  'person' | 'vehicle' | 'address' | 'organization' | 'camera' | 'device' | 'point' | 'group';
export type FileKind = 'image' | 'video' | 'audio' | 'document' | 'report' | 'map' | 'data';

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
  readonly x: number;
  readonly y: number;
}

export interface Operation {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly summary: string;
  readonly status: OpsStatus;
  readonly progress: number;
  readonly priority: string;
  readonly threatLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  readonly startedAt: string;
  readonly expectedEndAt: string;
  readonly currentPhase: number;
}

export interface Sector {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly threat: number;
  readonly readiness: number;
  readonly center: GeoPoint;
  readonly status: OpsStatus;
}

export interface OperationalObject {
  readonly id: string;
  readonly name: string;
  readonly callsign: string;
  readonly kind: ObjectKind;
  readonly status: OpsStatus;
  readonly sectorId: string;
  readonly position: GeoPoint;
  readonly speed: number;
  readonly altitude: number;
  readonly threat: number;
  readonly signal: number;
  readonly channelId: string;
  readonly source: string;
  readonly lastSeenAt: string;
  readonly linkedCaseIds: readonly string[];
  readonly linkedFileIds: readonly string[];
}

export interface Person {
  readonly id: string;
  readonly objectId: string;
  readonly fullName: string;
  readonly aliases: readonly string[];
  readonly birthDate: string;
  readonly citizenship: string;
  readonly role: string;
  readonly status: OpsStatus;
  readonly riskScore: number;
  readonly documentCode: string;
  readonly addresses: readonly string[];
  readonly tags: readonly string[];
}

export interface Camera {
  readonly id: string;
  readonly objectId: string;
  readonly location: string;
  readonly sectorId: string;
  readonly position: GeoPoint;
  readonly status: OpsStatus;
  readonly signal: number;
  readonly resolution: string;
  readonly fps: number;
  readonly bitrate: string;
  readonly codec: string;
  readonly recording: boolean;
  readonly ptz: boolean;
  readonly uptime: string;
}

export interface CaseFile {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly status: OpsStatus;
  readonly createdAt: string;
  readonly source: string;
  readonly dossierCode: string;
  readonly subjectPersonId: string;
  readonly linkedObjectIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly tags: readonly string[];
  readonly priority: number;
}

export interface Attachment {
  readonly id: string;
  readonly title: string;
  readonly kind: FileKind;
  readonly status: OpsStatus;
  readonly createdAt: string;
  readonly source: string;
  readonly classification: 'БЕТА' | 'АЛЬФА' | 'А1';
  readonly tags: readonly string[];
  readonly linkedCaseIds: readonly string[];
  readonly linkedObjectIds: readonly string[];
  readonly sizeLabel: string;
  readonly preview: string;
}

export interface OpsEvent {
  readonly id: string;
  readonly type:
    | 'object.updated'
    | 'object.enteredSector'
    | 'object.leftSector'
    | 'camera.motion'
    | 'camera.signalLost'
    | 'camera.signalRestored'
    | 'communication.intercepted'
    | 'communication.signalLost'
    | 'case.updated'
    | 'file.added'
    | 'task.completed'
    | 'threat.changed'
    | 'system.warning'
    | 'system.recovered';
  readonly timestamp: string;
  readonly severity: OpsSeverity;
  readonly source: string;
  readonly title: string;
  readonly description: string;
  readonly linkedObjectIds: readonly string[];
  readonly linkedCaseIds: readonly string[];
  readonly linkedCameraId: string | null;
  readonly coordinates: GeoPoint | null;
  readonly status: OpsStatus;
}

export interface Alert {
  readonly id: string;
  readonly level: OpsSeverity;
  readonly source: string;
  readonly timestamp: string;
  readonly title: string;
  readonly description: string;
  readonly linkedEntityId: string;
  readonly lifecycle: AlertLifecycle;
  readonly sectorId: string;
  readonly coordinates: GeoPoint;
}

export interface OpsTask {
  readonly id: string;
  readonly title: string;
  readonly direction: 'intelligence' | 'collection' | 'analysis' | 'operations' | 'support';
  readonly status: 'completed' | 'active' | 'waiting' | 'blocked';
  readonly progress: number;
  readonly linkedObjectIds: readonly string[];
  readonly linkedCaseIds: readonly string[];
}

export interface TacticalRoute {
  readonly id: string;
  readonly name: string;
  readonly kind: 'primary' | 'alternative' | 'reserve' | 'evacuation';
  readonly status: OpsStatus;
  readonly lengthKm: number;
  readonly etaMinutes: number;
  readonly risk: number;
  readonly progress: number;
  readonly points: readonly GeoPoint[];
}

export interface CommunicationChannel {
  readonly id: string;
  readonly name: string;
  readonly kind: 'voice' | 'data' | 'intercept' | 'reserve';
  readonly status: OpsStatus;
  readonly encryption: string;
  readonly load: number;
  readonly packetLoss: number;
  readonly latency: number;
  readonly signal: number;
  readonly operator: string;
  readonly transcript: readonly string[];
}

export interface Sensor {
  readonly id: string;
  readonly name: string;
  readonly kind: 'radar' | 'optical' | 'infrared' | 'acoustic' | 'data-link';
  readonly status: OpsStatus;
  readonly signal: number;
  readonly sectorId: string;
}

export interface SystemNode {
  readonly id: string;
  readonly name: string;
  readonly kind: 'server' | 'database' | 'storage' | 'monitoring' | 'reserve';
  readonly status: OpsStatus;
  readonly load: number;
  readonly temperature: number;
  readonly ip: string;
}

export interface AnalyticalInsight {
  readonly id: string;
  readonly priority: OpsSeverity;
  readonly title: string;
  readonly explanation: string;
  readonly timestamp: string;
  readonly linkedObjectIds: readonly string[];
  readonly completed: boolean;
}

export interface OpsReport {
  readonly id: string;
  readonly title: string;
  readonly kind:
    | 'operation'
    | 'object'
    | 'sector'
    | 'incident'
    | 'communications'
    | 'video'
    | 'system'
    | 'analytics';
  readonly createdAt: string;
  readonly status: OpsStatus;
}

export interface OperationsWorldData {
  readonly operation: Operation;
  readonly sectors: readonly Sector[];
  readonly objects: readonly OperationalObject[];
  readonly people: readonly Person[];
  readonly cameras: readonly Camera[];
  readonly cases: readonly CaseFile[];
  readonly attachments: readonly Attachment[];
  readonly events: readonly OpsEvent[];
  readonly alerts: readonly Alert[];
  readonly tasks: readonly OpsTask[];
  readonly routes: readonly TacticalRoute[];
  readonly channels: readonly CommunicationChannel[];
  readonly sensors: readonly Sensor[];
  readonly systemNodes: readonly SystemNode[];
  readonly insights: readonly AnalyticalInsight[];
  readonly reports: readonly OpsReport[];
}
