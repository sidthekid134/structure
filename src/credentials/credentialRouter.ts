/**
 * Credential REST endpoints.
 *
 *   POST /api/projects/:projectId/credentials/:credentialType
 *     — collect, validate (format + live API), and store a credential.
 *     — accepts application/json { value } or multipart/form-data (file field "file").
 *     — returns { credentialId, type, validatedAt } on success.
 *
 * Live validators make outbound API calls to verify tokens before storage:
 *   validateGitHubPATLive   → GET https://api.github.com/user
 *   validateCloudflareTokenLive → GET https://api.cloudflare.com/client/v4/accounts
 *   validateExpoTokenLive   → GET https://api.expo.dev/v2/auth/userinfo
 *
 * File validators check format without network calls:
 *   validateAppleP8File     → PEM parse + SHA-256 duplicate check
 *   validateGooglePlayKeyFile → JSON parse + required-field check
 *
 * Cross-provider dependency checking (checkDependencies) queries the SQLite
 * credential store to ensure prerequisites are satisfied before storage.
 */

import * as https from 'https';
import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { Router, Request, Response, NextFunction } from 'express';
import { CredentialService, CredentialType, CREDENTIAL_TYPES } from './credentialService.js';
import { CredentialError, ValidationError } from '../types.js';

// ---------------------------------------------------------------------------
// Cross-provider dependency map
// ---------------------------------------------------------------------------

const CREDENTIAL_DEPENDENCIES: Partial<Record<CredentialType, CredentialType[]>> = {
  domain_name: ['cloudflare_token'],
  apple_p8: ['apple_team_id'],
};

// Credential types delivered as file uploads (multipart/form-data field "file")
const FILE_CREDENTIAL_TYPES = new Set<CredentialType>(['apple_p8', 'google_play_key']);

// ---------------------------------------------------------------------------
// Multipart/form-data parser (no external dependencies)
// ---------------------------------------------------------------------------

interface ParsedFile {
  fieldname: string;
  filename: string;
  mimetype: string;
  buffer: Buffer;
}

interface ParsedMultipart {
  fields: Record<string, string>;
  file?: ParsedFile;
}

/**
 * Minimal multipart/form-data body parser.
 * Handles a single file part and any number of text fields.
 */
function parseMultipart(body: Buffer, boundary: string): ParsedMultipart {
  const fields: Record<string, string> = {};
  let file: ParsedFile | undefined;

  // Each part is delimited by \r\n--<boundary>
  const delimBytes = Buffer.from('\r\n--' + boundary);

  // Locate the opening boundary
  const openBound = Buffer.from('--' + boundary);
  let pos = body.indexOf(openBound);
  if (pos === -1) return { fields };
  pos += openBound.length;

  // Skip \r\n after opening boundary
  if (pos + 1 < body.length && body[pos] === 13 && body[pos + 1] === 10) {
    pos += 2;
  } else {
    return { fields };
  }

  while (pos < body.length) {
    // Find next boundary delimiter
    const nextDelim = body.indexOf(delimBytes, pos);
    if (nextDelim === -1) break;

    const partBuf = body.slice(pos, nextDelim);

    // Split part into headers / body at \r\n\r\n
    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const headerStr = partBuf.slice(0, headerEnd).toString('utf8');
    const content = partBuf.slice(headerEnd + 4);

    // Parse Content-Disposition
    const dispMatch = headerStr.match(/Content-Disposition:[^\r\n]+name="([^"]+)"/i);
    const filenameMatch = headerStr.match(/Content-Disposition:[^\r\n]+filename="([^"]+)"/i);
    const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

    if (dispMatch) {
      const fieldname = dispMatch[1];
      if (filenameMatch) {
        file = {
          fieldname,
          filename: filenameMatch[1],
          mimetype: ctMatch ? ctMatch[1].trim() : 'application/octet-stream',
          buffer: content,
        };
      } else {
        fields[fieldname] = content.toString('utf8');
      }
    }

    // Advance past delimiter
    pos = nextDelim + delimBytes.length;

    // Check for final boundary marker (--)
    if (pos + 1 < body.length && body[pos] === 45 && body[pos + 1] === 45) {
      break;
    }
    // Skip \r\n after delimiter
    if (pos + 1 < body.length && body[pos] === 13 && body[pos + 1] === 10) {
      pos += 2;
    }
  }

  return { fields, file };
}

// ---------------------------------------------------------------------------
// fileUploadHandler middleware
// ---------------------------------------------------------------------------

const FILE_SIZE_LIMIT = 10 * 1024; // 10 KB

/**
 * Express middleware that handles multipart/form-data requests.
 *
 * For multipart requests:
 *   - Reads raw body (limit: 10 KB)
 *   - Parses fields → req.body
 *   - Parses single file part → req.uploadedFile
 *   - Writes file to a temp path → req.uploadedFilePath (cleaned up after response)
 *
 * For other content types, calls next() immediately (handled by express.json()).
 */
export function fileUploadHandler(req: Request, res: Response, next: NextFunction): void {
  const contentType = req.headers['content-type'] ?? '';

  if (!contentType.includes('multipart/form-data')) {
    next();
    return;
  }

  const boundaryMatch = contentType.match(/boundary=([^\s;]+)/);
  if (!boundaryMatch) {
    res.status(400).json({ error: 'Invalid multipart/form-data: missing boundary' });
    return;
  }

  const boundary = boundaryMatch[1];
  const chunks: Buffer[] = [];
  let totalSize = 0;
  let oversized = false;

  req.on('data', (chunk: Buffer) => {
    totalSize += chunk.length;
    if (totalSize > FILE_SIZE_LIMIT) {
      if (!oversized) {
        oversized = true;
        res.status(413).json({ error: 'File too large: maximum upload size is 10 KB' });
        req.destroy();
      }
    } else {
      chunks.push(chunk);
    }
  });

  req.on('end', () => {
    if (oversized || res.headersSent) return;

    const body = Buffer.concat(chunks);
    const { fields, file } = parseMultipart(body, boundary);

    req.body = { ...req.body, ...fields };

    if (file) {
      // Write to a unique temp file for processing; cleaned up after response
      const tmpPath = path.join(os.tmpdir(), `credential-upload-${crypto.randomUUID()}`);
      fs.writeFileSync(tmpPath, file.buffer);
      (req as Request & { uploadedFile?: ParsedFile; uploadedFilePath?: string }).uploadedFile = file;
      (req as Request & { uploadedFilePath?: string }).uploadedFilePath = tmpPath;

      res.on('finish', () => {
        fs.unlink(tmpPath, () => {/* ignore cleanup errors */});
      });
    }

    next();
  });

  req.on('error', () => {
    if (!res.headersSent) {
      res.status(500).json({ error: 'File upload stream error' });
    }
  });
}

// ---------------------------------------------------------------------------
// Live API validators
// ---------------------------------------------------------------------------

/**
 * Makes a GET request via the built-in https module.
 * Returns { statusCode, headers, body }.
 */
function httpsGet(
  hostname: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ statusCode: number; headers: Record<string, string | string[]>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path, method: 'GET', headers },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[]>,
            body: data,
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });
    req.end();
  });
}

/**
 * Validates a GitHub PAT by calling GET /user and inspecting the X-OAuth-Scopes
 * response header for the required scopes (repo, workflow, admin:org).
 *
 * Throws CredentialError if the token is invalid, expired, or missing scopes.
 */
export async function validateGitHubPATLive(token: string): Promise<void> {
  let result: Awaited<ReturnType<typeof httpsGet>>;
  try {
    result = await httpsGet('api.github.com', '/user', {
      Authorization: `token ${token}`,
      'User-Agent': 'credential-vault/1.0',
      Accept: 'application/vnd.github.v3+json',
    });
  } catch (err) {
    throw new CredentialError(
      `Failed to reach GitHub API: ${(err as Error).message}`,
      'validateGitHubPAT',
    );
  }

  if (result.statusCode === 401) {
    throw new CredentialError(
      'GitHub PAT is invalid or expired — verify the token has not been revoked',
      'validateGitHubPAT',
    );
  }
  if (result.statusCode !== 200) {
    throw new CredentialError(
      `GitHub API returned unexpected status ${result.statusCode}`,
      'validateGitHubPAT',
    );
  }

  const scopeHeader = result.headers['x-oauth-scopes'];
  const scopeStr = Array.isArray(scopeHeader) ? scopeHeader.join(',') : (scopeHeader ?? '');
  const grantedScopes = scopeStr.split(',').map((s) => s.trim()).filter(Boolean);

  const requiredScopes = ['repo', 'workflow', 'admin:org'];
  const missingScopes = requiredScopes.filter((s) => !grantedScopes.includes(s));
  if (missingScopes.length > 0) {
    throw new CredentialError(
      `GitHub token missing required scopes: ${missingScopes.join(', ')}. ` +
        `Regenerate your token and grant: repo, workflow, admin:org`,
      'validateGitHubPAT',
    );
  }
}

/**
 * Validates a Cloudflare API token by calling GET /accounts.
 * Throws CredentialError if the token is invalid, expired, or lacks account access.
 */
export async function validateCloudflareTokenLive(token: string): Promise<void> {
  let result: Awaited<ReturnType<typeof httpsGet>>;
  try {
    result = await httpsGet('api.cloudflare.com', '/client/v4/accounts', {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    });
  } catch (err) {
    throw new CredentialError(
      `Failed to reach Cloudflare API: ${(err as Error).message}`,
      'validateCloudflareToken',
    );
  }

  if (result.statusCode === 400 || result.statusCode === 403) {
    throw new CredentialError(
      'Cloudflare token is invalid, expired, or lacks account access — ' +
        'regenerate the token with Cloudflare account:read permission',
      'validateCloudflareToken',
    );
  }
  if (result.statusCode !== 200) {
    throw new CredentialError(
      `Cloudflare API returned unexpected status ${result.statusCode}`,
      'validateCloudflareToken',
    );
  }

  let parsed: { success?: boolean };
  try {
    parsed = JSON.parse(result.body) as { success?: boolean };
  } catch {
    throw new CredentialError(
      'Cloudflare API returned non-JSON response',
      'validateCloudflareToken',
    );
  }
  if (!parsed.success) {
    throw new CredentialError(
      'Cloudflare token does not have access to any accounts — ' +
        'ensure the token has the Account:Read permission',
      'validateCloudflareToken',
    );
  }
}

/**
 * Validates an Expo access token by calling GET /v2/auth/userinfo.
 * Throws CredentialError if the token is invalid or the account does not exist.
 */
export async function validateExpoTokenLive(token: string): Promise<void> {
  let result: Awaited<ReturnType<typeof httpsGet>>;
  try {
    result = await httpsGet('api.expo.dev', '/v2/auth/userinfo', {
      Authorization: `Bearer ${token}`,
    });
  } catch (err) {
    throw new CredentialError(
      `Failed to reach Expo API: ${(err as Error).message}`,
      'validateExpoToken',
    );
  }

  if (result.statusCode === 401) {
    throw new CredentialError(
      'Expo token is invalid or expired — verify the token in your Expo account settings',
      'validateExpoToken',
    );
  }
  if (result.statusCode !== 200) {
    throw new CredentialError(
      `Expo API returned unexpected status ${result.statusCode}`,
      'validateExpoToken',
    );
  }

  let parsed: { id?: unknown };
  try {
    parsed = JSON.parse(result.body) as { id?: unknown };
  } catch {
    throw new CredentialError('Expo API returned non-JSON response', 'validateExpoToken');
  }
  if (!parsed.id) {
    throw new CredentialError(
      'Expo API did not return a valid account — token may be malformed',
      'validateExpoToken',
    );
  }
}

/**
 * Validates an Apple .p8 key file buffer:
 *   - Parses PEM headers
 *   - Computes SHA-256 hash for duplicate detection
 *
 * Returns the file content as a string and the computed file hash.
 * Throws CredentialError if the file is malformed.
 */
export function validateAppleP8File(
  fileBuffer: Buffer,
  projectId: string,
  credentialService: CredentialService,
): { value: string; fileHash: string } {
  const content = fileBuffer.toString('utf8');

  if (
    !content.includes('-----BEGIN PRIVATE KEY-----') &&
    !content.includes('-----BEGIN EC PRIVATE KEY-----')
  ) {
    throw new CredentialError(
      'Invalid Apple .p8 file — must contain a PEM-encoded private key block ' +
        '(-----BEGIN PRIVATE KEY----- or -----BEGIN EC PRIVATE KEY-----)',
      'validateAppleP8',
    );
  }

  const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');

  // Duplicate detection: check if a credential with the same file hash already exists
  const existing = credentialService.findCredentialMetadata(projectId, 'apple_p8');
  if (existing) {
    let meta: { fileHash?: string };
    try {
      meta = JSON.parse(existing.metadata) as { fileHash?: string };
    } catch {
      meta = {};
    }
    if (meta.fileHash === fileHash) {
      throw new CredentialError(
        'This Apple .p8 key has already been uploaded for this project — ' +
          'each project may only have one active .p8 key',
        'validateAppleP8',
      );
    }
  }

  return { value: content, fileHash };
}

/**
 * Validates a Google Play service account JSON key file buffer.
 * Checks for required fields: type, project_id, private_key_id, private_key, client_email.
 *
 * Returns the file content as a string.
 * Throws CredentialError if the file is missing required fields or is not valid JSON.
 */
export function validateGooglePlayKeyFile(fileBuffer: Buffer): { value: string } {
  const content = fileBuffer.toString('utf8');

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    throw new CredentialError(
      'Invalid Google Play key file — must be a valid JSON service account key',
      'validateGooglePlayKey',
    );
  }

  const required = ['type', 'project_id', 'private_key_id', 'private_key', 'client_email'];
  const missing = required.filter((f) => !(f in parsed) || !parsed[f]);
  if (missing.length > 0) {
    throw new CredentialError(
      `Invalid Google Play service account key — missing required fields: ${missing.join(', ')}`,
      'validateGooglePlayKey',
    );
  }

  if (parsed['type'] !== 'service_account') {
    throw new CredentialError(
      `Invalid Google Play key — "type" must be "service_account", got "${parsed['type'] as string}"`,
      'validateGooglePlayKey',
    );
  }

  return { value: content };
}

// ---------------------------------------------------------------------------
// Dependency checker
// ---------------------------------------------------------------------------

/**
 * Verifies that all prerequisite credentials for the given type are already
 * stored and active for the project.
 *
 * Throws CredentialError with an actionable message if any dependency is missing.
 */
export function checkDependencies(
  projectId: string,
  credentialType: CredentialType,
  credentialService: CredentialService,
): void {
  const required = CREDENTIAL_DEPENDENCIES[credentialType];
  if (!required || required.length === 0) return;

  const missing = required.filter((dep) => !credentialService.hasCredential(projectId, dep));
  if (missing.length === 0) return;

  const depDescriptions: Partial<Record<CredentialType, string>> = {
    cloudflare_token: 'a Cloudflare API token (POST credentials/cloudflare_token first)',
    apple_team_id: 'an Apple Team ID (POST credentials/apple_team_id first)',
  };

  const descriptions = missing.map(
    (dep) => depDescriptions[dep] ?? dep,
  );

  throw new CredentialError(
    `Cannot store ${credentialType}: missing prerequisite credential(s) — ` +
      `${descriptions.join(', ')}`,
    'checkDependencies',
  );
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

function isValidCredentialType(value: string): value is CredentialType {
  return (CREDENTIAL_TYPES as readonly string[]).includes(value);
}

/**
 * Creates an Express Router that exposes:
 *
 *   POST /projects/:projectId/credentials/:credentialType
 *
 * The middleware chain on this route is:
 *   1. fileUploadHandler — handles multipart/form-data file uploads
 *   2. Route handler     — validates, checks dependencies, stores, returns receipt
 */
export function createCredentialRouter(credentialService: CredentialService): Router {
  const router = Router();

  // -------------------------------------------------------------------------
  // POST /projects/:projectId/credentials/:credentialType
  // -------------------------------------------------------------------------
  router.post(
    '/projects/:projectId/credentials/:credentialType',
    fileUploadHandler,
    async (req: Request, res: Response) => {
      const { projectId, credentialType } = req.params;

      if (!isValidCredentialType(credentialType)) {
        res.status(400).json({
          error: `Unknown credential type "${credentialType}". Valid types: ${CREDENTIAL_TYPES.join(', ')}`,
        });
        return;
      }

      try {
        let value: string;
        let extraMetadata: Record<string, unknown> = {};

        const uploadedFile = (req as Request & { uploadedFile?: ParsedFile }).uploadedFile;

        if (FILE_CREDENTIAL_TYPES.has(credentialType)) {
          // File-based credentials: require multipart upload
          if (!uploadedFile) {
            res.status(400).json({
              error: `${credentialType} requires a file upload. Send a multipart/form-data request with a "file" field.`,
            });
            return;
          }

          if (credentialType === 'apple_p8') {
            const validated = validateAppleP8File(uploadedFile.buffer, projectId, credentialService);
            value = validated.value;
            extraMetadata = { fileHash: validated.fileHash, filename: uploadedFile.filename };
          } else {
            // google_play_key
            const validated = validateGooglePlayKeyFile(uploadedFile.buffer);
            value = validated.value;
            extraMetadata = { filename: uploadedFile.filename };
          }
        } else {
          // Text credentials: require JSON body { value }
          const rawValue = (req.body as Record<string, unknown>)?.value;
          if (typeof rawValue !== 'string' || rawValue.trim().length === 0) {
            res.status(400).json({
              error: `Request body must include a non-empty "value" field for ${credentialType}`,
            });
            return;
          }
          value = rawValue;
        }

        // Check cross-provider dependencies before performing live validation
        checkDependencies(projectId, credentialType, credentialService);

        // Live API validation for token-based credentials
        if (credentialType === 'github_pat') {
          await validateGitHubPATLive(value);
        } else if (credentialType === 'cloudflare_token') {
          await validateCloudflareTokenLive(value);
        } else if (credentialType === 'expo_token') {
          await validateExpoTokenLive(value);
        }

        // Store (format-validates + encrypts)
        const credentialId = credentialService.storeCredential(
          projectId,
          credentialType,
          value,
          extraMetadata,
        );

        res.status(201).json({
          credentialId,
          type: credentialType,
          validatedAt: new Date().toISOString(),
        });
      } catch (err) {
        if (err instanceof CredentialError || err instanceof ValidationError) {
          res.status(422).json({ error: err.message });
          return;
        }
        console.error(`[credentials] Error storing ${credentialType}:`, (err as Error).message);
        res.status(500).json({ error: 'Internal error storing credential' });
      }
    },
  );

  return router;
}
