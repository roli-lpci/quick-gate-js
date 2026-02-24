import { spawnSync } from 'node:child_process';

const cache = new Map();

function commandExists(name) {
  if (cache.has(name)) return cache.get(name);
  const result = spawnSync('which', [name], { encoding: 'utf8', timeout: 5000 });
  const exists = result.status === 0;
  cache.set(name, exists);
  return exists;
}

export function hasGit() {
  return commandExists('git');
}

export function hasOllama() {
  return commandExists('ollama');
}

export function hasRsync() {
  return commandExists('rsync');
}

export function checkEnvironment({ command }) {
  const warnings = [];

  if (!hasGit()) {
    warnings.push('git not found -- repo metadata (branch, remote) will be unavailable.');
  }

  if (command === 'repair' && !hasOllama()) {
    warnings.push('Ollama not found -- running deterministic fixes only (eslint --fix). Install Ollama for model-assisted repair: https://ollama.com');
  }

  if (command === 'repair' && !hasRsync()) {
    warnings.push('rsync not found -- using cp for workspace backup (slower but functional).');
  }

  return warnings;
}
