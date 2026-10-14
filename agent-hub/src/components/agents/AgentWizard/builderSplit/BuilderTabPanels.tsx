/**
 * The presentational pieces of BuilderSplit's main column: the plan-limit
 * banner and the bodies of the "Can use", "Test" and "Used by" tabs. Moved
 * verbatim from BuilderSplit; every value comes in as a prop.
 */
import { FlaskConical, Sparkles, X } from 'lucide-react';
import type { ComponentProps, ComponentType } from 'react';
import EmptyState from '../../../shared/EmptyState';
import UsedByTab from '../../../shared/UsedByTab';
import { READ } from '../canUse/canUseFacts';
import KnowledgeCard from '../canUse/KnowledgeCard';
import SkillsCard from '../canUse/SkillsCard';
import ToolsCard from '../canUse/ToolsCard';
import TestSetCard from '../tests/TestSetCard';

// The editor's state is server JSON and untyped JS callbacks, passed through as is.
type Loose = any;
// The JS cards infer their READ-state props from the `= READ.OK` default; they
// take every READ value.
type ReadStateProp = typeof READ.OK;
// SkillsCard.jsx also reads its `onRetry` as required (no default); this panel
// never passed one. Same component, with the props it really takes.
const SkillsCardTyped = SkillsCard as unknown as ComponentType<
    Omit<ComponentProps<typeof SkillsCard>, 'onRetry' | 'state'> & { onRetry?: () => void; state?: string }
>;

/**
 * Plan-limit warning: a prominent, dismissible banner shown when a save is
 * blocked by the org's subscription limits (e.g. max agents). Replaces the
 * silent console error so the user can act on it.
 */
export function LimitWarningBanner({ t, limitWarning, setLimitWarning }: Loose) {
    return (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] w-[min(560px,92vw)]">
            <div className="rounded-xl border border-amber-500/40 bg-amber-50 dark:bg-amber-500/10 shadow-lg px-4 py-3 flex items-start gap-3">
                <Sparkles className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                        {t('agent_wizard.limit_reached_title', 'Plan limit reached')}
                    </p>
                    <p className="text-[12px] text-[var(--text-secondary)] mt-0.5">{limitWarning.message}</p>
                    <a
                        href="/app/settings/organisation/license"
                        className="inline-flex items-center gap-1 mt-2 px-3 py-1.5 rounded-md text-[12px] font-semibold bg-amber-500 text-white hover:bg-amber-600"
                    >
                        {t('agent_wizard.view_plans', 'View plans & upgrade')}
                    </a>
                </div>
                <button onClick={() => setLimitWarning(null)} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] shrink-0" aria-label={t('agent_wizard.builder_split_dismiss', 'Dismiss')}>
                    <X size={16} />
                </button>
            </div>
        </div>
    );
}

/**
 * "Can use": Knowledge (step 2), Skills (step 2) and Tools (step 3). The
 * "+ Link" and ↗ buttons go through openChooser (useCanUseTab).
 */
export function CanUseTabPanel({
    t, ro, rel, onNavigate, allSkills, knowledgeBaseIds, includeSourceReferences, onIncludeSourceReferencesChange,
    kbsState, refreshKbs, knowledgeRows, tableGrantRows, tablesState, tablesTruncated, refetchTables,
    attachedSkillRows, skillUsageState, appToolRows, catalogApps, catalogState, catalogDegraded, refetchCatalog,
    lentState, refetchLent, grantedAutomationRows, onChangeConfirm, onChangeActAs, openChooser,
}: Loose) {
    return (
        <div className="max-w-4xl mx-auto px-10 py-6">
            <KnowledgeCard
                t={t}
                ro={ro}
                rel={rel}
                kbRows={knowledgeRows}
                kbState={kbsState}
                onRetryKbs={refreshKbs}
                tableRows={tableGrantRows}
                tableState={tablesState}
                tableTruncated={tablesTruncated}
                onRetryTables={refetchTables}
                includeSourceReferences={includeSourceReferences}
                onIncludeSourceReferencesChange={onIncludeSourceReferencesChange}
                onOpenChooser={openChooser}
                onNavigate={onNavigate}
                tipKbId={knowledgeBaseIds[0] || null}
            />
            <SkillsCardTyped
                t={t}
                ro={ro}
                rows={attachedSkillRows}
                state={allSkills === null ? READ.LOADING : READ.OK}
                usageState={skillUsageState}
                onOpenChooser={openChooser}
            />
            <ToolsCard
                t={t}
                ro={ro}
                rows={appToolRows}
                apps={catalogApps}
                catalogState={catalogState}
                catalogDegraded={catalogDegraded}
                onRetryCatalog={refetchCatalog}
                lentState={lentState}
                onRetryLent={refetchLent}
                automationRows={grantedAutomationRows}
                automationsState={(grantedAutomationRows.some((r: { readable?: boolean }) => !r.readable) ? READ.ERROR : READ.OK) as ReadStateProp}
                onChangeConfirm={onChangeConfirm}
                onChangeActAs={onChangeActAs}
                onOpenChooser={openChooser}
            />
        </div>
    );
}

/** "Test": the test set of a saved agent; an unsaved one has nothing to hang questions on. */
export function TestTabPanel({ t, ro, rel, agent, testSet }: Loose) {
    return (
        <div className="max-w-4xl mx-auto px-10 py-10">
            {agent?.id ? (
                <TestSetCard
                    t={t}
                    ro={ro}
                    rel={rel}
                    tests={testSet.tests}
                    testsState={testSet.testsState}
                    onRetryTests={testSet.refetch}
                    readRefusal={testSet.readRefusal}
                    lastRun={testSet.lastRun}
                    lastRunUnknown={testSet.lastRunUnknown}
                    runs={testSet.runs}
                    runsState={testSet.runsState}
                    runsUnknown={testSet.runsUnknown}
                    runsKeep={testSet.runsKeep}
                    onOpenDetail={testSet.loadRuns}
                    progress={testSet.progress}
                    running={testSet.running}
                    refusal={testSet.refusal}
                    onRetryRun={testSet.runTests}
                    onRun={testSet.runTests}
                />
            ) : (
                // Een agent zonder id is nog nergens opgeslagen,
                // dus er is niets om vragen aan te hangen.
                <EmptyState
                    icon={<FlaskConical size={28} aria-hidden="true" />}
                    title={t('agent_studio.test.soon_title', 'Test questions land here')}
                    description={t('agent_studio.test.soon_body', 'Ask this agent a set of questions and see what it answers before anyone else does.')}
                />
            )}
        </div>
    );
}

/** "Used by": who uses this agent, or a retry when that could not be read. */
export function UsedByTabPanel({ t, user, usageError, refetchUsage, agentUsage }: Loose) {
    return (
        <div className="max-w-4xl mx-auto px-10 py-6">
            {usageError ? (
                // "Niet gelezen" mag nooit als "niemand gebruikt
                // dit" op het scherm komen. UsedByTab zet bij een
                // fout de waarschuwing BOVEN zijn lege-lijst-zin
                // ("Nothing uses this yet."), en die zin is precies
                // de bewering die een mislukte lezing niet mag doen
                // — dus tekenen we hem hier niet, we vragen het
                // opnieuw.
                <div role="status" data-testid="agent-usage-error" className="text-sm text-[var(--text-secondary)] flex flex-col items-start gap-2">
                    <span className="text-[var(--warning)]">
                        {t('agent_studio.used_by.unreadable', 'Could not load who uses this agent, so nothing is claimed here.')}
                    </span>
                    <button
                        type="button"
                        onClick={refetchUsage}
                        className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border-default)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        {t('agent_studio.retry', 'Retry')}
                    </button>
                </div>
            ) : (
                <UsedByTab
                    rows={agentUsage}
                    currentUserId={user?.id || null}
                    emptyText={t('agent_studio.used_by.empty', 'Nothing uses this agent yet.')}
                />
            )}
        </div>
    );
}
