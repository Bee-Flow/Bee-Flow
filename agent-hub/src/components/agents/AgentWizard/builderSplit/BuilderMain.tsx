import AgentHero from './AgentHero';
import { AGENT_TAB_IDS } from './AgentEditorHeader';
import BuilderConfigPanel from './BuilderConfigPanel';
import { CanUseTabPanel, TestTabPanel, UsedByTabPanel } from './BuilderTabPanels';
import type { NavigateFn } from './editorTypes';
import type { RelativeTimeInput } from '../../../../hooks/useRelativeTime';
import type useAgentTests from '../tests/useAgentTests';
import type useAgentBootstrapData from './useAgentBootstrapData';
import type useAgentSchedules from './useAgentSchedules';
import type useBuilderState from './useBuilderState';
import type useCanUseTab from './useCanUseTab';
import type useEditorActions from './useEditorActions';
import type useEditorDerived from './useEditorDerived';
import type { TranslateFn } from '../../../../hooks/useTranslation';

interface Props {
    t: TranslateFn;
    ro: boolean;
    rel: (dateLike: RelativeTimeInput) => string;
    user: unknown;
    locale: string | undefined;
    onNavigate: NavigateFn;
    s: ReturnType<typeof useBuilderState>;
    actions: ReturnType<typeof useEditorActions>;
    canUse: ReturnType<typeof useCanUseTab>;
    boot: ReturnType<typeof useAgentBootstrapData>;
    derived: ReturnType<typeof useEditorDerived>;
    schedules: ReturnType<typeof useAgentSchedules>;
    testSet: ReturnType<typeof useAgentTests>;
    uploadDocCount: number | null | undefined;
    /** Flush on blur for typed fields. */
    flushNow: () => void;
}

/**
 * The scrolling main column of the agent editor: the hero above the tabs and
 * the body of the active tab. Everything comes in as props; no state here.
 */
export default function BuilderMain({ t, ro, rel, user, locale, onNavigate, s, actions, canUse, boot, derived, schedules, testSet, uploadDocCount, flushNow }: Props) {
    const { agent, activeTab, knowledgeBaseIds } = s;
    const { allSkills, tiers } = boot;
    return (
        <main className="flex-1 min-w-0 overflow-y-auto">
            <AgentHero
                t={t}
                ro={ro}
                avatar={s.avatar}
                updateAvatar={actions.updateAvatar}
                name={s.name}
                updateName={actions.updateName}
                flushNow={flushNow}
                description={s.description}
                updateDescription={actions.updateDescription}
                tiers={tiers}
                selectedTier={s.selectedTier}
                language={derived.personaLanguage}
                locale={locale}
                // The category belongs to the identity ("Sales ▾"), not to the
                // role — A3 took it off the Role tab, where it used to sit
                // before the five role cards.
                categoryId={s.categoryId}
                categories={boot.categories}
                categoriesState={boot.categoriesState}
                updateCategory={actions.updateCategory}
                createCategory={actions.createCategory}
                renameCategory={actions.renameCategory}
                deleteCategory={actions.deleteCategory}
            />

            {activeTab === AGENT_TAB_IDS.ROLE && (
                <BuilderConfigPanel
                    ro={ro} t={t} agent={agent}
                    flushNow={flushNow}
                    actionBarRef={s.actionBarRef} tiers={tiers} selectedTier={s.selectedTier} updateModel={actions.updateModel}
                    enabledIntegrationCount={derived.enabledIntegrationCount} appsPickerOpen={s.appsPickerOpen} setAppsPickerOpen={s.setAppsPickerOpen}
                    uploadDocCount={uploadDocCount} setKnowledgeOpen={s.setKnowledgeOpen}
                    strictKnowledge={s.strictKnowledge} onStrictKnowledgeChange={actions.onStrictKnowledgeChange}
                    attachedSkillIds={s.attachedSkillIds} skillPickerOpen={s.skillPickerOpen} setSkillPickerOpen={s.setSkillPickerOpen}
                    schedulesAllowed={schedules.schedulesAllowed} agentSchedules={schedules.agentSchedules}
                    schedulesPickerOpen={s.schedulesPickerOpen} setSchedulesPickerOpen={s.setSchedulesPickerOpen}
                    advancedOpen={s.advancedOpen} setAdvancedOpen={s.setAdvancedOpen} memoryEnabled={s.memoryEnabled} embedEnabled={s.embedEnabled}
                    refreshAgentSchedules={schedules.refreshAgentSchedules} setScheduleModal={s.setScheduleModal} setScheduleDeleteTarget={s.setScheduleDeleteTarget}
                    allSkills={allSkills} setAllSkills={boot.setAllSkills} automations={boot.automations}
                    skillSearch={s.skillSearch} setSkillSearch={s.setSkillSearch} toggleSkill={actions.toggleSkill}
                    setAttachedSkillIds={s.setAttachedSkillIds} patchConfig={actions.patchConfig}
                    availableIntegrations={derived.availableIntegrations} enabledIntegrations={s.enabledIntegrations} toggleIntegration={actions.toggleIntegration}
                    refining={s.refining} instructionsEditing={s.instructionsEditing} setInstructionsEditing={s.setInstructionsEditing}
                    instructionsTextareaRef={s.instructionsTextareaRef} instructions={s.instructions} updateInstructions={actions.updateInstructions}
                />
            )}

            {/* "Can use" — Knowledge (step 2), Skills (step 2) and Tools
                (step 3). The tool CHOOSER behind it came in step 4; see
                openChooser for where the "+ Link" and arrow buttons go. */}
            {activeTab === AGENT_TAB_IDS.CAN_USE && (
                <CanUseTabPanel
                    t={t} ro={ro} rel={rel} onNavigate={onNavigate} allSkills={allSkills}
                    knowledgeBaseIds={knowledgeBaseIds} includeSourceReferences={s.includeSourceReferences}
                    onIncludeSourceReferencesChange={actions.onIncludeSourceReferencesChange}
                    kbsState={actions.kbsState} refreshKbs={actions.refreshKbs} {...canUse}
                />
            )}

            {activeTab === AGENT_TAB_IDS.TEST && <TestTabPanel t={t} ro={ro} rel={rel} agent={agent} testSet={testSet} />}

            {activeTab === AGENT_TAB_IDS.USED_BY && (
                <UsedByTabPanel t={t} user={user} usageError={derived.usageError} refetchUsage={derived.refetchUsage} agentUsage={derived.agentUsage} />
            )}
        </main>
    );
}
