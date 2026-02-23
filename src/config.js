import path from 'node:path';
import { DEFAULT_POLICY } from './constants.js';
import { fileExists, readJsonFileSync } from './fs-utils.js';

export function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, 'quick-gate.config.json');
  if (!fileExists(configPath)) {
    return {
      policy: { ...DEFAULT_POLICY },
      commands: {},
      lighthouse: {
        thresholds: {
          performance: 0.8,
          accessibility: 0.8,
          'best-practices': 0.8,
          seo: 0.8,
        },
      },
      source: 'defaults',
    };
  }

  const userConfig = readJsonFileSync(configPath);
  return {
    policy: { ...DEFAULT_POLICY, ...(userConfig.policy || {}) },
    commands: { ...(userConfig.commands || {}) },
    lighthouse: {
      thresholds: {
        performance: 0.8,
        accessibility: 0.8,
        'best-practices': 0.8,
        seo: 0.8,
        ...(userConfig.lighthouse?.thresholds || {}),
      },
    },
    source: configPath,
  };
}
