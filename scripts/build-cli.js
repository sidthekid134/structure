#!/usr/bin/env node
/**
 * Bundle the Studio Pro CLI (`dist/studio/cli.js` + deps + native modules) into
 * a single executable via `@yao-pkg/pkg`, named `studio-pro-<rust-triple>`.
 *
 * Usage:
 *   node scripts/build-cli.js
 *   node scripts/build-cli.js --all
 *   node scripts/build-cli.js --target=node20-linux-x64
 *
 * Output: binaries/studio-pro-<triple>(.exe)
 */

const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'studio', 'cli.js');
const OUT_DIR = path.join(ROOT, 'binaries');
const BINARY_PREFIX = 'studio-pro';

const NODE_MAJOR =
  process.env.STUDIO_PKG_NODE || `node${process.versions.node.split('.')[0]}`;

function targetMap() {
  return {
    [`${NODE_MAJOR}-macos-arm64`]: 'aarch64-apple-darwin',
    [`${NODE_MAJOR}-macos-x64`]: 'x86_64-apple-darwin',
    [`${NODE_MAJOR}-linux-x64`]: 'x86_64-unknown-linux-gnu',
    [`${NODE_MAJOR}-linux-arm64`]: 'aarch64-unknown-linux-gnu',
    [`${NODE_MAJOR}-win-x64`]: 'x86_64-pc-windows-msvc',
  };
}
const TARGETS = targetMap();

function detectHostPkgTarget() {
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') return `${NODE_MAJOR}-macos-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (platform === 'linux') return `${NODE_MAJOR}-linux-${arch === 'arm64' ? 'arm64' : 'x64'}`;
  if (platform === 'win32') return `${NODE_MAJOR}-win-x64`;
  throw new Error(`Unsupported host platform: ${platform}-${arch}`);
}

function ensureBackendBuild() {
  if (!fs.existsSync(ENTRY)) {
    console.log('[build-cli] dist not found — running `npm run build:backend`…');
    execSync('npm run build:backend', { stdio: 'inherit', cwd: ROOT });
  }
}

function buildOne(pkgTarget) {
  const rustTriple = TARGETS[pkgTarget];
  if (!rustTriple) throw new Error(`Unknown pkg target: ${pkgTarget}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const ext = pkgTarget.includes('win') ? '.exe' : '';
  const tempName = `${BINARY_PREFIX}-${pkgTarget}${ext}`;
  const finalName = `${BINARY_PREFIX}-${rustTriple}${ext}`;
  const tempPath = path.join(OUT_DIR, tempName);
  const finalPath = path.join(OUT_DIR, finalName);

  const pkgCachePath =
    process.env.PKG_CACHE_PATH || path.join(ROOT, '.pkg-cache');
  fs.mkdirSync(pkgCachePath, { recursive: true });

  console.log(`[build-cli] pkg → ${pkgTarget} (cache: ${pkgCachePath})`);
  const res = spawnSync(
    'npx',
    [
      '--yes',
      '@yao-pkg/pkg',
      ENTRY,
      '-c', path.join(ROOT, 'package.json'),
      '--targets', pkgTarget,
      '--output', tempPath,
      '--compress', 'GZip',
      '--no-bytecode',
      '--public-packages', '*',
      '--public',
    ],
    {
      stdio: 'inherit',
      cwd: ROOT,
      env: { ...process.env, PKG_CACHE_PATH: pkgCachePath },
    },
  );
  if (res.status !== 0) {
    throw new Error(`pkg failed for ${pkgTarget} (exit ${res.status})`);
  }

  if (tempPath !== finalPath) {
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(tempPath, finalPath);
  }
  if (!ext) {
    fs.chmodSync(finalPath, 0o755);
  }
  console.log(`[build-cli] wrote ${path.relative(ROOT, finalPath)}`);
}

function main() {
  const args = process.argv.slice(2);
  const explicit = args.find((a) => a.startsWith('--target='))?.split('=')[1];
  const all = args.includes('--all');

  ensureBackendBuild();

  if (explicit) {
    buildOne(explicit);
  } else if (all) {
    for (const t of Object.keys(TARGETS)) buildOne(t);
  } else {
    buildOne(detectHostPkgTarget());
  }
}

main();
