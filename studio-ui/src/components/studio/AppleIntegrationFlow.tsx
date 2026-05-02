import { useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Eye,
  EyeOff,
  FileCheck2,
  Info,
  KeyRound,
  Link2,
  Loader2,
  ShieldCheck,
  Trash2,
  Unlink,
  Upload,
  X,
} from 'lucide-react';

interface AppleIntegrationFlowProps {
  /** Render without the modal backdrop — for embedding inside a step card. */
  inline?: boolean;
  isConnected: boolean;
  connectionDetails?: {
    team_id?: string;
    asc_issuer_id?: string;
    asc_api_key_id?: string;
  } | null;
  onClose: () => void;
  onConnect: (fields: Record<string, string>) => Promise<void>;
  onDisconnect: () => Promise<void>;
}

type AppleStepId = 'team-id' | 'create-key' | 'issuer-id' | 'key-id' | 'review';

interface AppleStep {
  id: AppleStepId;
  title: string;
  subtitle: string;
}

const STEPS: AppleStep[] = [
  { id: 'team-id', title: 'Apple Team ID', subtitle: 'Identify your Apple Developer team' },
  { id: 'create-key', title: 'Create & upload key', subtitle: 'Generate the Team Key, upload .p8' },
  { id: 'issuer-id', title: 'Issuer ID', subtitle: 'Copy the team-wide issuer UUID' },
  { id: 'key-id', title: 'Confirm Key ID', subtitle: 'Verify the Key ID extracted from the file' },
  { id: 'review', title: 'Review & connect', subtitle: 'Confirm and store credentials' },
];

const P8_FILENAME_RE = /AuthKey_([A-Z0-9]{10})\.p8$/i;
const MAX_P8_BYTES = 8 * 1024;

const TEAM_ID_RE = /^[A-Z0-9]{10}$/;
const KEY_ID_RE = /^[A-Z0-9]{10}$/;
const ISSUER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const P8_BEGIN = '-----BEGIN PRIVATE KEY-----';
const P8_END = '-----END PRIVATE KEY-----';

function validateField(
  stepId: AppleStepId,
  values: { teamId: string; issuerId: string; keyId: string; p8: string },
): string | null {
  switch (stepId) {
    case 'team-id': {
      const trimmed = values.teamId.trim();
      if (!trimmed) return 'Team ID is required.';
      if (!TEAM_ID_RE.test(trimmed)) {
        return 'Apple Team IDs are exactly 10 uppercase alphanumeric characters (e.g. ABCD123456).';
      }
      return null;
    }
    case 'create-key': {
      const p8 = values.p8.trim();
      if (!p8) return 'Upload the AuthKey_<KEYID>.p8 file you downloaded from App Store Connect.';
      if (!p8.startsWith(P8_BEGIN) || !p8.includes(P8_END)) {
        return 'Selected file is not a valid PEM-encoded private key. Re-download the .p8 from App Store Connect.';
      }
      return null;
    }
    case 'issuer-id': {
      const trimmed = values.issuerId.trim();
      if (!trimmed) return 'Issuer ID is required.';
      if (!ISSUER_ID_RE.test(trimmed)) {
        return 'Issuer IDs are UUIDs (e.g. 57246542-96fe-1a63-e053-0824d011072a).';
      }
      return null;
    }
    case 'key-id': {
      const trimmed = values.keyId.trim();
      if (!trimmed) return 'Key ID is required.';
      if (!KEY_ID_RE.test(trimmed)) {
        return 'Apple Key IDs are exactly 10 uppercase alphanumeric characters (e.g. ABCD123456).';
      }
      return null;
    }
    case 'review':
      return null;
  }
}

export function AppleIntegrationFlow({
  inline = false,
  isConnected,
  connectionDetails,
  onClose,
  onConnect,
  onDisconnect,
}: AppleIntegrationFlowProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [teamId, setTeamId] = useState('');
  const [issuerId, setIssuerId] = useState('');
  const [keyId, setKeyId] = useState('');
  const [keyIdAutoFilled, setKeyIdAutoFilled] = useState(false);
  const [p8, setP8] = useState('');
  const [p8Filename, setP8Filename] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  const currentStep = STEPS[stepIndex];
  const fieldError = useMemo(
    () => validateField(currentStep.id, { teamId, issuerId, keyId, p8 }),
    [currentStep.id, teamId, issuerId, keyId, p8],
  );

  const handleP8File = async (file: File): Promise<void> => {
    setUploadError(null);
    if (file.size === 0) {
      setUploadError('Selected file is empty.');
      return;
    }
    if (file.size > MAX_P8_BYTES) {
      setUploadError(`.p8 files are tiny (~250 bytes). Refusing ${file.size}-byte upload.`);
      return;
    }
    const text = await file.text();
    const trimmed = text.trim();
    if (!trimmed.startsWith(P8_BEGIN) || !trimmed.includes(P8_END)) {
      setUploadError(
        'File is not a PEM-encoded private key. Make sure you selected AuthKey_<KEYID>.p8 from your downloads.',
      );
      return;
    }
    setP8(trimmed);
    setP8Filename(file.name);
    const match = file.name.match(P8_FILENAME_RE);
    if (match && match[1]) {
      const extracted = match[1].toUpperCase();
      setKeyId(extracted);
      setKeyIdAutoFilled(true);
    } else {
      setKeyIdAutoFilled(false);
    }
  };

  const clearP8 = (): void => {
    setP8('');
    setP8Filename(null);
    setUploadError(null);
    if (keyIdAutoFilled) {
      setKeyId('');
      setKeyIdAutoFilled(false);
    }
  };

  const handleBack = () => {
    setServerError(null);
    setStepIndex((idx) => Math.max(0, idx - 1));
  };

  const handleNext = () => {
    if (fieldError) return;
    setServerError(null);
    setStepIndex((idx) => Math.min(STEPS.length - 1, idx + 1));
  };

  const handleSubmit = async () => {
    setServerError(null);
    setSubmitting(true);
    try {
      await onConnect({
        appleTeamId: teamId.trim(),
        ascIssuerId: issuerId.trim(),
        ascApiKeyId: keyId.trim(),
        ascApiKeyP8: p8.trim(),
      });
      setSubmitted(true);
      setTimeout(() => onClose(), 900);
    } catch (err) {
      setServerError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
      onClose();
    } finally {
      setDisconnecting(false);
    }
  };

  const cardContent = (
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 12 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className={inline
          ? 'bg-background border border-border rounded-2xl w-full overflow-hidden'
          : 'bg-background border border-border rounded-2xl shadow-2xl w-full max-w-2xl overflow-hidden'}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between p-6 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-zinc-500/10 flex items-center justify-center shrink-0">
              <ShieldCheck size={20} className="text-zinc-700 dark:text-zinc-300" />
            </div>
            <div>
              <h2 className="font-bold text-base tracking-tight">Apple Developer</h2>
              <p className="text-xs text-muted-foreground mt-0.5">
                {isConnected ? (
                  <span className="flex items-center gap-1 text-emerald-500 font-medium">
                    <CheckCircle2 size={11} />
                    <span>Connected</span>
                  </span>
                ) : (
                  <span>Five-step setup · automated provisioning only</span>
                )}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors text-muted-foreground"
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {isConnected && !submitted ? (
          <ConnectedSummary
            details={connectionDetails ?? null}
            disconnecting={disconnecting}
            onDisconnect={() => void handleDisconnect()}
            onClose={onClose}
          />
        ) : (
          <>
            <Stepper steps={STEPS} currentIndex={stepIndex} />

            <div className="p-6 space-y-5 max-h-[55vh] overflow-y-auto">
              <AnimatePresence mode="wait">
                <motion.div
                  key={currentStep.id}
                  initial={{ opacity: 0, x: 12 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -12 }}
                  transition={{ duration: 0.18 }}
                  className="space-y-4"
                >
                  <StepBody
                    step={currentStep}
                    teamId={teamId}
                    setTeamId={setTeamId}
                    issuerId={issuerId}
                    setIssuerId={setIssuerId}
                    keyId={keyId}
                    setKeyId={(v) => {
                      setKeyId(v);
                      setKeyIdAutoFilled(false);
                    }}
                    keyIdAutoFilled={keyIdAutoFilled}
                    p8={p8}
                    p8Filename={p8Filename}
                    uploadError={uploadError}
                    onUploadP8={handleP8File}
                    onClearP8={clearP8}
                  />

                  {fieldError && currentStep.id !== 'review' && (
                    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
                      <AlertCircle size={13} className="shrink-0 mt-0.5" />
                      <span>{fieldError}</span>
                    </div>
                  )}
                  {serverError && (
                    <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                      <AlertCircle size={13} className="shrink-0 mt-0.5" />
                      <span>{serverError}</span>
                    </div>
                  )}
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="flex items-center justify-between gap-3 p-5 border-t border-border bg-muted/20">
              <button
                type="button"
                onClick={handleBack}
                disabled={stepIndex === 0 || submitting}
                className="inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg border border-border hover:bg-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ArrowLeft size={13} />
                <span>Back</span>
              </button>
              <span className="text-[11px] text-muted-foreground">
                Step {stepIndex + 1} of {STEPS.length}
              </span>
              {currentStep.id === 'review' ? (
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={submitting || submitted}
                  className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {submitted ? (
                    <>
                      <CheckCircle2 size={14} />
                      <span>Connected</span>
                    </>
                  ) : submitting ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      <span>Storing in vault…</span>
                    </>
                  ) : (
                    <>
                      <Link2 size={14} />
                      <span>Connect Apple</span>
                      <ArrowRight size={13} />
                    </>
                  )}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleNext}
                  disabled={Boolean(fieldError)}
                  className="inline-flex items-center gap-2 bg-foreground text-background px-5 py-2.5 rounded-lg text-sm font-bold hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <span>Continue</span>
                  <ArrowRight size={13} />
                </button>
              )}
            </div>
          </>
        )}
      </motion.div>
  );

  if (inline) return cardContent;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/55" onClick={onClose}>
      {cardContent}
    </div>
  );
}

function Stepper({ steps, currentIndex }: { steps: AppleStep[]; currentIndex: number }) {
  return (
    <div className="px-6 pt-4 pb-3 border-b border-border bg-muted/20">
      <ol className="flex items-center gap-2">
        {steps.map((step, idx) => {
          const isCurrent = idx === currentIndex;
          const isComplete = idx < currentIndex;
          return (
            <li key={step.id} className="flex-1 flex items-center gap-2 min-w-0">
              <div
                className={`flex items-center justify-center w-6 h-6 rounded-full border text-[10px] font-bold transition-colors ${
                  isComplete
                    ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-600 dark:text-emerald-400'
                    : isCurrent
                      ? 'bg-primary/10 border-primary/40 text-primary'
                      : 'bg-background border-border text-muted-foreground'
                }`}
              >
                {isComplete ? <CheckCircle2 size={12} /> : idx + 1}
              </div>
              <div className="min-w-0 hidden md:block">
                <p
                  className={`text-[11px] font-semibold leading-tight truncate ${
                    isCurrent ? 'text-foreground' : 'text-muted-foreground'
                  }`}
                >
                  {step.title}
                </p>
              </div>
              {idx < steps.length - 1 && (
                <div
                  className={`flex-1 h-px ${isComplete ? 'bg-emerald-500/40' : 'bg-border'}`}
                />
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

interface StepBodyProps {
  step: AppleStep;
  teamId: string;
  setTeamId: (v: string) => void;
  issuerId: string;
  setIssuerId: (v: string) => void;
  keyId: string;
  setKeyId: (v: string) => void;
  keyIdAutoFilled: boolean;
  p8: string;
  p8Filename: string | null;
  uploadError: string | null;
  onUploadP8: (file: File) => Promise<void>;
  onClearP8: () => void;
}

function StepBody(props: StepBodyProps) {
  switch (props.step.id) {
    case 'team-id':
      return (
        <StepShell
          step={props.step}
          link={{
            label: 'Open Apple Developer membership page',
            href: 'https://developer.apple.com/account#MembershipDetailsCard',
          }}
          instructions={[
            'Sign in at developer.apple.com with the Apple ID enrolled in your Apple Developer Program.',
            'Open Membership details (left sidebar).',
            'Copy the 10-character Team ID listed under your team name.',
          ]}
        >
          <Input
            label="Apple Team ID"
            value={props.teamId}
            onChange={(v) => props.setTeamId(v.toUpperCase())}
            placeholder="ABC123DEF4"
            mono
          />
        </StepShell>
      );
    case 'create-key':
      return (
        <StepShell
          step={props.step}
          link={{
            label: 'Open App Store Connect → Integrations → Team Keys',
            href: 'https://appstoreconnect.apple.com/access/integrations/api',
          }}
          instructions={[
            'In App Store Connect, open Users and Access → Integrations → App Store Connect API.',
            'Stay on the Team Keys tab — do not use Individual Keys; the credential must outlive any single user.',
            'Click + to create a new key. Name it studio-provisioner (or similar) and assign the Admin role for full provisioning automation (or App Manager for the minimum scope).',
            'Click Generate, then Download API Key. Apple offers the .p8 file ONCE — save it now.',
            'Drop the AuthKey_<KEYID>.p8 file in the box below. Studio reads it locally; nothing is uploaded over the network until you click Connect.',
          ]}
          warning="If you lost the .p8 from a previous run, revoke that Team key in App Store Connect and generate a fresh one."
        >
          <P8Dropzone
            p8={props.p8}
            filename={props.p8Filename}
            uploadError={props.uploadError}
            onFile={props.onUploadP8}
            onClear={props.onClearP8}
          />
        </StepShell>
      );
    case 'issuer-id':
      return (
        <StepShell
          step={props.step}
          link={{
            label: 'Open Team Keys tab',
            href: 'https://appstoreconnect.apple.com/access/integrations/api',
          }}
          instructions={[
            'In the Team Keys tab, locate Issuer ID at the top of the table — it applies to every key in the team.',
            'Click the copy icon next to the Issuer ID and paste it below.',
          ]}
        >
          <Input
            label="Issuer ID (UUID)"
            value={props.issuerId}
            onChange={props.setIssuerId}
            placeholder="57246542-96fe-1a63-e053-0824d011072a"
            mono
          />
        </StepShell>
      );
    case 'key-id':
      return (
        <StepShell
          step={props.step}
          link={
            props.keyIdAutoFilled
              ? undefined
              : {
                  label: 'Open Team Keys tab',
                  href: 'https://appstoreconnect.apple.com/access/integrations/api',
                }
          }
          instructions={
            props.keyIdAutoFilled
              ? [
                  `Studio extracted the Key ID from the uploaded filename (${props.p8Filename ?? 'AuthKey_<KEYID>.p8'}).`,
                  'Confirm it matches the Key ID column in App Store Connect, or edit it if you renamed the file.',
                ]
              : [
                  'Studio could not auto-detect a Key ID from the uploaded filename — looks like the .p8 was renamed.',
                  'Open the Team Keys table and copy the 10-character Key ID column value.',
                ]
          }
        >
          <Input
            label={props.keyIdAutoFilled ? 'Key ID (auto-detected)' : 'Key ID'}
            value={props.keyId}
            onChange={(v) => props.setKeyId(v.toUpperCase())}
            placeholder="ABCD1234EF"
            mono
            badge={props.keyIdAutoFilled ? 'Auto-filled from filename' : undefined}
          />
        </StepShell>
      );
    case 'review':
      return (
        <ReviewStep
          teamId={props.teamId}
          issuerId={props.issuerId}
          keyId={props.keyId}
          p8Filename={props.p8Filename}
          p8={props.p8}
        />
      );
  }
}

function P8Dropzone({
  p8,
  filename,
  uploadError,
  onFile,
  onClear,
}: {
  p8: string;
  filename: string | null;
  uploadError: string | null;
  onFile: (file: File) => Promise<void>;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [reveal, setReveal] = useState(false);

  const handleFiles = (files: FileList | null) => {
    const file = files?.[0];
    if (!file) return;
    void onFile(file);
  };

  if (p8) {
    return (
      <div className="space-y-2">
        <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-3 flex items-center gap-3">
          <FileCheck2 size={18} className="text-emerald-500 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-foreground truncate">{filename ?? 'private-key.p8'}</p>
            <p className="text-[10px] text-muted-foreground">
              {p8.length.toLocaleString()} characters · validated PEM · stored locally only
            </p>
          </div>
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {reveal ? <EyeOff size={12} /> : <Eye size={12} />}
            <span>{reveal ? 'Hide' : 'Show'}</span>
          </button>
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 text-[11px] text-red-500 hover:text-red-400 transition-colors"
          >
            <Trash2 size={12} />
            <span>Replace</span>
          </button>
        </div>
        {reveal && (
          <pre className="max-h-40 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-[10px] font-mono leading-relaxed text-foreground whitespace-pre-wrap break-all">
            {p8}
          </pre>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={`w-full rounded-lg border-2 border-dashed px-4 py-6 text-left transition-colors ${
          dragOver
            ? 'border-primary bg-primary/5'
            : 'border-border hover:border-primary/40 hover:bg-muted/30'
        }`}
      >
        <div className="flex items-center gap-3">
          <Upload size={20} className="text-muted-foreground shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-bold text-foreground">Drop AuthKey_&lt;KEYID&gt;.p8 here</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              or click to browse · file is read in-browser, never uploaded until you click Connect
            </p>
          </div>
        </div>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".p8,application/x-pem-file,text/plain"
        className="sr-only"
        onChange={(e) => handleFiles(e.target.files)}
      />
      {uploadError && (
        <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400">
          <AlertCircle size={12} className="shrink-0 mt-0.5" />
          <span>{uploadError}</span>
        </div>
      )}
    </div>
  );
}

function StepShell({
  step,
  instructions,
  link,
  warning,
  children,
}: {
  step: AppleStep;
  instructions: string[];
  link?: { label: string; href: string };
  warning?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{step.subtitle}</p>
        <h3 className="text-base font-bold tracking-tight mt-0.5">{step.title}</h3>
      </div>
      <ol className="space-y-1.5 list-decimal list-inside text-xs text-muted-foreground leading-relaxed">
        {instructions.map((instruction, idx) => (
          <li key={idx}>{instruction}</li>
        ))}
      </ol>
      {warning && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
          <Info size={12} className="shrink-0 mt-0.5" />
          <span>{warning}</span>
        </div>
      )}
      {link && (
        <a
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:underline"
        >
          <ExternalLink size={12} />
          <span>{link.label}</span>
        </a>
      )}
      {children}
    </div>
  );
}

function Input({
  label,
  value,
  onChange,
  placeholder,
  mono,
  badge,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  badge?: string;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <label className="text-xs font-semibold text-foreground">{label}</label>
        {badge && (
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-600 dark:text-emerald-400 bg-emerald-500/10">
            {badge}
          </span>
        )}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        className={`w-full px-3 py-2.5 rounded-lg border border-border bg-background text-[12px] focus:ring-2 focus:ring-primary/20 focus:border-primary outline-none transition-all ${
          mono ? 'font-mono' : ''
        }`}
      />
    </div>
  );
}

function ReviewStep({
  teamId,
  issuerId,
  keyId,
  p8Filename,
  p8,
}: {
  teamId: string;
  issuerId: string;
  keyId: string;
  p8Filename: string | null;
  p8: string;
}) {
  const summary: Array<{ label: string; value: string; mask?: boolean }> = [
    { label: 'Apple Team ID', value: teamId.trim() },
    { label: 'Issuer ID', value: issuerId.trim() },
    { label: 'Key ID', value: keyId.trim() },
    {
      label: 'Private key file',
      value: p8Filename
        ? `${p8Filename} · ${p8.trim().length.toLocaleString()} chars`
        : `${p8.trim().length.toLocaleString()} characters captured`,
      mask: true,
    },
  ];
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">Final check</p>
        <h3 className="text-base font-bold tracking-tight mt-0.5">Review and connect</h3>
        <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
          Studio will store the Issuer ID, Key ID, and encrypted .p8 in the local vault under
          <span className="font-mono text-foreground"> apple/asc_*</span> so every project can drive Apple
          Developer and App Store Connect automation without prompting again.
        </p>
      </div>
      <div className="rounded-xl border border-border bg-muted/30 divide-y divide-border">
        {summary.map((row) => (
          <div key={row.label} className="flex items-center justify-between gap-3 px-4 py-2.5">
            <span className="text-xs text-muted-foreground">{row.label}</span>
            <span
              className={`text-xs font-mono text-foreground truncate text-right ${
                row.mask ? 'tracking-wider' : ''
              }`}
            >
              {row.value || '—'}
            </span>
          </div>
        ))}
      </div>
      <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-700 dark:text-emerald-300">
        <KeyRound size={13} className="shrink-0 mt-0.5" />
        <span>
          On connect, the integration is marked <strong>Configured</strong> at organization scope and the Apple
          provider can immediately register App IDs, profiles, APNs keys, and TestFlight builds.
        </span>
      </div>
    </div>
  );
}

function ConnectedSummary({
  details,
  disconnecting,
  onDisconnect,
  onClose,
}: {
  details: { team_id?: string; asc_issuer_id?: string; asc_api_key_id?: string } | null;
  disconnecting: boolean;
  onDisconnect: () => void;
  onClose: () => void;
}) {
  return (
    <div className="p-6 space-y-5">
      <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-center gap-3">
        <CheckCircle2 size={18} className="text-emerald-500 shrink-0" />
        <div>
          <p className="text-sm font-bold text-emerald-600 dark:text-emerald-400">Apple integration active</p>
          <p className="text-[11px] text-emerald-600/80 dark:text-emerald-400/80 mt-0.5">
            Team ID + App Store Connect Team Key are stored. All projects can run the automated Apple flow.
          </p>
        </div>
      </div>
      <div className="rounded-xl border border-border bg-muted/30 divide-y divide-border">
        <SummaryRow label="Team ID" value={details?.team_id} />
        <SummaryRow label="Issuer ID" value={details?.asc_issuer_id} />
        <SummaryRow label="Key ID" value={details?.asc_api_key_id} />
        <SummaryRow label=".p8 storage" value="Encrypted vault · apple/asc_api_key_p8" />
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onDisconnect}
          disabled={disconnecting}
          className="inline-flex items-center gap-1.5 text-xs font-bold text-red-500 hover:text-red-400 px-3 py-2 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-50"
        >
          {disconnecting ? <Loader2 size={13} className="animate-spin" /> : <Unlink size={13} />}
          <span>Disconnect Apple</span>
        </button>
        <button
          type="button"
          onClick={onClose}
          className="text-xs font-bold px-4 py-2 border border-border rounded-lg hover:bg-accent transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="flex items-center justify-between gap-3 px-4 py-2.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-mono text-foreground truncate text-right">{value || '—'}</span>
    </div>
  );
}
