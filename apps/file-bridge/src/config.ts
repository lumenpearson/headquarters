import { bridgeConfigSchema, type BridgeConfig } from '@gremuchaya/config';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function loadBridgeConfig(
  configPath = process.env.HQ_BRIDGE_CONFIG,
): Promise<BridgeConfig> {
  const resolvedPath = resolve(configPath ?? 'bridge.config.json');
  const raw = await readFile(resolvedPath, 'utf8');
  return bridgeConfigSchema.parse(JSON.parse(raw));
}
