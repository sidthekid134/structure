import { BrainCircuit, Layers, Lock, Webhook } from 'lucide-react';

export const FEATURE_ITEMS = [
  {
    id: 'llm-infra',
    icon: BrainCircuit,
    color: 'text-violet-500',
    bg: 'bg-violet-500/10',
    label: 'LLM as Infrastructure',
    description:
      'Provision Firebase, EAS & GitHub via LLM MCP calls or REST API - no console needed',
  },
  {
    id: 'mcp',
    icon: Webhook,
    color: 'text-blue-500',
    bg: 'bg-blue-500/10',
    label: 'MCP & API Gateway',
    description:
      'Every third-party interaction routed through structured MCP tool calls or direct API',
  },
  {
    id: 'ui',
    icon: Layers,
    color: 'text-amber-500',
    bg: 'bg-amber-500/10',
    label: 'Web UI Studio',
    description:
      'Full visual interface to configure, trigger, and monitor all provisioning workflows',
  },
  {
    id: 'vault',
    icon: Lock,
    color: 'text-emerald-500',
    bg: 'bg-emerald-500/10',
    label: 'Secure Vault',
    description:
      'Encrypted credential management - your secrets, never exposed to the LLM layer',
  },
];

export const AUTH_STEPS = [
  { id: 's1', label: 'Connecting to GitHub OAuth...' },
  { id: 's2', label: 'Verifying organization access...' },
  { id: 's3', label: 'Loading workspace...' },
];
