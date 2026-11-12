/**
 * The presentational pieces of BuilderSplit's main column: the plan-limit
 * banner and the bodies of the "Can use", "Test" and "Used by" tabs. Moved
 * verbatim from BuilderSplit; every value comes in as a prop.
 */
import { FlaskConical, Sparkles, X } from 'lucide-react';
import EmptyState from '@/components/shared/EmptyState';
import UsedByTab from '@/components/shared/UsedByTab';
import useChatEngine from '@/hooks/useChatEngine';
import { READ } from '../canUse/canUseFacts';
import KnowledgeCard from '../canUse/KnowledgeCard';
import SkillsCard from '../canUse/SkillsCard';
import ToolsCard from '../canUse/ToolsCard';
import SuggestedTestForm from '../tests/SuggestedTestForm';
import TestChatPanel from '../tests/TestChatPanel';
import { lastCompletedTurn } from '../tests/testChatTurn';
import TestSetCard from '../tests/TestSetCard';
import useAddFromChat from '../tests/useAddFromChat';

// The editor's state is server JSON and untyped JS callbacks, passed through as is.
type Loose = any;

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
                        href="/app/admin/organisation/license"
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
    lentState, refetchLent, grantedAutomationRows, onChangeConfirm, onChangeActAs, onChangeMailAccess, onChangeMailRunOption, openChooser,
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
            <SkillsCard
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
                automationsState={(grantedAutomationRows.some((r: { readable?: boolean }) => !r.readable) ? READ.ERROR : READ.OK)}
                onChangeConfirm={onChangeConfirm}
                onChangeActAs={onChangeActAs}
                onChangeMailAccess={onChangeMailAccess}
                onChangeMailRunOption={onChangeMailRunOption}
                onOpenChooser={openChooser}
            />
        </div>
    );
}

// A test chat runs on the saved draft and leaves no conversation behind.
const TEST_CHAT = { enabled: true };

/**
 * "Test": ask the saved draft a question, then turn that answer into a test of the
 * test set. An unsaved agent has nothing to hang questions on.
 */
export function TestTabPanel({ t, ro, rel, agent, testSet }: Loose) {
    const chat = useChatEngine({ selectedAgent: agent?.id ? agent : null, testChat: TEST_CHAT });
    const addFromChat = useAddFromChat({ t, testSet });
    const turn = chat.isLoading ? null : lastCompletedTurn(chat.messages);
    return (
        <div className="max-w-4xl mx-auto px-10 py-10">
            {agent?.id ? (
                <>
                    <TestChatPanel
                        t={t}
                        ro={ro}
                        messages={chat.messages}
                        isLoading={chat.isLoading}
                        onSend={(text: string) => { void chat.sendMessage(text); }}
                        onStop={chat.stopGenerating}
                        onToolDecision={chat.decideTool as never}
                        toolDecisions={chat.toolDecisions}
                    />
                    {addFromChat.turn && (
                        <div className="mb-6">
                            {/* Keyed on the state: the form starts from the proposal it is given at
                                mount, so it must mount again when the proposal arrives. */}
                            <SuggestedTestForm
                                key={addFromChat.state}
                                t={t}
                                turn={addFromChat.turn}
                                suggestion={addFromChat.suggestion}
                                state={addFromChat.state}
                                refusal={addFromChat.refusal}
                                saving={addFromChat.saving}
                                saveError={addFromChat.saveError}
                                onSave={addFromChat.save}
                                onCancel={addFromChat.close}
                            />
                        </div>
                    )}
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
                        onAddFromChat={() => { if (turn) void addFromChat.open(turn); }}
                        canAddFromChat={!!turn}
                        addFromChatBusy={addFromChat.busy}
                    />
                </>
            ) : (
                // An agent without an id is not saved anywhere yet,
                // so there is nothing to attach the questions to.
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
                // "Not read" must never appear on the screen as "nobody uses
                // this". On an error, UsedByTab places the warning ABOVE its
                // empty-list sentence ("Nothing uses this yet."), and that sentence
                // is exactly the claim a failed read may not make. So we do not draw
                // it here; we ask again.
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
