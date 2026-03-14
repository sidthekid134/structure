import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Manifest, ManifestResource } from '../types/manifest';
import schema from './manifest-schema.json';

export const MANIFEST_FILENAME = 'platform.manifest.json';
export const MANIFEST_VERSION = '1.0';

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestValidationError';
  }
}

type SchemaType = 'string' | 'number' | 'boolean' | 'object' | 'array';

interface PropertySchema {
  type?: SchemaType | SchemaType[];
  minLength?: number;
  pattern?: string;
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, PropertySchema>;
  items?: PropertySchema;
}

function validateValue(value: unknown, propSchema: PropertySchema, path: string): string[] {
  const errors: string[] = [];
  const types = Array.isArray(propSchema.type) ? propSchema.type : propSchema.type ? [propSchema.type] : [];

  if (types.length > 0) {
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (!types.includes(actualType as SchemaType)) {
      errors.push(`"${path}" must be of type ${types.join(' or ')}, got ${actualType}`);
      return errors;
    }
  }

  if (typeof value === 'string') {
    if (propSchema.minLength !== undefined && value.length < propSchema.minLength) {
      errors.push(`"${path}" must have minLength ${propSchema.minLength}`);
    }
    if (propSchema.pattern && !new RegExp(propSchema.pattern).test(value)) {
      errors.push(`"${path}" does not match pattern ${propSchema.pattern}`);
    }
  }

  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (propSchema.required) {
      for (const req of propSchema.required) {
        if (!(req in obj)) {
          errors.push(`"${path}" is missing required property "${req}"`);
        }
      }
    }
    if (propSchema.properties) {
      for (const [key, childSchema] of Object.entries(propSchema.properties)) {
        if (key in obj) {
          errors.push(...validateValue(obj[key], childSchema, `${path}.${key}`));
        }
      }
    }
    if (propSchema.additionalProperties === false && propSchema.properties) {
      for (const key of Object.keys(obj)) {
        if (!(key in propSchema.properties)) {
          errors.push(`"${path}" has unexpected property "${key}"`);
        }
      }
    }
  }

  if (Array.isArray(value) && propSchema.items) {
    for (let i = 0; i < value.length; i++) {
      errors.push(...validateValue(value[i], propSchema.items, `${path}[${i}]`));
    }
  }

  return errors;
}

export function validateManifest(data: unknown): void {
  const errors = validateValue(data, schema as PropertySchema, 'manifest');
  if (errors.length > 0) {
    throw new ManifestValidationError(`Invalid manifest:\n${errors.join('\n')}`);
  }
}

export function loadManifest(projectRoot: string): Manifest | null {
  const manifestPath = join(projectRoot, MANIFEST_FILENAME);
  if (!existsSync(manifestPath)) {
    return null;
  }

  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err: any) {
    throw new ManifestValidationError(`Failed to read manifest: ${err.message}`);
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ManifestValidationError('Manifest file contains invalid JSON');
  }

  validateManifest(data);
  return data as Manifest;
}

export function saveManifest(projectRoot: string, manifest: Manifest): void {
  validateManifest(manifest);

  const manifestPath = join(projectRoot, MANIFEST_FILENAME);
  const tmpPath = manifestPath + '.tmp';

  if (!existsSync(projectRoot)) {
    mkdirSync(projectRoot, { recursive: true });
  }

  writeFileSync(tmpPath, JSON.stringify(manifest, null, 2), { mode: 0o644 });
  renameSync(tmpPath, manifestPath);
}

export function createEmptyManifest(projectId: string): Manifest {
  return {
    projectId,
    generatedAt: Date.now(),
    version: MANIFEST_VERSION,
    resources: [],
  };
}

export function mergeResources(
  existing: ManifestResource[],
  fresh: ManifestResource[],
): ManifestResource[] {
  const freshMap = new Map(fresh.map((r) => [`${r.provider}:${r.resourceId}`, r]));
  const merged: ManifestResource[] = [];

  // Include all fresh resources
  for (const resource of fresh) {
    merged.push(resource);
  }

  // Keep existing resources not in fresh set (deleted from provider but preserved in manifest)
  for (const resource of existing) {
    const key = `${resource.provider}:${resource.resourceId}`;
    if (!freshMap.has(key)) {
      merged.push(resource);
    }
  }

  return merged;
}
