import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import type { ComponentProps, Dispatch, SetStateAction } from 'react';
import { TONES } from '@/components/shared/statusTone';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { verdictOf } from './complianceView';
import FindingRow from './FindingRow';
import { resolveSummary, type applyResolvePlan } from './resolveApply';
import type { Finding } from './compliance.types';

// The pieces of ComplianceStage: the status line, the verdict card and the quiet notes.

// The verdict's ink, per tone. `none` is the one the count alone could never
// express: nothing was checked, so nothing can be said to be clean.
const VERDICT_INK: Record<string, string> = { clear: 'var(--kind-playbook)', none: 'var(--warning-ink)', attention: 'var(--type-ai)', tidy: 'var(--type-ai)' };

interface ComplianceStatusProps {
    t: TranslateFn;
    failed: boolean;
    running: boolean;
    error: string | null | undefined;
    frameworks: string[];
}

/** The stage header's status: failed (with why), reading, or the frameworks it was read against. */
export function ComplianceStatus({ t, failed, running, error, frameworks }: ComplianceStatusProps) {
    return (
        <>
            {failed && <AlertTriangle className="w-4 h-4 shrink-0" aria-hidden="true" />}
            {running && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {failed
                ? (error || t('playbooks.compliance.failed', 'The review did not run — try it again.'))
                : running
                    ? t('playbooks.compliance.running', 'Reading the table, the automations and the app…')
                    : frameworks.length
                        ? t('playbooks.compliance.against', 'Against: {list}', { list: frameworks.join(', ') })
                        : t('playbooks.compliance.none_active', 'No framework is switched on in the Compliance Center, so there was nothing to check against.')}
        </>
    );
}

interface VerdictCardProps {
    t: TranslateFn;
    presenter: boolean;
    verdict: ReturnType<typeof verdictOf>;
    method: string | null;
    lastRecheck: { was: number; now: number } | null;
    applied: { code: string; out: Awaited<ReturnType<typeof applyResolvePlan>> } | null;
    modelFailed: boolean;
    rechecking: boolean;
    onRecheck: () => void;
}

/** The verdict — what was checked, and what came back clean — with Check again. */
export function VerdictCard({ t, presenter, verdict, method, lastRecheck, applied, modelFailed, rechecking, onRecheck }: VerdictCardProps) {
    return (
        <section
            className="rounded-2xl"
            style={{
                background: 'var(--bg-card)',
                border: `1px solid ${verdict.tone === 'clear' ? 'var(--kind-playbook)' : verdict.tone === 'none' ? TONES.warning.raw : 'var(--border-default)'}`,
                boxShadow: 'var(--shadow-md)',
                padding: presenter ? 28 : 20,
            }}
            data-testid="playbook-compliance-verdict"
            data-tone={verdict.tone}
        >
            <div className="flex items-start gap-3">
                <VerdictIcon tone={verdict.tone} presenter={presenter} />
                <VerdictLines t={t} presenter={presenter} verdict={verdict} method={method} lastRecheck={lastRecheck} applied={applied} modelFailed={modelFailed} />
                <button
                    type="button"
                    onClick={onRecheck}
                    disabled={rechecking}
                    className="shrink-0 inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg text-[11px] font-medium disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [color:var(--text-secondary)]! [border:1px_solid_var(--border-default)] [outline-color:var(--accent-primary)]!"
                    data-testid="playbook-compliance-recheck"
                >
                    {rechecking
                        ? <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                        : <RefreshCw className="w-3 h-3" aria-hidden="true" />}
                    {t('playbooks.compliance.recheck', 'Check again')}
                </button>
            </div>
        </section>
    );
}

interface QuietNotesProps {
    t: TranslateFn;
    low: Finding[];
    showLow: boolean;
    setShowLow: Dispatch<SetStateAction<boolean>>;
    rowProps: (f: Finding) => ComponentProps<typeof FindingRow>;
}

/** The quiet ones, behind a count — they are notes, not problems. */
export function QuietNotes({ t, low, showLow, setShowLow, rowProps }: QuietNotesProps) {
    return (
        <div>
            <button
                type="button"
                onClick={() => setShowLow((v) => !v)}
                className="inline-flex items-center gap-1.5 text-[11px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 [color:var(--text-secondary)]! [outline-color:var(--accent-primary)]!"
                aria-expanded={showLow}
                data-testid="playbook-compliance-notes-toggle"
            >
                <ChevronDown className={`w-3 h-3 transition-transform motion-reduce:transition-none ${showLow ? '[transform:rotate(0deg)]' : '[transform:rotate(-90deg)]'}`} aria-hidden="true" />
                {low.length === 1
                    ? t('playbooks.compliance.notes_one', '1 note, good to know')
                    : t('playbooks.compliance.notes', '{n} notes, good to know', { n: low.length })}
            </button>
            {showLow && (
                <ul className="mt-2 space-y-2" data-testid="playbook-compliance-notes">
                    {low.map((f) => <FindingRow key={f.code} {...rowProps(f)} />)}
                </ul>
            )}
        </div>
    );
}

/** The verdict's tile: a tick when clear, a warning when nothing was checked, a shield otherwise. */
function VerdictIcon({ tone, presenter }: { tone: string; presenter: boolean }) {
    return (
        <span className="inline-flex items-center justify-center shrink-0 rounded-xl" style={{ width: presenter ? 44 : 36, height: presenter ? 44 : 36, background: `color-mix(in srgb, ${VERDICT_INK[tone] || 'var(--type-ai)'} 12%, transparent)`, color: VERDICT_INK[tone] || 'var(--type-ai)' }}>
            {tone === 'clear'
                ? <CheckCircle2 className="w-5 h-5" aria-hidden="true" />
                : tone === 'none'
                    ? <AlertTriangle className="w-5 h-5" aria-hidden="true" />
                    : <ShieldCheck className="w-5 h-5" aria-hidden="true" />}
        </span>
    );
}

type VerdictLinesProps = Pick<VerdictCardProps, 't' | 'presenter' | 'verdict' | 'method' | 'lastRecheck' | 'applied' | 'modelFailed'>;

/** The headline, the clean count, how it was read, the change since the last check, what a fix did, and the model note. */
function VerdictLines({ t, presenter, verdict, method, lastRecheck, applied, modelFailed }: VerdictLinesProps) {
    return (
        <div className="min-w-0 flex-1">
            <p className={`font-semibold [color:var(--text-primary)] ${presenter ? '[font-size:20px]' : '[font-size:16px]'}`} role="status" aria-live="polite" data-testid="playbook-compliance-headline">
                {verdict.headline}
            </p>
            {verdict.cleanLine && (
                <p className={`mt-0.5 flex items-center gap-1.5 [color:var(--text-secondary)] ${presenter ? '[font-size:14px]' : '[font-size:12px]'}`} data-testid="playbook-compliance-clean-count">
                    <CheckCircle2 className="w-3.5 h-3.5 shrink-0 [color:var(--kind-playbook)]" aria-hidden="true" />
                    {verdict.cleanLine}
                </p>
            )}
            {method && <p className={`mt-0.5 [color:var(--text-tertiary)] ${presenter ? '[font-size:13px]' : '[font-size:11px]'}`} data-testid="playbook-compliance-method">{method}</p>}
            {lastRecheck && lastRecheck.was > lastRecheck.now && (
                <p className="mt-1 font-medium" style={{ fontSize: presenter ? 14 : 12, color: TONES.success.ink }} data-testid="playbook-compliance-delta">
                    {t('playbooks.compliance.delta', '{n} fewer than a moment ago.', { n: lastRecheck.was - lastRecheck.now })}
                </p>
            )}
            {applied && (
                <p className="mt-1" style={{ fontSize: presenter ? 13 : 11, color: applied.out.failed.length ? TONES.warning.ink : 'var(--text-secondary)' }} data-testid="playbook-compliance-applied">
                    {resolveSummary(applied.out, t)}
                </p>
            )}
            {modelFailed && (
                <p className="mt-1 [font-size:11px] [color:var(--text-tertiary)]" data-testid="playbook-compliance-model-note">
                    {t('playbooks.compliance.model_note', 'The AI reviewer could not be reached — what you see is what the rules alone found.')}
                </p>
            )}
        </div>
    );
}
