/**
 * Journey phases for provisioning UX: semantic labels, dependency-safe ranks,
 * canonical node order, and flattened sequential execution item order.
 */

import type {
  ProvisioningNode,
  ProvisioningStepNode,
  UserActionNode,
} from './graph.types.js';
import { MODULE_CATALOG } from './module-catalog.js';

// ---------------------------------------------------------------------------
// Phase ids (fixed journey order for UX + tie-breaking)
// ---------------------------------------------------------------------------

export const JOURNEY_PHASE_ORDER = [
  'accounts',
  'domain_dns',
  'credentials',
  'cloud_firebase',
  'repo',
  'cicd',
  'mobile_build',
  'signing_apple',
  'play',
  'edge_ssl',
  'deep_links',
  'oauth',
  'verification',
  'teardown',
] as const;

export type JourneyPhaseId = (typeof JOURNEY_PHASE_ORDER)[number];

const PHASE_RANK: Record<JourneyPhaseId, number> = Object.fromEntries(
  JOURNEY_PHASE_ORDER.map((id, i) => [id, i]),
) as Record<JourneyPhaseId, number>;

export const JOURNEY_PHASE_TITLE: Record<JourneyPhaseId, string> = {
  accounts: 'Accounts & billing',
  domain_dns: 'Domain & DNS',
  credentials: 'Credentials & access',
  cloud_firebase: 'Cloud & Firebase',
  repo: 'Source repository',
  cicd: 'CI/CD & automation',
  mobile_build: 'Mobile builds',
  signing_apple: 'Apple signing & App Store',
  play: 'Google Play',
  edge_ssl: 'Edge & SSL',
  deep_links: 'Deep linking',
  oauth: 'Auth & OAuth',
  verification: 'Verification & go-live',
  teardown: 'Teardown',
};

function isStep(n: ProvisioningNode): n is ProvisioningStepNode {
  return n.type === 'step';
}

function isUserAction(n: ProvisioningNode): n is UserActionNode {
  return n.type === 'user-action';
}

/**
 * Initial journey phase from node semantics only (before dependency propagation).
 */
export function semanticJourneyPhase(node: ProvisioningNode): JourneyPhaseId {
  if (isStep(node) && node.direction === 'teardown') return 'teardown';

  if (isUserAction(node)) {
    switch (node.category) {
      case 'account-enrollment':
        return 'accounts';
      case 'credential-upload':
        return 'credentials';
      case 'external-configuration':
        if (node.provider === 'cloudflare' || /domain|dns|nameserver/i.test(node.key)) {
          return 'domain_dns';
        }
        return 'credentials';
      case 'approval':
        return 'verification';
      default:
        return 'verification';
    }
  }

  const step = node as ProvisioningStepNode;
  const k = step.key;

  if (step.provider === 'firebase') return 'cloud_firebase';

  if (step.provider === 'github') {
    if (
      k.includes('inject-secrets') ||
      k.includes('deploy-workflows') ||
      k.includes('workflow')
    ) {
      return 'cicd';
    }
    return 'repo';
  }

  if (step.provider === 'eas') return 'mobile_build';
  if (step.provider === 'apple') return 'signing_apple';
  if (step.provider === 'google-play') return 'play';
  if (step.provider === 'oauth') return 'oauth';

  if (step.provider === 'cloudflare') {
    if (k.includes('add-domain') || k.includes('zone')) return 'domain_dns';
    if (
      k.includes('apple-app-site') ||
      k.includes('asset-links') ||
      k.includes('deep-link')
    ) {
      return 'deep_links';
    }
    return 'edge_ssl';
  }

  return 'verification';
}

function nodeOrderHint(node: ProvisioningNode): number {
  return node.orderHint ?? 0;
}

/**
 * For each node, phase rank = max(semantic rank, max(dep phase ranks)).
 */
export function propagateJourneyPhases(nodes: ProvisioningNode[]): Map<string, JourneyPhaseId> {
  const nodeMap = new Map(nodes.map((n) => [n.key, n]));
  const semanticRank = new Map<string, number>();
  for (const n of nodes) {
    semanticRank.set(n.key, PHASE_RANK[semanticJourneyPhase(n)]);
  }

  const topoKeys = topologicalSortKeys(nodes);
  const effectiveRank = new Map<string, number>();

  for (const key of topoKeys) {
    let r = semanticRank.get(key) ?? 0;
    const node = nodeMap.get(key);
    if (node) {
      for (const dep of node.dependencies) {
        if (!dep.required) continue;
        if (!nodeMap.has(dep.nodeKey)) continue;
        r = Math.max(r, effectiveRank.get(dep.nodeKey) ?? 0);
      }
    }
    effectiveRank.set(key, r);
  }

  const out = new Map<string, JourneyPhaseId>();
  for (const key of nodes.map((n) => n.key)) {
    const idx = effectiveRank.get(key) ?? 0;
    out.set(key, JOURNEY_PHASE_ORDER[Math.min(idx, JOURNEY_PHASE_ORDER.length - 1)]!);
  }
  return out;
}

/** Kahn topological sort; if cycle remains, append missing keys sorted (for propagation fallback). */
export function topologicalSortKeys(nodes: ProvisioningNode[]): string[] {
  const nodeMap = new Map(nodes.map((n) => [n.key, n]));
  const inDegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>();

  for (const n of nodes) {
    inDegree.set(n.key, 0);
    edges.set(n.key, new Set());
  }
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!nodeMap.has(dep.nodeKey)) continue;
      inDegree.set(n.key, (inDegree.get(n.key) ?? 0) + 1);
      edges.get(dep.nodeKey)?.add(n.key);
    }
  }

  const queue = nodes
    .map((n) => n.key)
    .filter((k) => (inDegree.get(k) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));
  const order: string[] = [];

  while (queue.length > 0) {
    queue.sort((a, b) => a.localeCompare(b));
    const key = queue.shift()!;
    order.push(key);
    for (const next of edges.get(key) ?? []) {
      const d = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (order.length !== nodes.length) {
    for (const n of nodes) {
      if (!order.includes(n.key)) order.push(n.key);
    }
    order.sort((a, b) => a.localeCompare(b));
  }
  return order;
}

/**
 * Deterministic topological order: tie-break by effective phase rank, orderHint, key.
 */
export function computeCanonicalNodeOrder(
  nodes: ProvisioningNode[],
  journeyPhaseByNodeKey: Map<string, JourneyPhaseId>,
): string[] {
  const nodeMap = new Map(nodes.map((n) => [n.key, n]));
  const inDegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>();

  for (const n of nodes) {
    inDegree.set(n.key, 0);
    edges.set(n.key, new Set());
  }
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!nodeMap.has(dep.nodeKey)) continue;
      inDegree.set(n.key, (inDegree.get(n.key) ?? 0) + 1);
      edges.get(dep.nodeKey)?.add(n.key);
    }
  }

  const rankOf = (key: string) => PHASE_RANK[journeyPhaseByNodeKey.get(key) ?? 'verification']!;

  const pickNext = (candidates: string[]): string => {
    return candidates.sort((a, b) => {
      const ra = rankOf(a);
      const rb = rankOf(b);
      if (ra !== rb) return ra - rb;
      const ha = nodeOrderHint(nodeMap.get(a)!);
      const hb = nodeOrderHint(nodeMap.get(b)!);
      if (ha !== hb) return ha - hb;
      return a.localeCompare(b);
    })[0]!;
  };

  const order: string[] = [];
  const ready = () =>
    nodes.map((n) => n.key).filter((k) => (inDegree.get(k) ?? 0) === 0 && !order.includes(k));

  while (order.length < nodes.length) {
    const cand = ready();
    if (cand.length === 0) {
      const remaining = nodes.map((n) => n.key).filter((k) => !order.includes(k));
      remaining.sort((a, b) => a.localeCompare(b));
      order.push(...remaining);
      break;
    }
    const next = pickNext(cand);
    order.push(next);
    for (const down of edges.get(next) ?? []) {
      inDegree.set(down, (inDegree.get(down) ?? 1) - 1);
    }
  }

  return order;
}

export interface ExecutionPlanItem {
  nodeKey: string;
  environment?: string;
}

/**
 * Flatten logical nodes into sequential execution items (sorted env order per per-env step).
 */
export function computeSequentialExecutionItems(
  canonicalNodeOrder: string[],
  nodes: ProvisioningNode[],
  environments: string[],
): ExecutionPlanItem[] {
  const nodeMap = new Map(nodes.map((n) => [n.key, n]));
  const envSorted = [...environments].sort((a, b) => a.localeCompare(b));
  const items: ExecutionPlanItem[] = [];

  for (const key of canonicalNodeOrder) {
    const node = nodeMap.get(key);
    if (!node) continue;
    if (node.type === 'step' && node.environmentScope === 'per-environment') {
      for (const env of envSorted) {
        items.push({ nodeKey: key, environment: env });
      }
    } else {
      items.push({ nodeKey: key });
    }
  }

  return items;
}

export interface PlanViewModel {
  canonicalNodeOrder: string[];
  journeyPhaseByNodeKey: Record<string, JourneyPhaseId>;
  journeyPhaseOrder: JourneyPhaseId[];
  sequentialExecutionItems: ExecutionPlanItem[];
  /** Maps node key → module id for attribution in the UI. */
  moduleByNodeKey: Record<string, string>;
  /** Maps module id → human-readable label. */
  moduleLabelById: Record<string, string>;
}

function buildModuleByNodeKey(): { moduleByNodeKey: Record<string, string>; moduleLabelById: Record<string, string> } {
  const moduleByNodeKey: Record<string, string> = {};
  const moduleLabelById: Record<string, string> = {};

  for (const mod of Object.values(MODULE_CATALOG)) {
    moduleLabelById[mod.id] = mod.label;
    for (const key of mod.stepKeys) {
      if (!(key in moduleByNodeKey)) moduleByNodeKey[key] = mod.id;
    }
    for (const key of mod.teardownStepKeys) {
      if (!(key in moduleByNodeKey)) moduleByNodeKey[key] = mod.id;
    }
    for (const key of mod.userActionKeys ?? []) {
      if (!(key in moduleByNodeKey)) moduleByNodeKey[key] = mod.id;
    }
  }

  return { moduleByNodeKey, moduleLabelById };
}

export function buildPlanViewModel(
  nodes: ProvisioningNode[],
  environments: string[],
): PlanViewModel {
  const journeyMap = propagateJourneyPhases(nodes);
  const canonicalNodeOrder = computeCanonicalNodeOrder(nodes, journeyMap);
  const journeyPhaseByNodeKey = Object.fromEntries(journeyMap) as Record<string, JourneyPhaseId>;
  const sequentialExecutionItems = computeSequentialExecutionItems(
    canonicalNodeOrder,
    nodes,
    environments,
  );

  const seen = new Set<JourneyPhaseId>();
  const journeyPhaseOrder: JourneyPhaseId[] = [];
  for (const k of canonicalNodeOrder) {
    const phase = journeyMap.get(k);
    if (!phase || seen.has(phase)) continue;
    seen.add(phase);
    journeyPhaseOrder.push(phase);
  }

  const { moduleByNodeKey, moduleLabelById } = buildModuleByNodeKey();

  return {
    canonicalNodeOrder,
    journeyPhaseByNodeKey,
    journeyPhaseOrder,
    sequentialExecutionItems,
    moduleByNodeKey,
    moduleLabelById,
  };
}

export function validatePlanAcyclic(nodes: ProvisioningNode[]): void {
  const nodeMap = new Map(nodes.map((n) => [n.key, n]));
  const inDegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>();

  for (const n of nodes) {
    inDegree.set(n.key, 0);
    edges.set(n.key, new Set());
  }
  for (const n of nodes) {
    for (const dep of n.dependencies) {
      if (!nodeMap.has(dep.nodeKey)) continue;
      inDegree.set(n.key, (inDegree.get(n.key) ?? 0) + 1);
      edges.get(dep.nodeKey)?.add(n.key);
    }
  }

  const queue = nodes
    .map((n) => n.key)
    .filter((k) => (inDegree.get(k) ?? 0) === 0)
    .sort((a, b) => a.localeCompare(b));
  let processed = 0;

  while (queue.length > 0) {
    queue.sort((a, b) => a.localeCompare(b));
    const k = queue.shift()!;
    processed++;
    for (const next of edges.get(k) ?? []) {
      const d = (inDegree.get(next) ?? 1) - 1;
      inDegree.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  if (processed !== nodes.length) {
    throw new Error(
      `Provisioning plan graph has a cycle or unsatisfiable dependencies (${processed}/${nodes.length} nodes ordered).`,
    );
  }
}
