import type { RealtimeAdmission } from '../realtime/server.js';

import type { PairedDeviceRuntime } from './runtime.js';

/**
 * Bridges the paired-device lifecycle runtime to the WebSocket transport. A
 * failed lookup deliberately becomes a boolean rejection so the transport does
 * not reveal whether a token, group, device, or membership was invalid.
 */
export function createPairedDeviceRealtimeAdmission(
  runtime: PairedDeviceRuntime,
): RealtimeAdmission {
  return {
    admit({ accessToken, groupId, deviceId }) {
      try {
        const authenticated = runtime.authenticateAccessToken(accessToken);
        return authenticated.group.id === groupId && authenticated.device.id === deviceId;
      } catch {
        return false;
      }
    },
  };
}
