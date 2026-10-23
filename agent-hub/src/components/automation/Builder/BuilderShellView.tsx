import type { ComponentType, ReactNode } from 'react';
import type { Props as VersionsTabProps } from './versions/VersionsTab';
import type { BuildTabProps } from './build/buildTabTypes';
import BuilderShellLayout from './BuilderShellLayout';
import type { BuilderShellLayoutProps } from './BuilderShellLayout';

type LayoutBase = Omit<BuilderShellLayoutProps, 'editor' | 'versions' | 'history'>;

/** BuildTab props the view derives from the host-facing ones below. */
type DerivedBuildProps =
    | 'readOnly' | 'assistantOpen' | 'setAssistantOpen' | 'onClearAssistantContext' | 'onAskAssistant'
    | 'onDiscardProposal' | 'onRejectPlan' | 'onApprovePlan' | 'fatalError';

export interface BuilderShellViewProps {
    /**
     * Passed in, not imported: BuildTab and VersionsTab sit on the Studio
     * import cycle, and a view importing them would join it.
     */
    BuildTab: ComponentType<BuildTabProps>;
    VersionsTab: ComponentType<VersionsTabProps>;
    /** What the layout arranges (confirm, AI Act gate, diagnose panel, settings). */
    layout: LayoutBase;
    /** BuildTab's props that pass through unchanged. */
    build: Omit<BuildTabProps, DerivedBuildProps>;
    /** A managed automation's canvas is read-only for real (the draft never changes, nothing is saved). */
    readOnly: boolean;
    assistantOpen: boolean;
    setAssistantOpen: (open: boolean) => void;
    setAssistantContext: (context: null) => void;
    askAssistant: BuildTabProps['onAskAssistant'];
    /** The shell's own error; the stream's `state.error` is the other source of the fatal pill. */
    error: unknown;
    clearReview: (action: string, id: string | null | undefined) => void;
    /** The Run history (or Step executions) view, ready-made; mounted hidden by the layout. */
    history: ReactNode;
    /** Version history: a restored row replaces the shell's. */
    syncServerRow: NonNullable<VersionsTabProps['onRestored']>;
}

function noop() { /* the AI builder has no way in on a managed automation */ }

/**
 * The shell's arrangement: BuilderShellLayout with the Editor, Version history
 * and Run history views in its slots. Split out of BuilderShell, which keeps
 * the state and hands everything over ready-made.
 */
export default function BuilderShellView({
    BuildTab, VersionsTab, layout, build, readOnly, assistantOpen, setAssistantOpen, setAssistantContext, askAssistant, error, clearReview,
    history, syncServerRow,
}: BuilderShellViewProps) {
    const { tab, serverAutomation, t } = layout;
    const { state, onSend } = build;
    return (
        <BuilderShellLayout
            {...layout}
            editor={tab === 'build' && (
                <BuildTab
                    {...build}
                    readOnly={readOnly}
                    assistantOpen={assistantOpen && !readOnly}
                    setAssistantOpen={readOnly ? noop : setAssistantOpen}
                    onClearAssistantContext={() => setAssistantContext(null)}
                    onAskAssistant={readOnly ? null : askAssistant}
                    onDiscardProposal={() => clearReview('discardProposal', state.proposal?.id)}
                    onRejectPlan={() => clearReview('rejectPlan', state.reviewPlan?.id)}
                    onApprovePlan={(pauseAfterStep) => onSend(t('automations.assistant.approved_prompt', 'I approve this plan. Build it and report any deviations.'), [], { approvedPlanId: state.reviewPlan?.id, pauseAfterStep })}
                    fatalError={error || state.error}
                />
            )}
            versions={tab === 'versions' && (
                <VersionsTab automation={serverAutomation} onRestored={syncServerRow} />
            )}
            history={history}
        />
    );
}
