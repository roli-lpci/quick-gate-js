import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { readJsonFileSync } from './fs-utils.js';

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const schemaCache = new Map();

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(currentDir, '..');

function loadSchema(schemaPath) {
  if (schemaCache.has(schemaPath)) {
    return schemaCache.get(schemaPath);
  }
  const schema = readJsonFileSync(schemaPath);
  const validate = ajv.compile(schema);
  schemaCache.set(schemaPath, validate);
  return validate;
}

export function validateAgainstSchema(schemaFileName, payload) {
  const schemaPath = path.join(packageRoot, 'schemas', schemaFileName);
  const validate = loadSchema(schemaPath);
  const valid = validate(payload);
  return {
    valid: Boolean(valid),
    errors: validate.errors || [],
    schemaPath,
  };
}
