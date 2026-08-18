import type { RealtimeAdmission } from '../realtime/server.js';

import type { PairedDeviceLifecycle } from './lifecycle.js';

/**
 * Bridges the paired-device lifecycle runtime to the WebSocket transport. A
 * failed lookup deliberately becomes a boolean rejection so the transport does
 * not reveal whether a token, group, device, or membership was invalid.
 */
export function createPairedDeviceRealtimeAdmission(
  runtime: PairedDeviceLifecycle,
): RealtimeAdmission {
  return {
    async admit({ accessToken, groupId, deviceId }) {
      try {
        const authenticated = await runtime.authenticateAccessToken(accessToken);
        return authenticated.group.id === groupId && authenticated.device.id === deviceId;
      } catch {
        return false;
      }
    },
  };
}
