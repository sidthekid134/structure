/**
 * ProviderLogo — renders a simple-icons SVG for a backend provider id.
 *
 * provider ids come from mod.provider in the plugin catalog:
 *   firebase | github | eas | apple | cloudflare | google-play | llm | oauth
 *
 * For `llm` the sub-provider (anthropic / openai / gemini / custom) is
 * inferred from the module id suffix when present.
 */

import {
  siAnthropic,
  siApple,
  siCloudflare,
  siExpo,
  siFirebase,
  siGithub,
  siGooglecloud,
  siGooglegemini,
  siGoogleplay,
  siOpenid,
} from 'simple-icons';
import { KeyRound, Sparkles } from 'lucide-react';

interface ProviderLogoProps {
  /** Backend provider id (e.g. 'firebase', 'eas', 'llm'). */
  provider: string;
  /** Module id — used to refine LLM sub-provider logos. */
  moduleId?: string;
  /** Icon size in px (width = height). Default 14. */
  size?: number;
  className?: string;
}

interface SimpleIconDef {
  path: string;
  hex: string;
}

/** Map provider id → simple-icon definition. */
const PROVIDER_ICON: Record<string, SimpleIconDef> = {
  github: siGithub,
  eas: siExpo,
  expo: siExpo,
  apple: siApple,
  cloudflare: siCloudflare,
  firebase: siFirebase,
  gcp: siGooglecloud,
  'google-play': siGoogleplay,
  oauth: siOpenid,
};

/** Map LLM module-id suffix → simple-icon definition. */
const LLM_MODULE_ICON: Record<string, SimpleIconDef> = {
  anthropic: siAnthropic,
  gemini: siGooglegemini,
};

/** Module-specific icons that are more precise than the owning provider id. */
const MODULE_ICON_PREFIX: Array<[string, SimpleIconDef]> = [
  ['gcp-project-', siGooglecloud],
  ['gcp-serverless-', siGooglecloud],
  ['firebase-', siFirebase],
  ['github-', siGithub],
  ['eas-', siExpo],
  ['apple-', siApple],
  ['cloudflare-', siCloudflare],
  ['google-play-', siGoogleplay],
  ['oauth-', siOpenid],
];

/**
 * UI color overrides.
 *
 * simple-icons provides a single monochrome brand hex. For some providers
 * (notably Google Play, OAuth and generic/custom LLM rows) that monochrome
 * value looks off against our dark canvas, so we define explicit UI accents.
 */
const PROVIDER_BRAND_COLOR_OVERRIDE: Record<string, string> = {
  firebase: '#FFCA28',
  gcp: '#4285F4',
  github: '#181717',
  eas: '#1C2024',
  expo: '#1C2024',
  apple: '#000000',
  cloudflare: '#F38020',
  'google-play': '#34A853',
  oauth: '#F78C40',
};

const LLM_BRAND_COLOR_OVERRIDE: Record<string, string> = {
  anthropic: '#D97757',
  gemini: '#8E75B2',
  openai: '#10A37F',
  custom: '#7C3AED',
};

function resolveLlmFlavor(moduleId: string): 'anthropic' | 'gemini' | 'openai' | 'custom' | null {
  const id = moduleId.toLowerCase();
  if (id.includes('anthropic')) return 'anthropic';
  if (id.includes('gemini')) return 'gemini';
  if (id.includes('openai')) return 'openai';
  if (id.includes('custom')) return 'custom';
  return null;
}

function resolveModuleIcon(moduleId: string): SimpleIconDef | undefined {
  const id = moduleId.toLowerCase();
  for (const [prefix, icon] of MODULE_ICON_PREFIX) {
    if (id.startsWith(prefix)) return icon;
  }
  return undefined;
}

function SimpleIconSvg({
  icon,
  size,
  className,
}: {
  icon: SimpleIconDef;
  size: number;
  className?: string;
}) {
  return (
    <svg
      role="img"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      aria-hidden
      fill="currentColor"
    >
      <path d={icon.path} />
    </svg>
  );
}

export function ProviderLogo({ provider, moduleId = '', size = 14, className }: ProviderLogoProps) {
  const moduleIcon = resolveModuleIcon(moduleId);
  if (moduleIcon) {
    return <SimpleIconSvg icon={moduleIcon} size={size} className={className} />;
  }

  // Direct provider match.
  const direct = PROVIDER_ICON[provider];
  if (direct) {
    return <SimpleIconSvg icon={direct} size={size} className={className} />;
  }

  // LLM provider: try to refine from module id suffix.
  if (provider === 'llm') {
    for (const [key, icon] of Object.entries(LLM_MODULE_ICON)) {
      if (moduleId.toLowerCase().includes(key)) {
        return <SimpleIconSvg icon={icon} size={size} className={className} />;
      }
    }
    // Generic LLM fallback.
    return <Sparkles size={size} className={className} strokeWidth={2} />;
  }

  // OAuth / unknown — use a key icon.
  return <KeyRound size={size} className={className} strokeWidth={2} />;
}

/**
 * Returns the brand hex color for a provider, adjusted for dark/light context.
 * Pass `dark=true` when rendering on a dark background so we can lighten
 * very dark colors (GitHub black, Apple black, Anthropic near-black, Expo black).
 */
export function providerBrandColor(provider: string, moduleId = '', dark = false): string {
  const DARK_THRESHOLD = 60; // combined R+G+B < this → near-black, needs lightening

  const hexToRgb = (hex: string) => {
    const n = parseInt(hex, 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
  };

  let hex: string | undefined;
  const moduleIcon = resolveModuleIcon(moduleId);
  if (moduleIcon) {
    hex = moduleIcon.hex;
  }

  const providerOverride = PROVIDER_BRAND_COLOR_OVERRIDE[provider];
  if (!hex && providerOverride) {
    hex = providerOverride.replace('#', '');
  } else if (!hex && provider === 'llm') {
    const flavor = resolveLlmFlavor(moduleId);
    if (flavor) {
      hex = LLM_BRAND_COLOR_OVERRIDE[flavor].replace('#', '');
    } else {
      hex = '#22c55e'.replace('#', '');
    }
  } else if (!hex) {
    const direct = PROVIDER_ICON[provider];
    if (direct) hex = direct.hex;
  }

  if (!hex) return 'currentColor';

  const { r, g, b } = hexToRgb(hex);
  const isDark = r + g + b < DARK_THRESHOLD;

  if (dark && isDark) {
    // On a dark background, near-black brand icons are invisible.
    // Lighten to a readable near-white.
    return '#e4e4e7'; // zinc-200
  }

  return `#${hex}`;
}
