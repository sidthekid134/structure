/**
 * DependencyResolver — determines provider execution order based on hard
 * dependencies between providers.
 *
 * Dependency graph:
 *   firebase → (nothing)
 *   github   → firebase (needs Firebase credentials for secrets injection)
 *   eas      → github (needs GitHub workflows for CI/CD)
 *   apple    → github (needs GitHub for fingerprints)
 *   google-play → github (needs SHA-1 fingerprint from GitHub)
 *   cloudflare → (nothing, but needs domain from project setup)
 *   oauth    → firebase (wires Firebase auth provider)
 */

import { ProviderType, PROVIDER_DEPENDENCY_ORDER } from '../providers/types.js';

/** Hard dependencies: provider → providers it depends on */
const DEPENDENCIES: Readonly<Record<ProviderType, ProviderType[]>> = {
  firebase: [],
  github: ['firebase'],
  eas: ['github'],
  apple: ['github'],
  'google-play': ['github'],
  cloudflare: [],
  oauth: ['firebase'],
};

export class DependencyResolver {
  /**
   * Returns providers in dependency order — all dependencies before dependents.
   * If a subset of providers is supplied, only those are returned (in correct order).
   */
  static resolveOrder(providers: ProviderType[]): ProviderType[] {
    const requested = new Set(providers);
    return PROVIDER_DEPENDENCY_ORDER.filter(p => requested.has(p));
  }

  /**
   * Returns the dependency chain for a single provider (including itself).
   * Result is in execution order (dependencies first).
   */
  static getDependencyChain(provider: ProviderType): ProviderType[] {
    const chain: ProviderType[] = [];
    const visited = new Set<ProviderType>();

    const visit = (p: ProviderType): void => {
      if (visited.has(p)) return;
      visited.add(p);
      for (const dep of DEPENDENCIES[p]) {
        visit(dep);
      }
      chain.push(p);
    };

    visit(provider);
    return chain;
  }

  /**
   * Returns the direct dependencies of a provider.
   */
  static getDependencies(provider: ProviderType): ProviderType[] {
    return [...DEPENDENCIES[provider]];
  }

  /**
   * Returns all providers that depend on the given provider.
   */
  static getDependents(provider: ProviderType): ProviderType[] {
    return (Object.entries(DEPENDENCIES) as [ProviderType, ProviderType[]][])
      .filter(([, deps]) => deps.includes(provider))
      .map(([p]) => p);
  }

  /**
   * Validates that a given provider order satisfies all dependency constraints.
   * Throws if any dependency would be executed after its dependent.
   */
  static validateOrder(providers: ProviderType[]): void {
    const positions = new Map<ProviderType, number>(providers.map((p, i) => [p, i]));

    for (const provider of providers) {
      const deps = DEPENDENCIES[provider];
      for (const dep of deps) {
        if (!positions.has(dep)) continue; // dep not in this run — skip
        const depPos = positions.get(dep)!;
        const providerPos = positions.get(provider)!;
        if (depPos > providerPos) {
          throw new Error(
            `Provider order violation: "${dep}" must run before "${provider}" ` +
              `but appears at position ${depPos} (after ${providerPos})`,
          );
        }
      }
    }
  }
}
