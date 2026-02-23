import fs from 'node:fs';
import path from 'node:path';

export function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function readJsonFileSync(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

export function writeJsonFileSync(filePath, data) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

export function writeTextFileSync(filePath, text) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

export function fileExists(filePath) {
  return fs.existsSync(filePath);
}

export function nowIso() {
  return new Date().toISOString();
}

export function loadChangedFiles(changedFilesPath) {
  const raw = fs.readFileSync(changedFilesPath, 'utf8').trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith('[')) {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`Changed files JSON must be an array: ${changedFilesPath}`);
    }
    return parsed.map(String);
  }

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
