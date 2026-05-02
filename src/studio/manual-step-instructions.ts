/**
 * Server-rendered, step-by-step manual instructions for steps that are
 * intrinsically manual (i.e. the provider's API does not support what we
 * want to automate, so the user must perform the action in a portal).
 *
 * Unlike `userPrompt` (which only appears once a step pauses in
 * `waiting-on-user` state), manual instructions ship with the plan and are
 * rendered by the UI BEFORE the user runs the step — they are the
 * authoritative checklist for that step's whole lifetime.
 */

import type { ProvisioningPlan, ProvisioningNode } from '../provisioning/graph.types.js';
import type { ProjectModule } from './project-manager.js';
import { projectPrimaryDomain, projectResourceSlug } from './project-identity.js';
import { buildStudioGcpProjectId } from '../core/gcp-connection.js';

export interface ManualInstructionDownload {
  /**
   * Filename the browser should save the file as, *exactly* as the upstream
   * portal expects to see it (e.g. Apple's `AuthKey_<KEYID>.p8` convention,
   * which Studio also reads back to derive the Key ID from the filename).
   */
  filename: string;
  /**
   * Same-origin URL the browser will GET to download the file. The URL is
   * expected to set Content-Disposition: attachment with the matching filename
   * so the user just clicks once.
   */
  url: string;
  /** Short hint rendered under the download button (size, source, caveat). */
  description?: string;
}

export interface ManualInstructionStep {
  /** Single-line summary of the action ("Open App Store Connect"). */
  title: string;
  /** Optional clarifier rendered under the title (URLs, copy-paste values, caveats). */
  detail?: string;
  /** Optional full text payload rendered with a one-click copy button. */
  copyText?: string;
  /**
   * Files the user needs while performing this step (typically things they
   * uploaded to Studio earlier and now have to re-upload to a third-party
   * portal). Rendered as download buttons inline with the step.
   */
  downloads?: ManualInstructionDownload[];
}

export interface ManualInstructions {
  /** One-line lede explaining why this is manual. */
  intro?: string;
  /** Numbered checklist of actions, in order. */
  steps: ManualInstructionStep[];
  /** Footer note rendered under the list (role requirements, gotchas). */
  note?: string;
}

/**
 * Read-only snapshot of the project's unified Apple Auth Key registry, as
 * understood from the plan's persisted `userInputs`. Both Apple key steps
 * write `apple_auth_key_id` to their own NodeState.userInputs once the user
 * saves; we collect those into `knownKeyIds` so the per-step instruction
 * builder can render edit-mode (just toggle the capability checkbox on the
 * existing key in Apple Developer) instead of the long create-mode
 * checklist.
 *
 * We only look at userInputs (not the actual vault registry) because manual
 * instructions are server-rendered into the plan response and the wizard's
 * client-side smart toggle relies on the same data source — keeping these
 * in sync avoids the instruction telling the user "edit existing key" while
 * the wizard still shows the .p8 upload, or vice versa.
 */
export interface AppleAuthKeyRegistrySnapshot {
  /**
   * Key IDs the project has captured across any Apple key step. Each entry
   * is normalised to upper case to match Apple's 10-char Key ID convention.
   */
  knownKeyIds: Set<string>;
  /**
   * Capabilities already claimed against each known Key ID, derived from
   * the step that recorded the userInput. Lets the SIWA edit-mode know that
   * a key was first added by the APNs step (so the instructions can say
   * "add Sign In with Apple to your existing APNs key" rather than the
   * generic edit blurb).
   */
  capabilitiesByKeyId: Record<string, Set<string>>;
}

interface InstructionContext {
  /** Studio project id — used for building download URLs that point back at this project's vault. */
  projectId: string;
  upstream: Record<string, string>;
  /**
   * User-typed values from the step's inputFields (NodeState.userInputs),
   * keyed by inputField.key. Lets the manual checklist reflect what the
   * user actually configured (e.g. the App Store Connect listing name they
   * intend to use, which often differs from the project name because App
   * Store names must be globally unique).
   */
  userInputs: Record<string, string>;
  slug: string;
  domain: string;
  bundleId: string;
  appName: string;
  expectedGcpId: string;
  platforms: string[];
  environments: string[];
  /** Project-wide Apple Auth Key snapshot (see type docs). */
  appleAuthKeys: AppleAuthKeyRegistrySnapshot;
}

type InstructionBuilder = (ctx: InstructionContext) => ManualInstructions;

type LlmKind = 'openai' | 'anthropic' | 'gemini' | 'custom';

const LLM_RUNTIME_KEYS_BY_KIND: Record<LlmKind, string[]> = {
  openai: ['LLM_OPENAI_API_KEY', 'LLM_OPENAI_ORGANIZATION_ID', 'LLM_OPENAI_DEFAULT_MODEL'],
  anthropic: ['LLM_ANTHROPIC_API_KEY', 'LLM_ANTHROPIC_DEFAULT_MODEL'],
  gemini: ['LLM_GEMINI_API_KEY', 'LLM_GEMINI_DEFAULT_MODEL'],
  custom: ['LLM_CUSTOM_API_KEY', 'LLM_CUSTOM_BASE_URL', 'LLM_CUSTOM_DEFAULT_MODEL'],
};

const LLM_VAULT_SLOTS_BY_KIND: Record<LlmKind, string[]> = {
  openai: ['llm/openai_api_key', 'llm/openai_organization_id'],
  anthropic: ['llm/anthropic_api_key'],
  gemini: ['llm/gemini_api_key'],
  custom: ['llm/custom_api_key', 'llm/custom_base_url'],
};

function buildLlmIntegrationPromptInstructions(
  ctx: InstructionContext,
  kind: LlmKind,
  providerLabel: string,
): ManualInstructions {
  const envKeys = LLM_RUNTIME_KEYS_BY_KIND[kind];
  const vaultSlots = LLM_VAULT_SLOTS_BY_KIND[kind];
  const platformLabel = ctx.platforms.length > 0 ? ctx.platforms.join(', ') : 'ios, android';
  const envLabel = ctx.environments.length > 0 ? ctx.environments.join(', ') : 'preview, production';
  const bundleId = ctx.bundleId || `com.example.${ctx.slug}`;
  const domainLabel = ctx.domain || `${ctx.slug}.example.com`;
  const defaultModel = (ctx.upstream[`llm_${kind}_default_model`] ?? '').trim();

  const prompt =
    `Update the "${ctx.appName}" app to use ${providerLabel}. ` +
    `Project context: slug="${ctx.slug}", domain="${domainLabel}", bundleId="${bundleId}", ` +
    `platforms=${platformLabel}, environments=${envLabel}. ` +
    `Read credentials from ${envKeys.map((k) => `process.env.${k}`).join(', ')} ` +
    `(synced by Studio to Expo EAS env slots ${envLabel}); fallback source in Studio vault slots: ${vaultSlots.join(', ')}. ` +
    `Keep tokens server-side only, never log or hardcode them, and add a provider health check plus clear error reporting.` +
    (defaultModel ? ` Default model currently pinned by Studio: "${defaultModel}".` : '');

  return {
    intro:
      `This handoff gate gives you a copy/paste prompt to apply the ${providerLabel} integration in your app repository via your coding LLM, with project-specific context.`,
    steps: [
      {
        title: `Review where ${providerLabel} credentials are available`,
        detail:
          `Expo EAS runtime env vars: ${envKeys.join(', ')}. Studio vault slots: ${vaultSlots.join(', ')}.`,
      },
      {
        title: 'Copy this prompt into your project coding LLM',
        detail: 'Use the copy button to grab the full prompt, then paste it into your coding LLM.',
        copyText: prompt,
      },
      {
        title: 'Apply changes in your app repo, run your local smoke test, then mark this gate complete',
        detail:
          `Validate on ${platformLabel} targets and verify env resolution across ${envLabel} configurations before confirming.`,
      },
    ],
    note:
      'This confirmation step does not mutate your repository automatically; it verifies that app-level integration handoff has been completed intentionally.',
  };
}

/**
 * Registry of manual-instruction builders keyed by node key. Add a new
 * entry here only when the underlying provider API genuinely cannot
 * automate the step (e.g. App Store Connect's `/v1/apps` endpoint forbids
 * CREATE).
 */
const MANUAL_INSTRUCTION_REGISTRY: Record<string, InstructionBuilder> = {
  'user:provide-cloudflare-token': (_ctx) => ({
    intro:
      'This step supports two modes: reuse your organization Cloudflare token (default), or provide a project-specific override token only if you need tighter scope.',
    steps: [
      {
        title: 'If organization Cloudflare is already connected, reuse it and continue',
        detail:
          'No new token is required for this project. Studio will use the org-level token automatically.',
      },
      {
        title: 'Optional override only: create a project token in Cloudflare',
        detail: 'Open Cloudflare API Tokens: https://dash.cloudflare.com/profile/api-tokens',
      },
      {
        title: 'Use zone-scoped permission rows',
        detail:
          'Add: "Zone | DNS | Edit", "Zone | Zone | Read", "Zone | Page Rules | Edit", and "Zone | Zone Settings | Edit" (or "Zone | SSL and Certificates | Edit" if Zone Settings is unavailable).',
      },
      {
        title: 'Restrict resources to this project apex zone, then paste token in this step',
        detail:
          'For app host flow.third-brain.net, scope the token to third-brain.net. Project token overrides org token for this project only.',
      },
    ],
    note:
      'Your org token remains the default across projects. Use project overrides only when you need stricter zone isolation.',
  }),
  'user:confirm-dns-nameservers': (ctx) => {
    const zoneDomain =
      ctx.upstream['cloudflare_zone_domain']?.trim() ||
      (ctx.domain && ctx.domain.split('.').length >= 2
        ? ctx.domain.split('.').slice(-2).join('.')
        : ctx.domain || 'your domain');
    const appDomain = ctx.upstream['cloudflare_app_domain']?.trim() || ctx.domain || zoneDomain;
    const nameserversRaw = ctx.upstream['cloudflare_zone_nameservers']?.trim() || '';
    const nameserverList = nameserversRaw
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);

    return {
      intro:
        'Domain ownership is confirmed only when the root zone is Active in Cloudflare. ' +
        'Until activation completes, Studio cannot safely continue DNS, SSL, deep-link landing routes, or OAuth callback routing.',
      steps: [
        {
          title: 'Part A - Open zone overview in Cloudflare',
          detail: `Open Cloudflare Dashboard and select zone "${zoneDomain}": https://dash.cloudflare.com/`,
        },
        {
          title: 'Locate status in Overview and confirm whether zone is Pending or Active',
          detail:
            'If Pending, nameserver delegation has not fully propagated yet. If Active, ownership is already verified. Status reference: https://developers.cloudflare.com/dns/zone-setups/reference/domain-status/',
        },
        {
          title: 'Copy the exact Cloudflare nameservers assigned to this zone',
          detail:
            nameserverList.length > 0
              ? `Expected nameservers: ${nameserverList.join(', ')}`
              : 'Use the exact nameservers shown in Cloudflare for this zone overview page. Nameserver setup guide: https://developers.cloudflare.com/dns/zone-setups/full-setup/setup/',
        },
        {
          title: `Part B - Open your registrar for "${zoneDomain}"`,
          detail:
            `Use whichever registrar hosts the domain registration (for example GoDaddy, Namecheap, Google Domains, Route 53 Registrar, etc). Registrar lookup: https://www.whois.com/whois/${encodeURIComponent(zoneDomain)}`,
        },
        {
          title: 'Replace current nameservers with only the Cloudflare-assigned nameservers',
          detail:
            'Remove old provider nameservers completely. Do not mix old + new entries or delegation can remain inconsistent.',
        },
        {
          title: 'Save registrar changes and wait for delegation propagation',
          detail:
            'Propagation is registrar/TLD dependent and can take minutes to several hours. Some registrars display "pending update" states while publishing nameserver changes.',
        },
        {
          title: 'Part C - Recheck Cloudflare zone status until it becomes Active',
          detail:
            'Refresh the zone Overview page. Once Active, Cloudflare has authoritative control and this gate can be completed. Troubleshooting activation: https://developers.cloudflare.com/dns/zone-setups/troubleshooting/',
        },
        {
          title: 'Re-run this Studio gate after status is Active',
          detail:
            'Studio will verify ownership through the API and persist zone status outputs for downstream steps.',
        },
        {
          title: `Part D - Continue provisioning DNS and routing for app host "${appDomain}"`,
          detail:
            `If app host is a subdomain, ownership is still validated at the root zone "${zoneDomain}". Subsequent DNS steps will target the app host.`,
        },
      ],
      note:
        'If status does not become Active after registrar update, verify there are no DSSEC/Registrar locks, stale nameserver glue records, or typo mismatches in assigned nameservers. ' +
        'Zone activation must succeed before Cloudflare automation is considered safe.',
    };
  },
  'apple:create-app-store-listing': (ctx) => {
    const bundleId = ctx.bundleId || `com.example.${ctx.slug}`;
    // Prefer the name the user typed into the step's `asc_app_name` input
    // field; fall back to the project's display name. App Store names must
    // be globally unique, so the user often has to deviate from
    // project.name (e.g. "Flow" → "Flow Mobile") and the checklist needs
    // to reflect their actual intent.
    const appName = ctx.userInputs['asc_app_name']?.trim() || ctx.appName;
    return {
      intro:
        "Apple's App Store Connect API does not allow creating apps — only GET / UPDATE. " +
        'Create the listing once in App Store Connect using the values below; ' +
        'on the next run Studio detects it via filter[bundleId] and stores asc_app_id automatically.',
      steps: [
        {
          title: 'Open App Store Connect → Apps',
          detail: 'https://appstoreconnect.apple.com/apps',
        },
        {
          title: 'Click the "+" button at the top of the apps list and choose "New App"',
        },
        {
          title: 'Platform: iOS',
          detail: 'You cannot change the platform after creation, so set this correctly now.',
        },
        {
          title: `Bundle ID: select "${bundleId}" from the dropdown`,
          detail:
            'This bundle ID was already registered in Apple Developer Portal by the "Register App ID" step. If it does not appear, re-run that step first.',
        },
        {
          title: `Name: "${appName}"`,
          detail:
            'Must be unique across the App Store. If taken, append a short qualifier — Studio will pick up whatever name you save.',
        },
        {
          title: `SKU: "${bundleId}"`,
          detail: 'Internal-only identifier. Using the bundle ID keeps it predictable.',
        },
        {
          title: 'Primary Language: English (U.S.)',
        },
        {
          title: 'Click "Create", then return here and re-run this step',
          detail:
            'Studio queries /v1/apps?filter[bundleId]=… and stores the new asc_app_id once Apple returns the listing.',
        },
      ],
      note:
        'Only the App Store Connect Account Holder or an Admin can create new apps. ' +
        'App Manager, Developer, Marketing, Sales, Customer Support, and Finance roles cannot — Apple will hide the "+" button for them.',
    };
  },
  'apple:create-sign-in-key': (ctx) =>
    buildAppleAuthKeyInstructions(ctx, 'sign_in_with_apple'),
  'apple:generate-apns-key': (ctx) => buildAppleAuthKeyInstructions(ctx, 'apns'),
  'apple:store-signing-in-eas': (ctx) => {
    const bundleId =
      ctx.upstream['apple_bundle_id']?.trim() || ctx.bundleId || `com.example.${ctx.slug}`;
    return {
      intro:
        'Studio mints the iOS Distribution Certificate + App Store Provisioning Profile and uploads them to EAS automatically — no manual portal work needed. ' +
        'BUT EAS has a known bug (https://github.com/expo/eas-cli/issues/3202) where credentials uploaded via its GraphQL API are flagged "not validated for non-interactive builds". ' +
        'Until the flag is flipped, every CI run of `eas build --non-interactive` fails with "Distribution Certificate is not validated for non-interactive builds. Failed to set up credentials." ' +
        'A one-time interactive `eas credentials` session on a developer machine is required to flip the flag. Do this AFTER Studio finishes the step.',
      steps: [
        {
          title: 'In your app repo, run `npx eas-cli@latest credentials -p ios`',
          detail:
            'Set EXPO_TOKEN to the same robot/user token your GitHub Action uses (so EAS resolves to the same account that owns the credentials Studio just uploaded). ' +
            `If you have multiple Expo projects, pick the one matching bundle id "${bundleId}".`,
        },
        {
          title: 'Pick the `production` build profile when prompted',
          detail:
            'EAS will list every profile defined in your eas.json. Choose the one your CI builds (`production` is the default; pick whichever matches your `eas build --profile <name>` invocation in the workflow).',
        },
        {
          title: 'Choose "Use existing Distribution Certificate" → confirm Studio\'s upload',
          detail:
            'EAS will show the cert Studio just uploaded (matching serial number visible in expo.dev → your app → Credentials → iOS). Select it instead of letting EAS mint a new one — Apple caps each team at 2 active iOS Distribution certs.',
        },
        {
          title: 'Choose "Use existing Provisioning Profile" → confirm Studio\'s upload',
          detail:
            'Same idea — pick the profile Studio uploaded. EAS hits Apple via the App Store Connect API key to verify both, and that verification call is what flips the "validated for non-interactive builds" flag.',
        },
        {
          title: 'Exit (Ctrl+C or pick "Go back" until you exit), then re-run your failing GitHub Action',
          detail:
            'No code changes needed. The same `eas build --platform ios --profile production --non-interactive` invocation that was failing will now succeed.',
        },
        {
          title: 'If you are running locally from Xcode / `npx expo run:ios`, follow Expo signing setup',
          detail:
            'Use the official Expo guide to configure local Xcode signing for your Apple team and bundle identifier: https://github.com/expo/fyi/blob/main/setup-xcode-signing.md',
        },
      ],
      note:
        'You only have to do this once per cert (i.e. again in ~1 year when the cert is rotated). ' +
        'Until Expo ships an explicit `validateCredentials` GraphQL mutation, Studio cannot flip the flag from the server side.',
    };
  },
  'apple:upload-apns-to-firebase': (ctx) => {
    // Firebase Console deep-links to a specific app's Cloud Messaging tab via
    //   /project/<projectId>/settings/cloudmessaging/<platform>:<id>
    // For an iOS app the suffix is `ios:<bundle_id>`. Built fresh on every
    // plan fetch so the link always reflects the latest project ids without
    // requiring the user to re-run the step to refresh a stale userPrompt.
    const firebaseProjectId =
      ctx.upstream['firebase_project_id']?.trim() ||
      ctx.upstream['gcp_project_id']?.trim() ||
      ctx.expectedGcpId;
    const bundleId =
      ctx.upstream['apple_bundle_id']?.trim() ||
      ctx.upstream['bundle_id']?.trim() ||
      ctx.bundleId;
    const cloudMessagingUrl = `https://console.firebase.google.com/project/${firebaseProjectId}/settings/cloudmessaging/ios:${bundleId}`;
    const teamId = ctx.upstream['apple_team_id']?.trim();

    // Surface the .p8 the user previously uploaded for the APNs capability so
    // they do not have to dig through their downloads folder for the original
    // file Apple gave them. The Key ID is published by apple:generate-apns-key
    // as `apple_auth_key_id_apns`; fall back to scanning the registry snapshot
    // in case that resource isn't propagated through upstream.
    const apnsKeyIdFromUpstream = ctx.upstream['apple_auth_key_id_apns']?.trim().toUpperCase();
    const apnsKeyIdFromSnapshot = (() => {
      for (const [keyId, capabilities] of Object.entries(ctx.appleAuthKeys.capabilitiesByKeyId)) {
        if (capabilities.has('apns')) return keyId;
      }
      return null;
    })();
    const apnsKeyId = apnsKeyIdFromUpstream || apnsKeyIdFromSnapshot || null;
    const apnsDownloads: ManualInstructionDownload[] = apnsKeyId
      ? [
          {
            filename: `AuthKey_${apnsKeyId}.p8`,
            url: `/api/projects/${encodeURIComponent(ctx.projectId)}/apple/auth-keys/${encodeURIComponent(apnsKeyId)}/p8`,
            description:
              'Re-download the .p8 Studio vaulted when you ran "Generate APNs Key" \u2014 saved with the exact AuthKey_<KEYID>.p8 filename Apple expects (so Firebase can derive the Key ID from it).',
          },
        ]
      : [];

    return {
      intro:
        'Firebase needs the Apple APNs Authentication Key (.p8) so FCM can deliver pushes through Apple\u2019s servers. ' +
        'The .p8 itself was vaulted by the upstream "Generate APNs Key" step \u2014 download it from Studio below and re-upload it to Firebase.',
      steps: [
        {
          title: 'Open Firebase Console \u2192 Project settings \u2192 Cloud Messaging (iOS app)',
          detail: cloudMessagingUrl,
        },
        {
          title: 'Under "APNs Authentication Key", upload the same .p8 to BOTH the development and production rows',
          detail:
            'Unlike the legacy APNs Certificates section (which needs separate dev/prod certs), a single .p8 Auth Key talks to both Apple\u2019s sandbox and production APNs gateways. Click Upload on the "No development APNs auth key" row first, then again on the "No production APNs auth key" row \u2014 same file both times. This makes debug builds and TestFlight/App Store builds both deliver pushes. Ignore the "APNs Certificates" panel below.',
        },
        {
          title: apnsKeyId
            ? `Use the AuthKey_${apnsKeyId}.p8 file Studio has vaulted (download below) for both rows`
            : 'Locate the AuthKey_<KEYID>.p8 file you downloaded when you generated the APNs key (use it for both rows)',
          detail: apnsKeyId
            ? 'Studio re-emits the original PEM bytes with the AuthKey_<KEYID>.p8 filename Apple expects \u2014 Firebase reads the Key ID directly from the filename. The same download is uploaded twice (development row + production row).'
            : 'Run "Generate APNs Key" first so Studio has the .p8 vaulted; this step will then offer it as a one-click download.',
          downloads: apnsDownloads,
        },
        {
          title: apnsKeyId
            ? `Key ID: "${apnsKeyId}" (Firebase pre-fills it from the filename)${teamId ? `; Team ID: "${teamId}"` : ''}`
            : `Key ID: read it from the AuthKey_<KEYID>.p8 filename${teamId ? `; Team ID: "${teamId}"` : ''}`,
          detail: teamId
            ? `Studio pre-fills Team ID "${teamId}" from the org-level Apple integration so you only need to confirm it matches in both rows.`
            : 'Team ID will be pre-filled once the org-level Apple integration is connected.',
        },
        {
          title: 'After both rows show "Uploaded", return here and mark this step complete',
          detail:
            'Firebase persists the key against your iOS app; you do not need to re-upload it for additional Studio environments (development / preview / production all share the same APNs key).',
        },
      ],
      note:
        'Same file in both Firebase rows is intentional \u2014 a .p8 Auth Key authenticates against both APNs sandbox and APNs production. Only certificate-based push (the panel below) needs separate dev vs prod files. ' +
        'One Apple Auth Key can also power both APNs and Sign in with Apple \u2014 if you enabled SIWA, the same .p8 (with the SIWA capability ticked in Apple Developer) is reused. ' +
        'If FCM still fails after upload, double-check the bundle id in Firebase\u2019s iOS app settings matches your Xcode/EAS build.',
    };
  },
  'oauth:prepare-app-integration-kit': (ctx) => {
    const slug = ctx.slug || ctx.projectId;
    const zipName = `${slug}-auth-integration-kit.zip`;
    const promptName = `${slug}-auth-llm-prompt.txt`;
    return {
      intro:
        'This final handoff packages your configured auth outputs into a downloadable kit for your app repository. ' +
        'Use the generated prompt with your coding LLM so auth wiring is applied directly in the app codebase with the exact values from this project.',
      steps: [
        {
          title: `Download "${zipName}"`,
          detail:
            'Contains auth-config.json, install-map.json, and an LLM-ready prompt with all resolved OAuth identifiers and deep-link settings.',
          downloads: [
            {
              filename: zipName,
              url: `/api/projects/${encodeURIComponent(ctx.projectId)}/integration-kit/auth/zip`,
              description:
                'Regenerate this bundle whenever auth step outputs change so your app repo always receives current values.',
            },
          ],
        },
        {
          title: `Download "${promptName}" (optional standalone copy)`,
          detail:
            'Use when you only need the copy/paste prompt text without re-downloading the full kit archive.',
          downloads: [
            {
              filename: promptName,
              url: `/api/projects/${encodeURIComponent(ctx.projectId)}/integration-kit/auth/prompt`,
              description:
                'Same prompt also exists inside the zip as llm-prompt.txt.',
            },
          ],
        },
        {
          title: 'Open your app repository with your coding LLM and paste llm-prompt.txt',
          detail:
            'Ask it to apply the integration directly in the repo, place auth-config.json in the best config path, and wire native Google/Apple sign-in plus deep-link callbacks.',
        },
        {
          title: 'Run your app auth smoke test on device/simulator',
          detail:
            'Verify Google sign-in, Apple sign-in (if enabled), and redirect/deep-link return paths before shipping.',
        },
      ],
      note:
        'This handoff step does not mutate your app repository directly; it provides deterministic integration artifacts and a generated implementation prompt based on completed provisioning resources.',
    };
  },
  'user:verify-auth-integration-kit': (ctx) => ({
    intro:
      'After applying the generated auth kit in your app repository, explicitly verify the integration before marking this gate complete.',
    steps: [
      {
        title: 'Apply the generated auth integration kit in your app repository',
        detail:
          'Use the downloaded llm-prompt.txt + auth-config.json artifacts from "Prepare App Integration Kit" so wiring uses the exact provisioned auth values.',
      },
      {
        title: 'Verify auth state persistence and session hydration',
        detail:
          'Confirm login survives refresh/restart, app startup correctly rehydrates the authenticated session, and protected routes reflect auth state.',
      },
      {
        title: 'Verify logout/sign-out behavior',
        detail:
          'Confirm logout exists and clears persisted auth/session state, then routes users back to the signed-out flow.',
      },
      {
        title: 'Mark this gate done only after the above checks pass',
        detail:
          'If checks fail, fix app integration first and re-test before completing this verification gate.',
      },
    ],
    note:
      'This gate is a user verification checkpoint so Studio does not treat app-repo auth wiring as complete until you explicitly confirm it.',
  }),
  'user:share-openai-integration-prompt': (ctx) =>
    buildLlmIntegrationPromptInstructions(ctx, 'openai', 'OpenAI'),
  'user:share-anthropic-integration-prompt': (ctx) =>
    buildLlmIntegrationPromptInstructions(ctx, 'anthropic', 'Anthropic Claude'),
  'user:share-gemini-integration-prompt': (ctx) =>
    buildLlmIntegrationPromptInstructions(ctx, 'gemini', 'Google Gemini'),
  'user:share-custom-llm-integration-prompt': (ctx) =>
    buildLlmIntegrationPromptInstructions(ctx, 'custom', 'Custom OpenAI-compatible'),
};

type Capability = 'apns' | 'sign_in_with_apple';

const CAPABILITY_LABEL: Record<Capability, string> = {
  apns: 'Apple Push Notifications service (APNs)',
  sign_in_with_apple: 'Sign in with Apple',
};

/**
 * Builder shared by the APNs and Sign In with Apple steps. Renders one of two
 * shapes:
 *
 *   create-mode: the project does not yet have an Apple Auth Key, OR the
 *     user typed a Key ID Studio has never seen. Full create-key checklist
 *     (10+ steps), enforces a `<App Name> Auth Key` naming convention so
 *     all capabilities for this project live on a single .p8. Apple's Key
 *     Name field rejects anything other than letters, numbers, and spaces
 *     (no hyphens, underscores, or punctuation), so the suggested name is
 *     always sanitised before being shown to the user.
 *
 *   edit-mode: the project already has at least one vaulted Apple Auth Key
 *     and the user typed a matching Key ID. Short checklist (3-4 steps) —
 *     just open the existing key in Apple Developer, tick the capability
 *     checkbox, save. SIWA edit-mode also includes the Service ID + Return
 *     URL section because the Service ID is a separate Apple resource that
 *     the key existence does not imply.
 */
function buildAppleAuthKeyInstructions(
  ctx: InstructionContext,
  capability: Capability,
): ManualInstructions {
  const bundleId = ctx.bundleId || `com.example.${ctx.slug}`;
  // Apple's Key Name field is strict: it only accepts letters, numbers,
  // and spaces, with a 30-char limit. Slugs are typically kebab-case
  // ("flow-app") and app names may contain punctuation ("Flow: Mobile"),
  // both of which Apple rejects with a generic "wrong format" error. We
  // sanitise to alphanumerics + spaces, collapse runs of whitespace, then
  // trim and cap at 30 chars including the trailing " Auth Key" suffix.
  const sanitiseAppleKeyName = (raw: string): string => {
    const cleaned = raw
      .replace(/[^A-Za-z0-9 ]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned;
  };
  const suffix = ' Auth Key';
  const maxBase = 30 - suffix.length;
  const baseRaw = ctx.appName?.trim() || ctx.slug || 'Project';
  const base = sanitiseAppleKeyName(baseRaw).slice(0, maxBase).trim() || 'Project';
  const suggestedKeyName = `${base}${suffix}`;
  const typedKeyId = ctx.userInputs['apple_auth_key_id']?.trim().toUpperCase();
  const knownKeyIds = ctx.appleAuthKeys.knownKeyIds;

  // edit-mode if the user has typed a Key ID we've already seen anywhere in
  // this project, OR if they haven't typed anything yet but the project
  // already has a key (in which case we should nudge reuse)
  const reuseTargetKeyId =
    (typedKeyId && knownKeyIds.has(typedKeyId) && typedKeyId) ||
    (knownKeyIds.size > 0 ? Array.from(knownKeyIds)[0]! : null);

  const isEditMode = !!reuseTargetKeyId;
  const isSiwa = capability === 'sign_in_with_apple';
  const capabilityLabel = CAPABILITY_LABEL[capability];

  const requestedServiceId =
    ctx.userInputs['apple_sign_in_service_id']?.trim() || `${bundleId}.signin`;
  const returnUrl = `https://${ctx.expectedGcpId}.firebaseapp.com/__/auth/handler`;
  const appleAppId = ctx.upstream['apple_app_id']?.trim() || '';
  const appIdEditUrl = appleAppId
    ? `https://developer.apple.com/account/resources/identifiers/bundleId/edit/${appleAppId}`
    : 'https://developer.apple.com/account/resources/identifiers/list/bundleId';

  const siwaPrerequisiteSteps: ManualInstructionStep[] = isSiwa
    ? [
        { title: 'Part A \u2014 Enable Sign In with Apple on the App ID' },
        {
          title: appleAppId
            ? `Open App ID "${bundleId}" directly in edit mode`
            : 'Open Apple Developer \u2192 Identifiers \u2192 App IDs, then open your app identifier',
          detail: appIdEditUrl,
        },
        {
          title: `Select App ID "${bundleId}", click "Edit", ensure "Sign In with Apple" is enabled, then Save`,
          detail:
            'This App ID capability toggle is required in addition to key capability + Services ID setup. If it is already enabled, just confirm it remains on.',
        },
        { title: 'Part B \u2014 Configure the Services ID (separate Apple resource)' },
        {
          title: 'Open Apple Developer \u2192 Identifiers \u2192 Services IDs',
          detail: 'https://developer.apple.com/account/resources/identifiers/list/serviceId',
        },
        {
          title: `If "${requestedServiceId}" already exists, open it; otherwise click "+" and select "Services IDs"`,
          detail:
            'The Services ID is a separate Apple identifier from the .p8 key — it acts as the OAuth client_id. Reverse-DNS, globally unique across Apple. The default suffix ".signin" avoids colliding with your App ID.',
        },
        {
          title: `Description: "${ctx.appName} Sign In" (or any human-readable label)`,
        },
        {
          title: `Identifier: "${requestedServiceId}"`,
          detail: 'Keep this in sync with the input field above.',
        },
        { title: 'Check "Sign In with Apple", then click Configure' },
        {
          title: `Primary App ID: select "${bundleId}"`,
          detail:
            'The App ID registered by the "Register App ID" step. If it does not appear, re-run that step first.',
        },
        {
          title: `Domains and Subdomains: "${ctx.expectedGcpId}.firebaseapp.com"`,
          detail:
            'No https://, no path \u2014 just the host. Hosts your Firebase auth handler.',
        },
        {
          title: `Return URLs: "${returnUrl}"`,
          detail:
            'Full URL including https:// and the /__/auth/handler path. Firebase Auth posts back here after Apple authenticates the user.',
        },
        { title: 'Click Next \u2192 Done \u2192 Continue \u2192 Save' },
      ]
    : [];

  if (isEditMode) {
    const editKeyUrl = reuseTargetKeyId
      ? `https://developer.apple.com/account/resources/authkeys/edit/${reuseTargetKeyId}`
      : 'https://developer.apple.com/account/resources/authkeys/list';
    const otherCaps = reuseTargetKeyId
      ? Array.from(ctx.appleAuthKeys.capabilitiesByKeyId[reuseTargetKeyId] ?? [])
          .filter((c) => c !== capability)
          .map((c) => CAPABILITY_LABEL[c as Capability] ?? c)
      : [];
    const otherCapsBlurb = otherCaps.length
      ? ` This key already bears: ${otherCaps.join(', ')}.`
      : '';

    return {
      intro:
        `This project already has an Apple Auth Key vaulted${reuseTargetKeyId ? ` ("${reuseTargetKeyId}")` : ''}.${otherCapsBlurb} ` +
        `One .p8 can carry any combination of capabilities, so add "${capabilityLabel}" to it instead of creating a second key. ` +
        'No .p8 re-upload is needed \u2014 click the existing Key ID chip above and Studio records the new capability annotation against the vaulted key.',
      steps: [
        ...(isSiwa ? siwaPrerequisiteSteps : []),
        { title: isSiwa ? 'Part C \u2014 Toggle the capability on the existing key' : 'Part A \u2014 Toggle the capability on the existing key' },
        {
          title: `Open Apple Developer \u2192 Keys \u2192 ${reuseTargetKeyId ?? 'your existing Auth Key'}`,
          detail: editKeyUrl,
        },
        {
          title: `Check "${capabilityLabel}" in the capability list`,
          detail:
            isSiwa
              ? 'If "Sign in with Apple" is greyed out, click "Configure" next to it and bind it to your App ID first.'
              : 'If "Apple Push Notifications service (APNs)" is greyed out, the key is bound to a different team \u2014 use "Save" to bind it.',
        },
        {
          title: `If "${capabilityLabel}" needs configuration, click "Configure" and bind to App ID "${bundleId}"`,
          detail:
            'Binding to a specific App ID limits blast radius if the key leaks; required for SIWA.',
        },
        { title: 'Click Save' },
        { title: isSiwa ? 'Part D \u2014 Save in Studio' : 'Part C \u2014 Save in Studio' },
        {
          title: `Click the "${reuseTargetKeyId ?? 'existing Key ID'}" chip in the "Reuse an existing key" picker above${
            isSiwa ? `, and confirm "${requestedServiceId}" is in "Apple Services ID"` : ''
          }`,
          detail:
            'The .p8 upload is hidden when reuse is selected because Studio already has the PEM in this project\'s Apple Auth Key registry.',
        },
        {
          title: 'Click "Save Configuration", then re-run this step',
          detail:
            'Studio updates the registry to record the new capability against the existing key.',
        },
      ],
      note:
        'Reusing one Apple Auth Key keeps offline-backup hygiene simple (one .p8 to safeguard) but increases blast radius if the key leaks. ' +
        (isSiwa
          ? 'If you change your Firebase project or use a custom auth domain via Cloudflare, update the Services ID Return URLs accordingly. '
          : '') +
        'Only Account Holder, Admin, and App Manager can edit keys.',
    };
  }

  return {
    intro:
      `Create a single Apple Auth Key (.p8) for this project that bears "${capabilityLabel}". ` +
      'Apple does not expose any of this via API \u2014 capabilities are toggled in Apple Developer \u2192 Keys ' +
      'and the .p8 download is one-time-only. ' +
      `Use the suggested name "${suggestedKeyName}" so future capability steps in this project will reuse the same key (the wizard surfaces it in the "Reuse an existing key" picker once vaulted).`,
    steps: [
      ...(isSiwa ? siwaPrerequisiteSteps : []),
      { title: isSiwa ? 'Part C \u2014 Create the Apple Auth Key' : 'Part A \u2014 Create the Apple Auth Key' },
      {
        title: 'Open Apple Developer \u2192 Keys',
        detail: 'https://developer.apple.com/account/resources/authkeys/list',
      },
      { title: 'Click the "+" (Create a key) button at the top of the Keys list' },
      {
        title: `Key Name: "${suggestedKeyName}"`,
        detail:
          'Use this exact name (or anything starting with the project slug) so any teammate adding more capabilities later knows to reuse this key instead of creating a new one. Internal-only \u2014 Apple does not surface it outside this page.',
      },
      {
        title: `Check "${capabilityLabel}"`,
        detail:
          'You can also check additional capabilities now if you know you\'ll need them (e.g. APNs + Sign in with Apple together). The other capabilities can also be added later from this same key\'s edit page.',
      },
      {
        title: `Click "Configure", then bind this key to App ID "${bundleId}"`,
        detail:
          'Binding to a specific App ID limits blast radius if the key leaks. Required for Sign in with Apple; recommended for APNs.',
      },
      { title: 'Click Save \u2192 Continue \u2192 Register' },
      {
        title: 'Click "Download" IMMEDIATELY on the next screen',
        detail:
          'Apple will only let you download the .p8 once. If you navigate away first, you have to revoke the key and start over. Keep the original AuthKey_<KEYID>.p8 filename \u2014 Studio extracts the Key ID from it.',
      },
      { title: isSiwa ? 'Part D \u2014 Save in Studio' : 'Part C \u2014 Save in Studio' },
      {
        title:
          'Drop the AuthKey_<KEYID>.p8 file into the upload above' +
          (isSiwa ? `, and confirm "${requestedServiceId}" is in "Apple Services ID"` : ''),
        detail:
          'Studio reads the .p8 in-browser, validates it as PEM, extracts the 10-character Key ID directly from the filename Apple set, and stores everything encrypted in this project\'s unified Apple Auth Key registry. No need to type the Key ID separately.',
      },
      {
        title: 'Click "Save Configuration", then re-run this step',
        detail:
          isSiwa
            ? 'After this completes, the downstream "Configure Apple Sign-In in Firebase" step will pick everything up and wire SIWA into Firebase Auth (both native iOS and web/redirect paths).'
            : 'After this completes, the downstream "Upload APNs Key to Firebase" step will pick it up.',
      },
    ],
    note:
      'Keep an offline backup of the .p8 file \u2014 Apple cannot re-issue it. ' +
      'Only Account Holder, Admin, and App Manager roles can create keys; Developer and below will not see the "+" button. ' +
      (isSiwa
        ? 'If you change your Firebase project or use a custom auth domain via Cloudflare, update the Services ID Return URLs accordingly.'
        : ''),
  };
}

function mergeCompletedUpstream(plan: ProvisioningPlan): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, state] of plan.nodeStates) {
    if ((state.status === 'completed' || state.status === 'skipped') && state.resourcesProduced) {
      Object.assign(out, state.resourcesProduced);
    }
  }
  return out;
}

/**
 * Find the most recent `userInputs` map persisted for a given node key.
 * NodeState is keyed per-environment as `<nodeKey>::<environment>`, but
 * manual-instruction nodes are global so any matching state's userInputs
 * works.
 */
function userInputsForNodeKey(
  plan: ProvisioningPlan,
  nodeKey: string,
): Record<string, string> {
  for (const [, state] of plan.nodeStates) {
    if (state.nodeKey === nodeKey && state.userInputs) {
      return state.userInputs;
    }
  }
  return {};
}

/**
 * Walk the plan's nodeStates collecting every Apple Auth Key ID the user has
 * ever typed into either capability step. Used to drive create-mode vs
 * edit-mode in the SIWA + APNs instruction builders without requiring access
 * to the live vault registry from this server-rendering pass.
 */
function buildAppleAuthKeyRegistrySnapshot(
  plan: ProvisioningPlan,
): AppleAuthKeyRegistrySnapshot {
  const knownKeyIds = new Set<string>();
  const capabilitiesByKeyId: Record<string, Set<string>> = {};
  const stepCapabilities: Record<string, string> = {
    'apple:generate-apns-key': 'apns',
    'apple:create-sign-in-key': 'sign_in_with_apple',
  };
  for (const [, state] of plan.nodeStates) {
    const capability = stepCapabilities[state.nodeKey];
    if (!capability) continue;
    const inputKeyId = state.userInputs?.['apple_auth_key_id']?.trim().toUpperCase();
    if (inputKeyId) {
      knownKeyIds.add(inputKeyId);
      const set = capabilitiesByKeyId[inputKeyId] ?? new Set<string>();
      set.add(capability);
      capabilitiesByKeyId[inputKeyId] = set;
    }
    // Also capture Key IDs that the step has actually published as
    // capability-tagged resources — accounts for any consumer that wrote to
    // the registry via a different path (e.g. the legacy REST endpoint).
    const producedKeyId = state.resourcesProduced?.[`apple_auth_key_id_${capability}`]
      ?.trim()
      .toUpperCase();
    if (producedKeyId) {
      knownKeyIds.add(producedKeyId);
      const set = capabilitiesByKeyId[producedKeyId] ?? new Set<string>();
      set.add(capability);
      capabilitiesByKeyId[producedKeyId] = set;
    }
  }
  return { knownKeyIds, capabilitiesByKeyId };
}

export function buildManualInstructionsByNodeKey(
  plan: ProvisioningPlan,
  projectModule: ProjectModule,
): Record<string, ManualInstructions> {
  const project = projectModule.project;
  const slug = projectResourceSlug(project);
  const domain = projectPrimaryDomain(project);
  const bundleId = project.bundleId?.trim() ?? '';
  // Mirror the same fallback chain used in api.ts when constructing the
  // Apple manifest's app_name and in planned-output-previews.
  const appName = project.name?.trim() || slug || plan.projectId;
  const expectedGcpId = buildStudioGcpProjectId(plan.projectId);
  const upstream = mergeCompletedUpstream(plan);
  const appleAuthKeys = buildAppleAuthKeyRegistrySnapshot(plan);

  const result: Record<string, ManualInstructions> = {};
  for (const node of plan.nodes as ProvisioningNode[]) {
    const builder = MANUAL_INSTRUCTION_REGISTRY[node.key];
    if (!builder) continue;
    result[node.key] = builder({
      projectId: plan.projectId,
      upstream,
      userInputs: userInputsForNodeKey(plan, node.key),
      slug,
      domain,
      bundleId,
      appName,
      expectedGcpId,
      platforms: project.platforms ?? [],
      environments: project.environments ?? [],
      appleAuthKeys,
    });
  }
  return result;
}
