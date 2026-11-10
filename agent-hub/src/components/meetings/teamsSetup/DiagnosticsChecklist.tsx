import { AlertTriangle, CheckCircle2, HelpCircle, MinusCircle, XCircle } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { checkTitle, codeText, fixText, fixerText, overallText, statusText } from './checkText';
import type { CheckStatus, TeamsCheck, TeamsDiagnosticsReport } from './types';

/** Icon and ink per status; the label beside it says the same in words. */
const STATUS_LOOK: Record<CheckStatus, { Icon: typeof CheckCircle2; ink: string }> = {
    pass: { Icon: CheckCircle2, ink: 'text-[var(--success-ink)]' },
    fail: { Icon: XCircle, ink: 'text-[var(--error-ink)]' },
    warn: { Icon: AlertTriangle, ink: 'text-[var(--warning-ink)]' },
    unknown: { Icon: HelpCircle, ink: 'text-[var(--text-muted)]' },
    skipped: { Icon: MinusCircle, ink: 'text-[var(--text-muted)]' },
};

const lookOf = (status: string) => STATUS_LOOK[status as CheckStatus] ?? STATUS_LOOK.unknown;

const OVERALL_BOX: Record<TeamsDiagnosticsReport['overall'], string> = {
    pass: 'border-[var(--success)] bg-[color-mix(in_srgb,var(--success)_8%,var(--bg-secondary))] text-[var(--success-ink)]',
    warn: 'border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,var(--bg-secondary))] text-[var(--warning-ink)]',
    fail: 'border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_8%,var(--bg-secondary))] text-[var(--error-ink)]',
};

function CheckRow({ check }: { check: TeamsCheck }) {
    const { t } = useTranslation();
    const { Icon, ink } = lookOf(check.status);
    const fix = fixText(t, check.remediation);
    const who = fixerText(t, check.fixer);
    return (
        <li className="flex gap-3 px-4 py-3 bg-[var(--bg-secondary)]" data-check-id={check.id} data-status={check.status}>
            <Icon className={`w-4 h-4 mt-0.5 flex-shrink-0 ${ink}`} aria-hidden="true" />
            <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium text-[var(--text-primary)]">
                    {checkTitle(t, check.id)}
                    <span className={`ml-2 text-[11px] font-semibold ${ink}`}>{statusText(t, check.status)}</span>
                </p>
                <p className="text-[12px] text-[var(--text-secondary)]">{codeText(t, check.code, check.params)}</p>
                {fix && <p className="mt-1 text-[12px] text-[var(--text-primary)]">{fix}</p>}
                {who && (
                    <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
                        <span className="font-medium">{t('teams_setup.ui.who_fixes')}:</span> {who}
                    </p>
                )}
            </div>
        </li>
    );
}

interface DiagnosticsChecklistProps {
    checks: TeamsCheck[];
    /** The report's verdict; left out for a list of checks without one (the org checks). */
    overall?: TeamsDiagnosticsReport['overall'];
    /** ISO time the report ran. */
    ranAt?: string;
}

/**
 * A diagnostics report as a checklist, top to bottom in catalogue order: per check its
 * status, title, result sentence, what to do and who can do it. Checks skipped because an
 * earlier one failed are folded away under one line, so the first real problem stands out.
 */
export default function DiagnosticsChecklist({ checks, overall, ranAt }: DiagnosticsChecklistProps) {
    const { t } = useTranslation();
    const shown = checks.filter((c) => c.status !== 'skipped');
    const skipped = checks.filter((c) => c.status === 'skipped');
    const ranAtMs = ranAt ? Date.parse(ranAt) : NaN;
    return (
        <div className="flex flex-col gap-2">
            {overall && (
                <p role="status" className={`px-4 py-2.5 rounded-xl border text-[13px] font-medium ${OVERALL_BOX[overall] ?? OVERALL_BOX.fail}`}>
                    {overallText(t, overall)}
                </p>
            )}
            {shown.length > 0 && (
                <ul className="rounded-xl overflow-hidden border border-[var(--border-subtle)] divide-y divide-[var(--border-subtle)]">
                    {shown.map((check) => <CheckRow key={check.id} check={check} />)}
                </ul>
            )}
            {skipped.length > 0 && (
                <details className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                    <summary className="cursor-pointer px-4 py-2.5 text-[12px] text-[var(--text-muted)]">
                        {statusText(t, 'skipped')} ({skipped.length})
                    </summary>
                    <ul className="divide-y divide-[var(--border-subtle)] border-t border-[var(--border-subtle)]">
                        {skipped.map((check) => <CheckRow key={check.id} check={check} />)}
                    </ul>
                </details>
            )}
            {Number.isFinite(ranAtMs) && (
                <p className="text-[11px] text-[var(--text-muted)]">{t('teams_setup.ui.ran_at', { time: new Date(ranAtMs).toLocaleString() })}</p>
            )}
        </div>
    );
}
