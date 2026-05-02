/**
 * Built-in integration definitions.
 *
 * One entry per top-level vendor/platform. Each plugin sets `integrationId`
 * to one of these. The Studio UI consumes this list (via /api/integrations)
 * to render swimlanes and the integrations tab.
 *
 * Adding a new integration is a one-line addition here plus setting
 * `integrationId` on the plugins that belong to it. No Studio Core change
 * required.
 */

import type { IntegrationDefinition } from './integration-types.js';

export const BUILTIN_INTEGRATIONS: IntegrationDefinition[] = [
  {
    id: 'gcp',
    label: 'Google Cloud',
    description:
      'Google Cloud Platform — Firebase Auth, Firestore, Storage, Messaging, and the underlying GCP project.',
    scope: 'project',
    authProvider: 'gcp',
    icon: 'Cloud',
    displayMeta: {
      label: 'Google Cloud',
      color: 'text-orange-500',
      bg: 'bg-orange-500/10',
      border: 'border-orange-500/30',
    },
    order: 10,
  },
  {
    id: 'apple',
    label: 'Apple',
    description:
      'Apple App Store Connect — code signing, distribution certificates, push notification keys.',
    scope: 'organization',
    authProvider: 'apple',
    icon: 'Apple',
    displayMeta: {
      label: 'Apple',
      color: 'text-zinc-200',
      bg: 'bg-zinc-500/10',
      border: 'border-zinc-500/30',
    },
    order: 20,
  },
  {
    id: 'google-play',
    label: 'Google Play',
    description: 'Google Play Console — Android signing, internal testing, store listing.',
    scope: 'organization',
    icon: 'PlaySquare',
    displayMeta: {
      label: 'Google Play',
      color: 'text-emerald-500',
      bg: 'bg-emerald-500/10',
      border: 'border-emerald-500/30',
    },
    order: 30,
  },
  {
    id: 'github',
    label: 'GitHub',
    description: 'GitHub — source repository, secrets, CI workflows.',
    scope: 'organization',
    authProvider: 'github',
    icon: 'Github',
    displayMeta: {
      label: 'GitHub',
      color: 'text-zinc-200',
      bg: 'bg-zinc-500/10',
      border: 'border-zinc-500/30',
    },
    order: 40,
  },
  {
    id: 'eas',
    label: 'Expo EAS',
    description: 'Expo Application Services — managed mobile builds and store submissions.',
    scope: 'organization',
    authProvider: 'expo',
    icon: 'Smartphone',
    displayMeta: {
      label: 'EAS',
      color: 'text-indigo-400',
      bg: 'bg-indigo-500/10',
      border: 'border-indigo-500/30',
    },
    order: 50,
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare',
    description: 'Cloudflare DNS, domain routing, and edge configuration.',
    scope: 'organization',
    icon: 'Globe',
    displayMeta: {
      label: 'Cloudflare',
      color: 'text-amber-500',
      bg: 'bg-amber-500/10',
      border: 'border-amber-500/30',
    },
    order: 60,
  },
  {
    id: 'llm',
    label: 'LLM Providers',
    description: 'Per-app LLM API keys: OpenAI, Anthropic, Google Gemini, or a custom endpoint.',
    scope: 'project',
    icon: 'Sparkles',
    displayMeta: {
      label: 'LLM',
      color: 'text-violet-400',
      bg: 'bg-violet-500/10',
      border: 'border-violet-500/30',
    },
    order: 70,
  },
];
