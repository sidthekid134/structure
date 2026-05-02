# Authoring Plugins

This guide walks through adding a new integration or plugin to Studio Pro. Read [architecture.md](./architecture.md) first to understand the four-level hierarchy (Integration → Plugin → Step → StepHandler).

## Table of Contents

1. [New Integration vs. New Plugin](#new-integration-vs-new-plugin)
2. [Step 1 — Define the Integration](#step-1--define-the-integration)
3. [Step 2 — Create Step Data](#step-2--create-step-data)
4. [Step 3 — Create the Plugin File](#step-3--create-the-plugin-file)
5. [Step 4 — Register the Plugin](#step-4--register-the-plugin)
6. [Step 5 — Write a StepHandler](#step-5--write-a-stephandler)
7. [Step 6 — Register the Handler](#step-6--register-the-handler)
8. [Step 7 — Test](#step-7--test)
9. [Worked Example: Webhook Plugin](#worked-example-webhook-plugin)

---

## New Integration vs. New Plugin

**Add a new integration** when you are adding a top-level vendor that does not exist yet (e.g., Stripe, Twilio, Supabase). This requires one new entry in `builtin-integrations.ts`.

**Add a new plugin** when you are adding a feature within an existing integration (e.g., a new Firebase service, a second GitHub-related module). You only need the plugin file and step data — no change to `builtin-integrations.ts`.

---

## Step 1 — Define the Integration

_Skip this step if you are adding a plugin to an existing integration._

Open `src/plugins/builtin-integrations.ts` and add one entry to the `BUILTIN_INTEGRATIONS` array:

```typescript
{
  id: 'webhook',                          // stable, lowercase, no spaces
  label: 'Webhooks',
  description: 'Generic webhook endpoints for outbound event delivery.',
  scope: 'project',                       // 'project' or 'organization'
  icon: 'Webhook',                        // Lucide icon name
  displayMeta: {
    label: 'Webhooks',
    color: 'text-sky-400',
    bg: 'bg-sky-500/10',
    border: 'border-sky-500/30',
  },
  order: 80,                              // controls sort order in the UI
},
```

Fields:

| Field | Required | Notes |
|---|---|---|
| `id` | Yes | Stable identifier; plugins reference this in `integrationId` |
| `label` | Yes | Human-readable name shown in the UI |
| `description` | Yes | One-sentence card description |
| `scope` | Yes | `'project'` = per-project connection; `'organization'` = shared |
| `authProvider` | No | OAuth provider id if this integration uses Studio's OAuth flow |
| `icon` | No | Lucide icon name |
| `displayMeta` | Yes | Tailwind color tokens for swimlanes and cards |
| `order` | Yes | Lower number = appears first in the UI |

---

## Step 2 — Create Step Data

Create a file at `src/provisioning/steps/<provider>-steps.ts` (or add to `step-registry.ts` if you prefer to keep it centralized). Define your steps as `ProvisioningStepNode` objects:

```typescript
import type { ProvisioningStepNode, UserActionNode } from '../graph.types.js';

export const WEBHOOK_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'webhook:create-endpoint',
    label: 'Create Webhook Endpoint',
    description: 'Register a webhook endpoint URL for outbound event delivery.',
    provider: 'webhook',
    automationLevel: 'full',
    environmentScope: 'per-environment',
    // platforms: ['ios', 'android'],   // omit to apply to all platforms
    dependencies: [
      { nodeKey: 'firebase:create-gcp-project', required: false, description: 'GCP project context' },
    ],
    outputs: [
      { key: 'webhook_url', label: 'Webhook URL', sensitive: false },
      { key: 'webhook_secret', label: 'Signing Secret', sensitive: true },
    ],
  },
];

export const WEBHOOK_TEARDOWN_STEPS: ProvisioningStepNode[] = [
  {
    type: 'step',
    key: 'webhook:delete-endpoint',
    label: 'Delete Webhook Endpoint',
    description: 'Deregisters the webhook endpoint.',
    provider: 'webhook',
    automationLevel: 'full',
    environmentScope: 'per-environment',
    dependencies: [],
    outputs: [],
  },
];
```

Key fields on `ProvisioningStepNode`:

| Field | Required | Notes |
|---|---|---|
| `type` | Yes | Always `'step'` |
| `key` | Yes | Stable, namespaced: `<provider>:<action>` |
| `label` | Yes | Short label for the UI |
| `description` | Yes | Sentence describing what the step does |
| `provider` | Yes | Must match the plugin's `provider` field |
| `automationLevel` | Yes | `'full'`, `'assisted'`, or `'manual'` |
| `environmentScope` | Yes | `'global'` or `'per-environment'` |
| `platforms` | No | Absent = applies to all platforms |
| `dependencies` | Yes | Array of `DependencyRef`; use `required: false` for optional deps |
| `outputs` | Yes | Artifacts produced; set `sensitive: true` for secrets |

Export your arrays from `src/provisioning/step-registry.ts`:

```typescript
// In step-registry.ts, add:
export { WEBHOOK_STEPS, WEBHOOK_TEARDOWN_STEPS } from './steps/webhook-steps.js';
```

---

## Step 3 — Create the Plugin File

Create `src/plugins/builtin/<name>.plugin.ts`. The minimal shape:

```typescript
import type { PluginDefinition } from '../plugin-types.js';
import { WEBHOOK_STEPS, WEBHOOK_TEARDOWN_STEPS } from '../../provisioning/step-registry.js';

export const webhookPlugin: PluginDefinition = {
  id: 'webhook-endpoints',          // unique plugin id
  version: '1.0.0',
  label: 'Webhook Endpoints',
  description: 'Register and manage outbound webhook endpoints per environment.',

  integrationId: 'webhook',         // must match the IntegrationDefinition.id

  provider: 'webhook',              // stable provider string used in step keys
  providerMeta: {
    label: 'Webhook',
    scope: 'project',
    secretKeys: ['webhook_secret'], // vault keys this plugin writes
    dependsOnProviders: [],
    displayMeta: {
      label: 'Webhook',
      color: 'text-sky-400',
      bg: 'bg-sky-500/10',
      border: 'border-sky-500/30',
    },
  },

  requiredModules: [],              // plugin ids that must be present
  optionalModules: [],
  includedInTemplates: [],          // template ids this plugin is auto-included in

  steps: WEBHOOK_STEPS,
  teardownSteps: WEBHOOK_TEARDOWN_STEPS,
  userActions: [],                  // UserActionNode[] for manual gates

  displayMeta: {
    icon: 'Webhook',
    colors: {
      primary: 'sky-500',
      text: 'text-sky-700 dark:text-sky-300',
      bg: 'bg-sky-500/10',
      border: 'border-sky-500/25',
    },
  },

  defaultJourneyPhase: 'runtime',   // 'credentials' | 'infrastructure' | 'runtime'
};
```

### Filtering steps

If your step file contains many steps and you only want a subset in a particular plugin, filter from the array rather than duplicating definitions:

```typescript
steps: WEBHOOK_STEPS.filter(s =>
  s.key === 'webhook:create-endpoint'
),
```

This is the pattern used by `firebase-core.plugin.ts`, which cherry-picks specific step keys from the larger `FIREBASE_STEPS` array.

### Optional: attach a ProviderAdapter

If your integration needs custom API logic beyond what a StepHandler provides, set the `adapter` field:

```typescript
import { WebhookAdapter } from '../../providers/webhook.js';
adapter: new WebhookAdapter(),
```

The `llm-openai` plugin uses this pattern to attach `LlmAdapter`.

---

## Step 4 — Register the Plugin

Open `src/plugins/builtin/index.ts` and add your plugin in the appropriate tier:

```typescript
import { webhookPlugin } from './webhook-endpoints.plugin.js';

// In registerBuiltinPlugins():
globalPluginRegistry.register(webhookPlugin);
```

Tiers are based on dependency order:
- **Tier 0** — no dependencies on other plugins
- **Tier 1** — depends on tier-0 plugins
- **Tier 2** — depends on tier-1 plugins

If your plugin declares `requiredModules: ['firebase-core']`, register it after `firebaseCorePlugin`.

Also add a named export at the bottom of the file:

```typescript
export { webhookPlugin };
```

---

## Step 5 — Write a StepHandler

StepHandlers live in `src/provisioning/`. Create `src/provisioning/webhook-step-handlers.ts`:

```typescript
import type { StepHandler, StepHandlerContext, StepHandlerResult } from './step-handler-registry.js';

export const createWebhookEndpointHandler: StepHandler = {
  async create(context: StepHandlerContext): Promise<StepHandlerResult> {
    const { projectId, environment, getToken, vaultManager, passphrase } = context;

    // 1. Fetch an access token if your provider uses OAuth:
    //    const token = await getToken('webhook');

    // 2. Make your API call to create the resource.
    const endpointUrl = `https://hooks.example.com/${projectId}/${environment}`;
    const secret = crypto.randomUUID();

    // 3. Return artifacts. 'outputs' keys must match your step's outputs[].key.
    return {
      status: 'success',
      outputs: {
        webhook_url: endpointUrl,
        webhook_secret: secret,   // sensitive — stored encrypted in vault
      },
    };
  },

  async delete(context: StepHandlerContext): Promise<StepHandlerResult> {
    // Tear down the resource.
    return { status: 'success', outputs: {} };
  },

  async validate(context: StepHandlerContext): Promise<StepHandlerResult> {
    // Verify the resource exists without making changes.
    return { status: 'success', outputs: {} };
  },
};
```

The `StepHandlerContext` gives you:

| Field | Type | Notes |
|---|---|---|
| `projectId` | `string` | The current project |
| `environment` | `string \| undefined` | Set for `per-environment` steps |
| `upstreamArtifacts` | `Record<string, string>` | Outputs from dependency steps |
| `userInputs` | `Record<string, string> \| undefined` | Values from `inputFields` |
| `getToken(provider)` | `Promise<string>` | OAuth access token; throws if unavailable |
| `hasToken(provider)` | `boolean` | True if a refresh token is stored |
| `vaultManager` | `VaultManager` | Direct vault read/write |
| `passphrase` | `Buffer` | 32-byte vault DEK for encryption |
| `credentialService` | `CredentialService \| undefined` | Studio SQLite credential store |
| `projectManager` | `ProjectManager` | Integration metadata updates |

---

## Step 6 — Register the Handler

Open `src/provisioning/step-handler-registry.ts` (or a dedicated registration file) and register your handler keyed to the step's `key`:

```typescript
import { createWebhookEndpointHandler } from './webhook-step-handlers.js';

// In the handler map:
'webhook:create-endpoint': createWebhookEndpointHandler,
```

---

## Step 7 — Test

Run the test suite:

```bash
npm test
```

The `integration-registry.test.ts` suite validates that every plugin:
- Has a valid `integrationId` that exists in `BUILTIN_INTEGRATIONS`
- Has a unique `id`
- References only step keys that exist in `step-registry.ts`
- Resolves correctly via `globalPluginRegistry`

If your plugin fails to resolve, check:
1. `integrationId` matches an `id` in `BUILTIN_INTEGRATIONS`
2. `registerBuiltinPlugins()` is called in the test setup
3. All step keys referenced exist in the registry
4. The plugin is exported from `src/plugins/builtin/index.ts`

---

## Worked Example: Webhook Plugin

Here is the complete minimal set of changes for a `webhook` integration with one automated step.

**Files to create:**
- `src/provisioning/steps/webhook-steps.ts`
- `src/plugins/builtin/webhook-endpoints.plugin.ts`
- `src/provisioning/webhook-step-handlers.ts`

**Files to modify:**
- `src/plugins/builtin-integrations.ts` — add `webhook` to `BUILTIN_INTEGRATIONS`
- `src/provisioning/step-registry.ts` — export `WEBHOOK_STEPS`, `WEBHOOK_TEARDOWN_STEPS`
- `src/plugins/builtin/index.ts` — register `webhookPlugin`
- `src/provisioning/step-handler-registry.ts` — register `createWebhookEndpointHandler`

That is eight files total for a brand-new integration with one step. Adding a new plugin to an existing integration requires only five (no changes to `builtin-integrations.ts` or `step-registry.ts` if you inline the steps in your plugin file).

The LLM plugins (`llm-openai`, `llm-anthropic`, `llm-gemini`, `llm-custom`) are a good reference for plugins that share a single `provider` string and use sibling registration to contribute separate user-action gates without duplicating infrastructure.
