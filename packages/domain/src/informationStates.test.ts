import { describe, expect, it } from 'vitest';

import {
  transitionComms,
  transitionSatellite,
  transitionSecurity,
  type CommsState,
  type SatelliteState,
  type SecurityState,
} from './informationStates.js';

describe('information state machines', () => {
  it('retains the target through satellite degradation and loss', () => {
    const acquiring: SatelliteState = { status: 'acquiring' };
    const tracking = transitionSatellite(acquiring, {
      type: 'TRACK',
      targetId: 'OBJECT-01',
      quality: 96,
    });
    const degraded = transitionSatellite(tracking, { type: 'DEGRADE', quality: 38 });
    const lost = transitionSatellite(degraded, { type: 'LOSE' });

    expect(degraded).toEqual({ status: 'degraded', quality: 38, targetId: 'OBJECT-01' });
    expect(lost).toEqual({ status: 'lost', lastKnownTargetId: 'OBJECT-01' });
  });

  it('moves communications through explicit mutually exclusive states', () => {
    const ringing: CommsState = { status: 'ringing', target: 'РОГОЖИН' };
    const connecting = transitionComms(ringing, { type: 'CONNECT', at: 100 });
    const connected = transitionComms(connecting, {
      type: 'CONNECTED',
      at: 200,
      intercept: true,
    });
    const ended = transitionComms(connected, { type: 'END', at: 500 });

    expect(connecting.status).toBe('connecting');
    expect(connected).toMatchObject({ status: 'connected', intercept: true });
    expect(ended).toEqual({ status: 'ended', target: 'РОГОЖИН', endedAt: 500 });
  });

  it('restores a disabled security camera through reconnect', () => {
    const online: SecurityState = { status: 'online', cameraId: 'CAM HQ-01' };
    const disabled = transitionSecurity(online, { type: 'DISABLE', at: 100 });
    const reconnecting = transitionSecurity(disabled, { type: 'RECONNECT', attempt: 1 });
    const restored = transitionSecurity(reconnecting, { type: 'RESTORE' });

    expect(restored).toEqual({ status: 'online', cameraId: 'CAM HQ-01' });
  });
});
