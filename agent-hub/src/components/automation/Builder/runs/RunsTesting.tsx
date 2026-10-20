import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { GoldenItem } from '../../../../api/queries/automation/runChecks';
import FormScenariosPanel from './FormScenariosPanel';
import GoldensPanel from './GoldensPanel';

export type RunsSection = 'runs' | 'testing';

/** "Runs | Testing" above the left column of the Runs tab. */
export function RunsSectionTabs({ value, onChange }: { value: RunsSection; onChange: (v: RunsSection) => void }) {
    const { t } = useTranslation();
    const items: Array<{ value: RunsSection; label: string }> = [
        { value: 'runs', label: t('automation_run_checks.tabs.runs', 'Runs') },
        { value: 'testing', label: t('automation_run_checks.tabs.testing', 'Testing') },
    ];
    return (
        <div role="tablist" aria-label={t('automation_run_checks.tabs.label', 'What to show')} className="flex gap-1 px-4 pt-3 text-xs font-medium">
            {items.map(i => (
                <button
                    key={i.value}
                    type="button"
                    role="tab"
                    aria-selected={value === i.value}
                    onClick={() => onChange(i.value)}
                    className={`px-2.5 py-1 rounded-md ${value === i.value ? 'bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                >
                    {i.label}
                </button>
            ))}
        </div>
    );
}

interface RunsTestingProps {
    automationId: string;
    active: boolean;
    onCompareGolden: (golden: GoldenItem) => void;
    onOpenRun: (runId: string) => void;
}

/** The Testing section: golden runs and form scenarios, one under the other. */
export default function RunsTesting({ automationId, active, onCompareGolden, onOpenRun }: RunsTestingProps) {
    return (
        <div className="flex-1 min-h-0 overflow-y-auto divide-y divide-[var(--border-default)]">
            <GoldensPanel automationId={automationId} active={active} onCompare={onCompareGolden} onOpenRun={onOpenRun} />
            <FormScenariosPanel automationId={automationId} active={active} onOpenRun={onOpenRun} />
        </div>
    );
}
