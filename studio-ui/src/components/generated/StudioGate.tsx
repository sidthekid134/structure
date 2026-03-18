import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Github,
  Cpu,
  Shield,
  Zap,
  Layers,
  Lock,
  CheckCircle2,
  Loader2,
  ChevronRight,
  Terminal,
  BrainCircuit,
  Webhook,
} from 'lucide-react';
import PlatformStudio from './PlatformStudio';

const FEATURE_ITEMS = [
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

const AUTH_STEPS = [
  { id: 's1', label: 'Connecting to GitHub OAuth...' },
  { id: 's2', label: 'Verifying organization access...' },
  { id: 's3', label: 'Loading workspace...' },
];

type AuthState = 'idle' | 'loading' | 'success';

const GitHubLoginPage = ({
  onAuthenticated,
}: {
  onAuthenticated: () => void;
}) => {
  const [authState, setAuthState] = useState<AuthState>('idle');
  const [stepIndex, setStepIndex] = useState(0);

  const handleLogin = () => {
    if (authState !== 'idle') return;

    setAuthState('loading');
    setStepIndex(0);

    const advance = (idx: number) => {
      if (idx < AUTH_STEPS.length) {
        setStepIndex(idx);
        setTimeout(() => advance(idx + 1), 900);
      } else {
        setAuthState('success');
        setTimeout(() => onAuthenticated(), 700);
      }
    };

    advance(0);
  };

  return (
    <div className="relative flex h-screen w-screen overflow-hidden bg-background font-sans">
      <div
        className="pointer-events-none select-none"
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          backgroundImage: `
            linear-gradient(oklch(0.187 0.004 262.2 / 0.04) 1px, transparent 1px),
            linear-gradient(90deg, oklch(0.187 0.004 262.2 / 0.04) 1px, transparent 1px)
          `,
          backgroundSize: '48px 48px',
          zIndex: 0,
        }}
      />

      <div
        className="pointer-events-none select-none"
        aria-hidden="true"
        style={{
          position: 'fixed',
          top: '-20%',
          left: '-10%',
          width: '60%',
          height: '60%',
          background:
            'radial-gradient(ellipse at center, oklch(0.573 0.181 259.6 / 0.06) 0%, transparent 70%)',
          zIndex: 0,
        }}
      />
      <div
        className="pointer-events-none select-none"
        aria-hidden="true"
        style={{
          position: 'fixed',
          bottom: '-20%',
          right: '-10%',
          width: '55%',
          height: '55%',
          background:
            'radial-gradient(ellipse at center, oklch(0.312 0.181 259.6 / 0.05) 0%, transparent 70%)',
          zIndex: 0,
        }}
      />

      <div className="fixed top-0 left-0 right-0 z-10 border-b border-border bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-screen-xl items-center justify-between px-6">
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-sm">
              <Cpu size={15} />
            </div>
            <span className="text-sm font-bold tracking-tight">Studio Core</span>
            <span className="ml-1 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-bold text-muted-foreground">
              LLM INFRA
            </span>
          </div>
          <nav className="flex items-center gap-4">
            <a
              href="#"
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <Terminal size={12} />
              <span>Docs</span>
            </a>
            <a
              href="#"
              className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Pricing
            </a>
          </nav>
        </div>
      </div>

      <div className="relative z-10 flex h-full w-full flex-col items-center justify-center gap-16 px-6 pt-14 lg:flex-row">
        <motion.div
          initial={{ opacity: 0, x: -24 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut', delay: 0.1 }}
          className="hidden max-w-md flex-col gap-6 lg:flex"
        >
          <div className="space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/8 px-3 py-1.5 text-xs font-bold text-primary">
              <Zap size={11} fill="currentColor" />
              <span>LLM as Infrastructure</span>
            </div>
            <h1 className="text-4xl font-bold leading-tight tracking-tight text-foreground">
              Your AI provisions
              <br />
              <span className="font-normal text-muted-foreground">
                the entire stack for you.
              </span>
            </h1>
            <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">
              Studio Core is LLM-as-infrastructure. Provision auth, databases, CI/CD,
              notifications, and AI integrations via MCP tool calls or REST API - with
              a full Web UI. You focus on code and business logic; Studio takes care of
              the rest.
            </p>
          </div>

          <div className="space-y-3">
            {FEATURE_ITEMS.map((item, index) => {
              const ItemIcon = item.icon;
              return (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, x: -16 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{
                    duration: 0.4,
                    ease: 'easeOut',
                    delay: 0.25 + index * 0.07,
                  }}
                  className="flex items-center gap-3.5"
                >
                  <div className={`shrink-0 rounded-lg p-2 ${item.bg}`}>
                    <ItemIcon size={15} className={item.color} />
                  </div>
                  <div>
                    <p className="text-sm font-semibold leading-tight text-foreground">
                      {item.label}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                  <ChevronRight
                    size={14}
                    className="ml-auto shrink-0 text-muted-foreground/40"
                  />
                </motion.div>
              );
            })}
          </div>

          <div className="flex items-center gap-4 pt-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Shield size={12} className="text-emerald-500" />
              <span>SOC 2 compliant</span>
            </div>
            <div className="h-3 w-px bg-border" />
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <CheckCircle2 size={12} className="text-emerald-500" />
              <span>No credit card required</span>
            </div>
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.45, ease: 'easeOut', delay: 0.15 }}
          className="w-full max-w-sm"
        >
          <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-xl">
            <div className="h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent" />

            <div className="space-y-7 p-8">
              <div className="space-y-4 text-center">
                <div className="flex items-center justify-center">
                  <div className="relative">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary shadow-lg">
                      <Cpu size={26} className="text-primary-foreground" />
                    </div>
                    <div
                      className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border-2 border-background bg-card shadow-sm"
                      style={{ bottom: -4, right: -4 }}
                    >
                      <div className="h-2 w-2 rounded-full bg-emerald-500" />
                    </div>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <h2 className="text-xl font-bold tracking-tight text-foreground">
                    Sign in to Studio Core
                  </h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    Connect your GitHub account to access your workspace and start
                    provisioning third-party services via MCP or API.
                  </p>
                </div>
              </div>

              <div className="space-y-3">
                <AnimatePresence mode="wait">
                  {authState === 'idle' && (
                    <motion.div
                      key="idle"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.18 }}
                    >
                      <motion.button
                        onClick={handleLogin}
                        className="flex w-full items-center justify-center gap-3 rounded-xl bg-foreground px-5 py-3.5 text-sm font-bold text-background shadow-sm transition-shadow"
                        whileHover={{
                          scale: 1.015,
                          boxShadow: '0 8px 30px oklch(0.187 0.004 262.2 / 0.18)',
                        }}
                        whileTap={{ scale: 0.975 }}
                        transition={{
                          type: 'spring',
                          stiffness: 400,
                          damping: 24,
                        }}
                      >
                        <Github size={18} />
                        <span>Continue with GitHub</span>
                        <ChevronRight size={15} className="ml-auto opacity-60" />
                      </motion.button>
                    </motion.div>
                  )}

                  {authState === 'loading' && (
                    <motion.div
                      key="loading"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.18 }}
                      className="space-y-4"
                    >
                      <div className="flex w-full cursor-wait items-center justify-center gap-3 rounded-xl border border-border bg-foreground/10 px-5 py-3.5 text-sm font-bold text-muted-foreground">
                        <Loader2 size={17} className="animate-spin" />
                        <span>Authenticating...</span>
                      </div>
                      <div className="space-y-2.5 px-1">
                        {AUTH_STEPS.map((step, idx) => {
                          const isActive = idx === stepIndex;
                          const isDone = idx < stepIndex;
                          return (
                            <div key={step.id} className="flex items-center gap-2.5">
                              <div
                                className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-all duration-300 ${isDone ? 'bg-emerald-500' : isActive ? 'border-2 border-primary bg-primary/20' : 'border border-border bg-muted'}`}
                              >
                                {isDone && (
                                  <CheckCircle2 size={10} className="text-white" />
                                )}
                                {isActive && (
                                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                                )}
                              </div>
                              <span
                                className={`text-xs transition-colors duration-300 ${isDone ? 'font-medium text-emerald-600' : isActive ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
                              >
                                {step.label}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}

                  {authState === 'success' && (
                    <motion.div
                      key="success"
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.22 }}
                      className="flex w-full items-center justify-center gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/15 px-5 py-3.5 text-sm font-bold text-emerald-600"
                    >
                      <CheckCircle2 size={17} />
                      <span>Authenticated - loading workspace...</span>
                    </motion.div>
                  )}
                </AnimatePresence>

                {authState === 'idle' && (
                  <div className="flex items-center gap-3">
                    <div className="h-px flex-grow bg-border" />
                    <span className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                      or
                    </span>
                    <div className="h-px flex-grow bg-border" />
                  </div>
                )}

                {authState === 'idle' && (
                  <motion.button
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/40 px-5 py-3 text-sm font-medium text-muted-foreground transition-all hover:border-primary/30 hover:bg-muted/70 hover:text-foreground"
                    whileHover={{ scale: 1.008 }}
                    whileTap={{ scale: 0.984 }}
                    transition={{
                      type: 'spring',
                      stiffness: 400,
                      damping: 24,
                    }}
                    onClick={handleLogin}
                  >
                    <Terminal size={15} />
                    <span>Continue with SSO</span>
                  </motion.button>
                )}
              </div>

              <div className="space-y-3 border-t border-border pt-5">
                <div className="flex items-center justify-center gap-5">
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Shield size={11} className="text-emerald-500" />
                    <span>OAuth 2.0 secured</span>
                  </div>
                  <div className="h-3 w-px bg-border" />
                  <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Lock size={11} className="text-muted-foreground" />
                    <span>No password stored</span>
                  </div>
                </div>
                <p className="text-center text-[10px] leading-relaxed text-muted-foreground">
                  By continuing, you agree to our{' '}
                  <a href="#" className="underline transition-colors hover:text-foreground">
                    Terms of Service
                  </a>{' '}
                  and{' '}
                  <a href="#" className="underline transition-colors hover:text-foreground">
                    Privacy Policy
                  </a>
                  .
                </p>
              </div>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 lg:hidden">
            {FEATURE_ITEMS.map((item) => {
              const ItemIcon = item.icon;
              return (
                <div
                  key={item.id}
                  className="flex items-start gap-2.5 rounded-xl border border-border bg-card p-3.5 shadow-sm"
                >
                  <div className={`shrink-0 rounded-lg p-1.5 ${item.bg}`}>
                    <ItemIcon size={13} className={item.color} />
                  </div>
                  <div>
                    <p className="text-xs font-semibold leading-tight text-foreground">
                      {item.label}
                    </p>
                    <p className="mt-0.5 text-[10px] leading-snug text-muted-foreground">
                      {item.description}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </motion.div>
      </div>

      <div className="fixed bottom-0 left-0 right-0 z-10 flex items-center justify-between border-t border-border bg-background/80 px-6 py-2.5 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" />
            <span>All systems operational</span>
          </div>
          <div className="hidden h-3 w-px bg-border sm:block" />
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            v0.9.0-beta
          </span>
        </div>
        <div className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-400" />
          <span className="text-emerald-600">MCP</span>
          <span>ws://localhost:3001</span>
        </div>
      </div>
    </div>
  );
};

/** Set to true to show the GitHub OAuth login gate; false = unauthenticated, user-inputted token only */
const SHOW_LOGIN_GATE = false;

export const StudioGate = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(!SHOW_LOGIN_GATE);

  return (
    <AnimatePresence mode="wait">
      {!isAuthenticated ? (
        <motion.div
          key="login"
          initial={{ opacity: 1 }}
          exit={{ opacity: 0, scale: 1.02 }}
          transition={{ duration: 0.35, ease: 'easeIn' }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 50,
          }}
        >
          <GitHubLoginPage onAuthenticated={() => setIsAuthenticated(true)} />
        </motion.div>
      ) : (
        <motion.div
          key="studio"
          initial={{ opacity: 0, scale: 0.98 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.4, ease: 'easeOut' }}
          style={{
            width: '100%',
            height: '100%',
          }}
        >
          <PlatformStudio />
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default StudioGate;
