/**
 * Public surface of the credential-vault package.
 */

// Core vault
export * from './types.js';
export * from './encryption.js';
export * from './validation.js';
export * from './vault.js';
export * from './logger.js';

// Provider adapter framework (Phase 1)
export * from './providers/types.js';
export * from './providers/registry.js';

// Schema validation (Phase 1 / Phase 7)
export * from './schemas/validation.js';

// Provider adapters (Phases 2–4)
export * from './providers/firebase.js';
export * from './providers/github.js';
export * from './providers/apple.js';
export * from './providers/google-play.js';
export * from './providers/eas.js';
export * from './providers/cloudflare.js';
export * from './providers/oauth.js';

// Drift detection & reconciliation (Phase 5)
export * from './drift/comparator.js';
export * from './drift/detector.js';
export * from './drift/resolver.js';
export * from './drift/reconciler.js';

// Secret management (Phase 6)
export * from './secrets/store.js';

// Operation logging (Phase 7)
export * from './operation-logger.js';

// Event store & resume capability (Phase 8)
export * from './events/store.js';
export * from './events/replayer.js';
export * from './events/recovery.js';
