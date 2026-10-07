// The confirm step of a check's automatic fix, inside the check's expansion:
// what the fix does, the agents it touches, then "Apply fix" or "Cancel".
// Nothing is changed until Apply; the expansion's Auto-fix button only opens
// this block (it used to call the fix directly while the row's button asked).

import { Wrench } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';

interface AffectedItem { id?: string; name?: string }

export interface AutoFixCheck {
    evidence?: { missing_disclosure?: AffectedItem[] } | null;
}

const SECONDARY_BTN = 'inline-flex items-center gap-1 h-7 px-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[11px] font-medium text-[var(--text-primary)] whitespace-nowrap hover:bg-[var(--bg-secondary)] disabled:opacity-60 disabled:cursor-not-allowed';

export default function AutoFixConfirm({ check, busy = false, onConfirm, onCancel, testId }: {
    check: AutoFixCheck;
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
    testId?: string;
}) {
    const { t } = useTranslation();
    const affected = Array.isArray(check.evidence?.missing_disclosure) ? check.evidence.missing_disclosure : [];
    const title = t('compliance.auto_fix_confirm_title', 'Apply the automatic fix?');
    // The Auto-fix button that opened this block is disabled while it is open,
    // so keyboard focus moves here instead of falling to <body>.
    const applyRef = useRef<HTMLButtonElement>(null);
    useEffect(() => { applyRef.current?.focus(); }, []);
    return (
        <div
            className="flex flex-col gap-2 p-2.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)]"
            role="group"
            aria-label={title}
            data-testid={testId}
        >
            <div className="text-[12px] font-semibold text-[var(--text-primary)]">{title}</div>
            <div className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
                {t('compliance.auto_fix_confirm_desc', 'This applies the automated remediation for this check to every affected item below. The change is recorded in the evidence log and you can adjust the result afterwards.')}
            </div>
            {affected.length > 0 ? (
                <div>
                    <div className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">{t('compliance.auto_fix_affected', 'Affected agents')}</div>
                    <ul className="m-0 pl-4 text-[11px] text-[var(--text-secondary)] list-disc">
                        {affected.map((a, i) => <li key={a.id || a.name || i}>{a.name || a.id}</li>)}
                    </ul>
                </div>
            ) : null}
            <div className="flex items-center gap-2">
                <button
                    ref={applyRef}
                    type="button"
                    onClick={onConfirm}
                    disabled={busy}
                    data-testid={testId ? `${testId}-apply` : undefined}
                    className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-[8px] text-[11px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-60"
                >
                    <Wrench size={12} aria-hidden="true" className={busy ? 'animate-spin' : ''} />
                    {busy ? t('compliance.auto_fixing', 'Applying fix...') : t('compliance.auto_fix_apply', 'Apply fix')}
                </button>
                <button type="button" onClick={onCancel} disabled={busy} className={SECONDARY_BTN} data-testid={testId ? `${testId}-cancel` : undefined}>
                    {t('compliance.auto_fix_cancel', 'Cancel')}
                </button>
            </div>
        </div>
    );
}
