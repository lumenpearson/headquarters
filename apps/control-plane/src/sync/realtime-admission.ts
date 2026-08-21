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
  const validate = async ({
    accessToken,
    groupId,
    deviceId,
  }: {
    readonly accessToken: string;
    readonly groupId: string;
    readonly deviceId: string;
  }): Promise<boolean> => {
    try {
      const authenticated = await runtime.authenticateAccessToken(accessToken);
      return authenticated.group.id === groupId && authenticated.device.id === deviceId;
    } catch {
      return false;
    }
  };

  return {
    admit: validate,
    // Keep this explicit rather than relying on the transport fallback. The
    // paired-device runtime is the authorization source of truth, so every
    // protected realtime operation re-checks the same token/group/device
    // triple that was admitted during ClientHello.
    revalidate: validate,
  };
}
