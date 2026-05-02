#!/usr/bin/env node
/**
 * Pre-test lint: forbid raw `console.*` in OAuth / credential code paths.
 *
 * These files handle tokens, refresh tokens, passphrases, or callback URLs.
 * Logging through `src/logger.ts` runs the structured sanitizer; raw console
 * calls bypass it and have leaked auth codes in the past.
 */

const fs = require('fs');
const path = require('path');

const FORBIDDEN_FILES = [
  'src/core/oauth-manager.ts',
  'src/core/gcp-connection.ts',
  'src/core/eas-connection.ts',
  'src/core/github-connection.ts',
  'src/core/gcp/gcp-oauth-provider.ts',
];

const PATTERN = /\bconsole\.(log|warn|error|info|debug)\b/g;

let failed = false;
for (const rel of FORBIDDEN_FILES) {
  const abs = path.resolve(__dirname, '..', rel);
  if (!fs.existsSync(abs)) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const hits = [];
  src.split('\n').forEach((line, i) => {
    if (PATTERN.test(line)) hits.push({ line: i + 1, text: line.trim() });
    PATTERN.lastIndex = 0;
  });
  if (hits.length) {
    failed = true;
    console.error(`\n${rel}: ${hits.length} forbidden console call(s):`);
    for (const h of hits) console.error(`  ${rel}:${h.line}  ${h.text}`);
  }
}

if (failed) {
  console.error('\nRoute these through createOperationLogger from src/logger.ts.');
  console.error('The structured logger redacts SENSITIVE_KEYS before output.');
  process.exit(1);
}
