/**
 * Bootstrap for all built-in plugins.
 *
 * Call registerBuiltinPlugins() once at server startup (before createApiRouter)
 * to populate the globalPluginRegistry with all built-in module/plugin definitions.
 *
 * Plugins are registered in dependency order — a plugin's required modules
 * must already be registered when it is registered.
 */

import { globalPluginRegistry } from '../plugin-registry.js';
import { validatePluginRegistry } from '../plugin-registry-validator.js';
import { gcpProjectFoundationPlugin } from './gcp-project-foundation.plugin.js';
import { firebaseCorePlugin } from './firebase-core.plugin.js';
import { firebaseAuthPlugin } from './firebase-auth.plugin.js';
import { firebaseFirestorePlugin } from './firebase-firestore.plugin.js';
import { firebaseStoragePlugin } from './firebase-storage.plugin.js';
import { githubRepoPlugin } from './github-repo.plugin.js';
import { githubCiPlugin } from './github-ci.plugin.js';
import { appleSigningPlugin } from './apple-signing.plugin.js';
import { googlePlayPlugin } from './google-play.plugin.js';
import { easBuildsPlugin } from './eas-builds.plugin.js';
import { easSubmitPlugin } from './eas-submit.plugin.js';
import { cloudflareDomainPlugin } from './cloudflare-domain.plugin.js';
import { firebaseMessagingPlugin } from './firebase-messaging.plugin.js';
import { oauthSocialPlugin } from './oauth-social.plugin.js';
import { llmOpenAIPlugin } from './llm-openai.plugin.js';
import { llmAnthropicPlugin } from './llm-anthropic.plugin.js';
import { llmGeminiPlugin } from './llm-gemini.plugin.js';
import { llmOpenRouterPlugin } from './llm-openrouter.plugin.js';
import { llmCustomPlugin } from './llm-custom.plugin.js';
import { gcpServerlessCorePlugin } from './gcp-serverless-core.plugin.js';
import { gcpServerlessApiPlugin } from './gcp-serverless-api.plugin.js';
import { gcpServerlessWebPlugin } from './gcp-serverless-web.plugin.js';
import { gcpServerlessFullstackPlugin } from './gcp-serverless-fullstack.plugin.js';

let _registered = false;

export function registerBuiltinPlugins(): void {
  if (_registered) return;
  _registered = true;

  // Built-in project templates. Module membership is derived from each
  // plugin's `includedInTemplates`; only labels/descriptions live here.
  globalPluginRegistry.registerProjectTemplate({
    id: 'mobile-app',
    label: 'Mobile App',
    description: 'Cross-platform mobile template with build and store automation.',
  });
  globalPluginRegistry.registerProjectTemplate({
    id: 'web-app',
    label: 'Web App',
    description: 'Web-focused app with auth, data, CI, and managed DNS.',
  });
  globalPluginRegistry.registerProjectTemplate({
    id: 'api-backend',
    label: 'API Backend',
    description: 'Backend infrastructure with data, auth, and CI foundations.',
  });
  globalPluginRegistry.registerProjectTemplate({
    id: 'custom',
    label: 'Custom',
    description: 'Start from scratch and choose modules manually.',
  });

  // Tier 0: no dependencies
  globalPluginRegistry.register(gcpProjectFoundationPlugin);
  globalPluginRegistry.register(firebaseCorePlugin);
  globalPluginRegistry.register(githubRepoPlugin);
  globalPluginRegistry.register(appleSigningPlugin);
  globalPluginRegistry.register(googlePlayPlugin);
  globalPluginRegistry.register(cloudflareDomainPlugin);
  globalPluginRegistry.register(gcpServerlessCorePlugin);
  // LLM kinds — registered as four sibling plugins, all sharing the 'llm'
  // provider and the LlmAdapter declared on `llm-openai`. Each one is a
  // separately selectable module so the project plan only includes steps
  // for the kinds the operator actually picks.
  globalPluginRegistry.register(llmOpenAIPlugin);
  globalPluginRegistry.register(llmAnthropicPlugin);
  globalPluginRegistry.register(llmGeminiPlugin);
  globalPluginRegistry.register(llmOpenRouterPlugin);
  globalPluginRegistry.register(llmCustomPlugin);

  // Tier 1: depend on tier 0
  globalPluginRegistry.register(firebaseAuthPlugin);     // requires firebase-core
  globalPluginRegistry.register(firebaseFirestorePlugin); // requires firebase-core
  globalPluginRegistry.register(firebaseStoragePlugin);  // requires firebase-core
  globalPluginRegistry.register(githubCiPlugin);         // requires github-repo, firebase-core
  globalPluginRegistry.register(easBuildsPlugin);        // requires github-repo
  globalPluginRegistry.register(gcpServerlessApiPlugin); // requires gcp-serverless-core, github-ci
  globalPluginRegistry.register(gcpServerlessWebPlugin); // requires gcp-serverless-core, github-ci

  // Tier 2: depend on tier 1
  globalPluginRegistry.register(gcpServerlessFullstackPlugin); // requires gcp-serverless-api, gcp-serverless-web
  globalPluginRegistry.register(firebaseMessagingPlugin); // requires firebase-core, apple-signing, google-play-publishing
  globalPluginRegistry.register(easSubmitPlugin);         // requires eas-builds
  globalPluginRegistry.register(oauthSocialPlugin);       // requires firebase-auth

  // Validate the fully-assembled registry — fail boot loudly on any
  // structural inconsistency (unknown module/step/phase ref, cycle, drift
  // between two definitions of the same step, etc).
  validatePluginRegistry(globalPluginRegistry);
}

export {
  firebaseCorePlugin,
  firebaseAuthPlugin,
  firebaseFirestorePlugin,
  firebaseStoragePlugin,
  firebaseMessagingPlugin,
  githubRepoPlugin,
  githubCiPlugin,
  appleSigningPlugin,
  googlePlayPlugin,
  easBuildsPlugin,
  easSubmitPlugin,
  cloudflareDomainPlugin,
  oauthSocialPlugin,
  llmOpenAIPlugin,
  llmAnthropicPlugin,
  llmGeminiPlugin,
  llmOpenRouterPlugin,
  llmCustomPlugin,
  gcpProjectFoundationPlugin,
  gcpServerlessCorePlugin,
  gcpServerlessApiPlugin,
  gcpServerlessWebPlugin,
  gcpServerlessFullstackPlugin,
};
