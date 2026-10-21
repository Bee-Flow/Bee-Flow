import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { Change, StepCompare, StepVerdict } from '../../../../api/queries/automation/runChecks';
import RunCompareFiles from './RunCompareFiles';
import { notComparableHint, softChipText, stepVerdictText } from './runCompareText';

const BADGE: Record<StepVerdict, string> = {
    same: 'text-[var(--text-tertiary)] bg-[var(--bg-tertiary)]',
    soft: 'text-[var(--warning)] bg-[var(--bg-tertiary)]',
    changed: 'text-[var(--error)] bg-[var(--bg-tertiary)]',
    status_changed: 'text-[var(--error)] bg-[var(--bg-tertiary)]',
    only_a: 'text-[var(--error)] bg-[var(--bg-tertiary)]',
    only_b: 'text-[var(--error)] bg-[var(--bg-tertiary)]',
    not_comparable: 'text-[var(--text-secondary)] bg-[var(--bg-tertiary)]',
};

const CELL = 'px-2 py-1 align-top font-mono break-all';

/** Path, was, becomes: the generic list every kind of change falls back to. */
function ChangesTable({ changes, truncated }: { changes: Change[]; truncated: boolean }) {
    const { t } = useTranslation();
    const dash = <span className="text-[var(--text-tertiary)]">-</span>;
    return (
        <div>
            <table className="w-full text-left border border-[var(--border-default)] rounded-md">
                <caption className="sr-only">{t('automation_run_checks.changes.caption', 'What changed in this step')}</caption>
                <thead className="bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    <tr>
                        <th scope="col" className="px-2 py-1 font-medium">{t('automation_run_checks.changes.path', 'Field')}</th>
                        <th scope="col" className="px-2 py-1 font-medium">{t('automation_run_checks.changes.was', 'Was (run A)')}</th>
                        <th scope="col" className="px-2 py-1 font-medium">{t('automation_run_checks.changes.becomes', 'Becomes (run B)')}</th>
                    </tr>
                </thead>
                <tbody>
                    {changes.map((c, i) => (
                        <tr key={`${c.path}-${i}`} className="border-t border-[var(--border-default)]">
                            <td className={`${CELL} text-[var(--text-primary)]`}>
                                {c.path || t('automation_run_checks.changes.whole', '(whole result)')}
                            </td>
                            <td className={`${CELL} text-[var(--text-secondary)]`}>{c.before ?? dash}</td>
                            <td className={`${CELL} text-[var(--text-primary)]`}>{c.after ?? dash}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {truncated && (
                <p className="mt-1 text-[var(--text-tertiary)]">{t('automation_run_checks.changes.truncated', 'More changes not shown.')}</p>
            )}
        </div>
    );
}

interface RunCompareStepProps {
    step: StepCompare;
    /** The step as the person knows it. */
    label: string;
    defaultOpen?: boolean;
}

/** Does opening the row show anything? */
function hasDetail(step: StepCompare): boolean {
    return step.changes.length > 0 || step.files.length > 0
        || step.verdict === 'status_changed' || step.verdict === 'not_comparable';
}

/** What an opened row shows: why it cannot be compared, the changes, the files. */
function StepDetail({ step }: { step: StepCompare }) {
    const { t } = useTranslation();
    return (
        <div className="px-3 pb-3 flex flex-col gap-2">
            {step.verdict === 'status_changed' && (
                <p className="text-[var(--text-secondary)]">
                    {t('automation_run_checks.step.status_line', 'Run A: {a}. Run B: {b}.', { a: step.a.status ?? '-', b: step.b.status ?? '-' })}
                </p>
            )}
            {step.verdict === 'not_comparable' && <p className="text-[var(--text-secondary)]">{notComparableHint(t)}</p>}
            {step.changes.length > 0 && <ChangesTable changes={step.changes} truncated={step.changesTruncated} />}
            <RunCompareFiles files={step.files} />
        </div>
    );
}

/** One step of the compare: its verdict on a row, the details when opened. */
export default function RunCompareStep({ step, label, defaultOpen = false }: RunCompareStepProps) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(defaultOpen);
    const chip = step.verdict === 'soft' ? softChipText(t, step.softReason) : null;
    const detail = hasDetail(step);
    const Chevron = open ? ChevronDown : ChevronRight;
    return (
        <li className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)]">
            <button
                type="button"
                aria-expanded={open}
                disabled={!detail}
                onClick={() => setOpen(o => !o)}
                className="w-full flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-left disabled:cursor-default"
            >
                <Chevron size={14} aria-hidden className={`shrink-0 ${detail ? 'text-[var(--text-secondary)]' : 'opacity-0'}`} />
                <span className="font-medium text-[var(--text-primary)]">{label}</span>
                <span className={`px-1.5 py-0.5 rounded-md font-medium ${BADGE[step.verdict]}`}>{stepVerdictText(t, step.verdict)}</span>
                {chip && <span className="px-1.5 py-0.5 rounded-md border border-[var(--border-default)] text-[var(--text-secondary)]">{chip}</span>}
            </button>
            {open && detail && <StepDetail step={step} />}
        </li>
    );
}
