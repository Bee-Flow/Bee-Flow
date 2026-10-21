import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { GoldenItem } from '../../../../api/queries/automation/runChecks';
import RunsTesting, { RunsSectionTabs } from './RunsTesting';
import type { RunsSection } from './RunsTesting';

interface RunsLeftColumnProps {
    automationId: string;
    active: boolean;
    section: RunsSection;
    onSection: (v: RunsSection) => void;
    /** A narrow screen shows the run or the comparison instead of this column. */
    hiddenOnNarrow: boolean;
    onCompareGolden: (golden: GoldenItem) => void;
    onOpenRun: (runId: string) => void;
    /** The filters and the list of runs. */
    children: React.ReactNode;
}

/** The Runs tab's left column: "Runs | Testing", then the run list or the tests. */
export default function RunsLeftColumn({
    automationId, active, section, onSection, hiddenOnNarrow, onCompareGolden, onOpenRun, children,
}: RunsLeftColumnProps) {
    const { t } = useTranslation();
    return (
        <section
            aria-label={t('runs.tab.list_label', 'Runs')}
            className={`min-h-0 flex-col bg-[var(--bg-card)] border-r border-[var(--border-default)] ${hiddenOnNarrow ? 'hidden @[960px]/runs:flex' : 'flex'}`}
        >
            <RunsSectionTabs value={section} onChange={onSection} />
            {section === 'testing'
                ? <RunsTesting automationId={automationId} active={active} onCompareGolden={onCompareGolden} onOpenRun={onOpenRun} />
                : children}
        </section>
    );
}
