import { AppWindow, Clock, Loader2, Settings2, Sparkles, Upload } from 'lucide-react';
import ActionPill from './ActionPill';
import InstructionsEditor from './InstructionsEditor';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import ModelTierSelector from '../../../licensing/ModelTierSelector';
import MarkdownRenderer from '../../../renderers/MarkdownRenderer';
import { toast } from '../../../shared/Toast';
import Toggle from '../../../shared/Toggle';
import AppsPicker from '../pickers/AppsPicker';
import { SchedulesPicker } from '../pickers/SchedulePickers';
import SkillPicker from '../pickers/SkillPicker';
import { messageOf } from '../../../../utils/caughtError';
import type { ComponentProps, Dispatch, Ref, SetStateAction } from 'react';
import type { ModelTierMap } from '../../../../api/queries/modelTiers';
import type { Skill } from '../../../../api/queries/skills';
import type { TranslateFn, TranslateParams } from '../../../../hooks/useTranslation';
import type { Schedule } from './useAgentSchedules';
import { logger } from '../../../../utils/logger';

type OpenSetter = Dispatch<SetStateAction<boolean>>;

export interface BuilderConfigPanelProps {
    ro?: boolean;
    t: TranslateFn;
    agent?: { id?: string | null } | null;
    flushNow: () => void;
    actionBarRef: Ref<HTMLDivElement>;
    tiers?: ModelTierMap | null;
    selectedTier?: string;
    updateModel: (tier: string) => void;
    enabledIntegrationCount?: number | null;
    appsPickerOpen: boolean;
    setAppsPickerOpen: OpenSetter;
    uploadDocCount?: number | null;
    setKnowledgeOpen: (open: boolean) => void;
    strictKnowledge?: boolean;
    onStrictKnowledgeChange?: (next: boolean) => void;
    attachedSkillIds: string[];
    skillPickerOpen: boolean;
    setSkillPickerOpen: OpenSetter;
    schedulesAllowed?: boolean;
    agentSchedules: Schedule[];
    schedulesPickerOpen: boolean;
    setSchedulesPickerOpen: OpenSetter;
    advancedOpen?: boolean;
    setAdvancedOpen: (open: boolean) => void;
    memoryEnabled?: boolean;
    embedEnabled?: boolean;
    refreshAgentSchedules: () => Promise<unknown> | void;
    setScheduleModal: (modal: { mode: 'create' } | { mode: 'edit'; schedule: Schedule }) => void;
    setScheduleDeleteTarget: (target: Schedule) => void;
    allSkills: Skill[] | null;
    setAllSkills: Dispatch<SetStateAction<Skill[] | null>>;
    automations: ComponentProps<typeof SkillPicker>['automations'];
    skillSearch: string;
    setSkillSearch: (value: string) => void;
    toggleSkill: (id: string) => void;
    setAttachedSkillIds: (ids: string[]) => void;
    patchConfig: (patch: Record<string, unknown>) => void;
    availableIntegrations: ComponentProps<typeof AppsPicker>['items'];
    enabledIntegrations?: string[] | null;
    toggleIntegration: (id: string, items: ComponentProps<typeof AppsPicker>['items']) => void;
    refining?: boolean;
    instructionsEditing?: boolean;
    setInstructionsEditing: (editing: boolean) => void;
    instructionsTextareaRef: Ref<HTMLTextAreaElement>;
    instructions?: string;
    updateInstructions: (value: string) => void;
}

/**
 * The ROLE tab of the agent editor: the action-pill bar with its popovers and
 * the instruction editor.
 *
 * Since A2 step 1 there is NO heading bar and NO identity block here any more.
 * The save status, publish, the visibility capsule and the back arrow sit in the
 * shared `AgentEditorHeader`. The avatar, name, description, the chips and,
 * since A3 part B, the category tag sit in `AgentHero`, above the tabs. This file
 * only draws what belongs BELOW that clear identity, and everything still comes in
 * through props. There is no state here.
 */
export default function BuilderConfigPanel({
    ro, t, agent,
    flushNow,
    actionBarRef, tiers, selectedTier, updateModel,
    enabledIntegrationCount, appsPickerOpen, setAppsPickerOpen,
    uploadDocCount, setKnowledgeOpen,
    strictKnowledge, onStrictKnowledgeChange,
    attachedSkillIds, skillPickerOpen, setSkillPickerOpen,
    schedulesAllowed, agentSchedules, schedulesPickerOpen, setSchedulesPickerOpen,
    advancedOpen, setAdvancedOpen, memoryEnabled, embedEnabled,
    refreshAgentSchedules, setScheduleModal, setScheduleDeleteTarget,
    allSkills, setAllSkills, automations, skillSearch, setSkillSearch, toggleSkill,
    setAttachedSkillIds, patchConfig,
    availableIntegrations, enabledIntegrations, toggleIntegration,
    refining, instructionsEditing, setInstructionsEditing,
    instructionsTextareaRef, instructions, updateInstructions,
}: BuilderConfigPanelProps) {
    return (
        <div className="max-w-4xl mx-auto px-10 pt-6 pb-12">
            {/* `inert` (React 19 native) blocks mouse AND keyboard for the entire
                subtree without touching the layout. Unlike fieldset[disabled], whose
                display:contents is not honoured by browsers (a fieldset always makes
                its own block and would break these flex rows for EVERYONE). */}
            <div ref={actionBarRef} inert={ro || undefined} className={`flex flex-wrap items-center gap-2 relative mb-8 ${ro ? 'opacity-60' : ''}`}>
                <div className="mr-1">
                    <ModelTierSelector
                        tiers={tiers || {}}
                        value={selectedTier}
                        onChange={(v) => updateModel(v)}
                        dropDirection="down"
                    />
                </div>
                <ActionPill
                    icon={<AppWindow size={14} />}
                    label={t('agent_wizard.builder.browse_apps')}
                    count={enabledIntegrationCount}
                    onClick={() => setAppsPickerOpen(v => !v)}
                    active={appsPickerOpen}
                />
                {/* The documents the Files dialog lists, not the number of
                    linked knowledge bases (BFSF-392); see uploadKb.ts. */}
                <ActionPill
                    icon={<Upload size={14} />}
                    label={t('agent_wizard.builder.upload_files')}
                    count={uploadDocCount}
                    onClick={() => setKnowledgeOpen(true)}
                />
                <ActionPill
                    icon={<Sparkles size={14} />}
                    label={t('agent_wizard.builder.skills', 'Skills')}
                    count={attachedSkillIds.length}
                    onClick={() => setSkillPickerOpen(v => !v)}
                    active={skillPickerOpen}
                />
                {agent?.id && schedulesAllowed && (
                    <ActionPill
                        icon={<Clock size={14} />}
                        label={t('agent_schedules.title', 'Schedules')}
                        count={agentSchedules.filter(r => r.isActive).length}
                        onClick={() => setSchedulesPickerOpen(v => !v)}
                        active={schedulesPickerOpen}
                        popoverTrigger="schedules"
                    />
                )}
                <button
                    type="button"
                    onClick={() => setAdvancedOpen(true)}
                    className={`flex items-center justify-center w-8 h-8 rounded-lg border transition-all ${advancedOpen || memoryEnabled || embedEnabled
                        ? 'border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]'
                        : 'border-[var(--border-default)] bg-[var(--bg-card,#fff)] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'}`}
                    title={t('agent_wizard.builder.advanced_settings', 'Advanced settings')}
                    aria-label={t('agent_wizard.builder.advanced_settings', 'Advanced settings')}
                >
                    <Settings2 size={14} />
                </button>

                {schedulesPickerOpen && agent?.id && schedulesAllowed && (
                    <SchedulesPicker
                        t={t}
                        agent={agent}
                        schedules={agentSchedules}
                        onClose={() => setSchedulesPickerOpen(false)}
                        onCreate={() => { setSchedulesPickerOpen(false); setScheduleModal({ mode: 'create' }); }}
                        onEdit={(r: Schedule) => { setSchedulesPickerOpen(false); setScheduleModal({ mode: 'edit', schedule: r }); }}
                        onToggle={async (r: Schedule) => {
                            try {
                                await authFetch(`${API_BASE}/api/cowork/${r.id}/toggle`, { method: 'POST' });
                                await refreshAgentSchedules();
                            } catch (err) { logger.debug('non-fatal', err); }
                        }}
                        onRunNow={async (r: Schedule) => {
                            try {
                                await authFetch(`${API_BASE}/api/cowork/${r.id}/run-now`, { method: 'POST' });
                                await refreshAgentSchedules();
                            } catch (err) { logger.debug('non-fatal', err); }
                        }}
                        onDelete={(r: Schedule) => {
                            // Route through the in-app modal so the styling,
                            // focus management and i18n match the rest of the
                            // studio. window.confirm can also be disabled by
                            // some browsers.
                            setScheduleDeleteTarget(r);
                        }}
                    />
                )}
                {skillPickerOpen && (
                    <SkillPicker
                        t={t}
                        skills={allSkills || []}
                        selectedIds={attachedSkillIds}
                        automations={automations}
                        search={skillSearch}
                        onSearch={setSkillSearch}
                        onClose={() => setSkillPickerOpen(false)}
                        onToggle={toggleSkill}
                        onCreate={async ({ name: skillName, description: skillDesc, instructions: skillInstr, automationId: skillAutomationId }) => {
                            try {
                                const res = await authFetch(`${API_BASE}/api/skills`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        name: skillName,
                                        description: skillDesc,
                                        instructions: skillInstr,
                                        isShared: false,
                                        // When the skill is linked to an automation,
                                        // mark it dynamic-activation so the agent calls
                                        // it on demand instead of injecting a body.
                                        dynamicActivation: !!skillAutomationId,
                                        automationId: skillAutomationId || null,
                                    }),
                                });
                                if (!res.ok) throw new Error(await res.text());
                                const created = await res.json();
                                setAllSkills(prev => [...(prev || []), created]);
                                const next = [...attachedSkillIds, created.id];
                                setAttachedSkillIds(next);
                                patchConfig({ attachedSkillIds: next });
                                return created;
                            } catch (err) {
                                console.error('Create skill failed:', err);
                                toast.error(messageOf(err, 'Failed to create skill'));
                                return null;
                            }
                        }}
                    />
                )}
                {appsPickerOpen && (
                    <AppsPicker
                        t={t}
                        items={availableIntegrations}
                        enabled={enabledIntegrations}
                        onClose={() => setAppsPickerOpen(false)}
                        onToggle={(id) => toggleIntegration(id, availableIntegrations)}
                    />
                )}
            </div>

            {/* The category used to stand here as a full-width field with a heading
                above it. Since A3 part B it sits in the identity row as a "Sales ▾"
                tag next to the name (AgentHero). It belongs to who the agent IS, and
                here it stood before the five role cards. One control, one place: two
                category dropdowns on one screen are two places where someone can set
                it, and one place where it is no longer correct afterwards. */}

            {/* "If it does not know" (Agents artboard 1c, filled in by A2 step 2).
                `strictKnowledge` used to be a checkbox ABOVE a file list in the upload
                modal: two clicks deep, on a screen about files, while the setting is
                about ANSWERS. The artboard draws two choices next to it ("search the
                web", "hand over to a human"). Those do not yet exist as an agent
                setting, and three buttons of which one works is worse than one button
                that does. */}
            <div className="mb-8" inert={ro || undefined}>
                <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-1">
                    {t('agent_studio.role.unknown_title', "If it doesn't know")}
                </div>
                <div className="rounded-xl border border-[var(--border-default)] px-4 py-3">
                    <Toggle
                        checked={!!strictKnowledge}
                        onChange={(next) => onStrictKnowledgeChange?.(next)}
                        label={t('agent_wizard.files.strict_label', 'Only answer from these documents')}
                        description={t('agent_wizard.files.strict_help', "When on, the agent will refuse to answer questions that aren't covered by the uploaded documents.")}
                    />
                </div>
            </div>

            <BuilderConfigPanelSection t={t} refining={refining} instructionsEditing={instructionsEditing} ro={ro} instructionsTextareaRef={instructionsTextareaRef} instructions={instructions} updateInstructions={updateInstructions} flushNow={flushNow} setInstructionsEditing={setInstructionsEditing} />
        </div>
    );
}

function BuilderConfigPanelSection({ t, refining, instructionsEditing, ro, instructionsTextareaRef, instructions, updateInstructions, flushNow, setInstructionsEditing }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; refining: boolean | undefined; instructionsEditing: boolean | undefined; ro: boolean | undefined; instructionsTextareaRef: Ref<HTMLTextAreaElement>; instructions: string | undefined; updateInstructions: (value: string) => void; flushNow: () => void; setInstructionsEditing: (editing: boolean) => void; }) {
    return <div className="mb-2">
        <div className="flex items-center gap-2 mb-1">
            <div className="text-[13px] font-medium text-[var(--text-secondary)]">
                {t('agent_wizard.builder.instructions')}
            </div>
            {refining && (
                <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)]">
                    <Loader2 size={11} className="animate-spin" />
                    {t('agent_wizard.builder.updating', 'Updating…')}
                </span>
            )}
        </div>
        {instructionsEditing && !refining && !ro ? (
            <InstructionsEditor
                ref={instructionsTextareaRef}
                initialValue={instructions}
                placeholder={t('agent_wizard.builder.instructions_placeholder')}
                onCommit={updateInstructions}
                onBlurEnd={() => { flushNow(); setInstructionsEditing(false); } } />
        ) : (
            <div
                role="button"
                tabIndex={(refining || ro) ? -1 : 0}
                onClick={(refining || ro) ? undefined : () => setInstructionsEditing(true)}
                onFocus={(refining || ro) ? undefined : () => setInstructionsEditing(true)}
                aria-disabled={refining || ro || undefined}
                className={`instructions-view min-h-[10rem] px-4 py-3 -mx-4 rounded-xl transition ${refining ? 'opacity-60 cursor-default' : ro ? 'cursor-default' : 'cursor-text hover:bg-[var(--bg-secondary)]/40'}`}
                title={(refining || ro) ? undefined : t('agent_wizard.builder.instructions_edit_hint', 'Click to edit')}
            >
                {instructions ? (
                    <MarkdownRenderer content={instructions} />
                ) : (
                    <div className="text-[var(--text-tertiary)] text-[15px] leading-7">
                        {t('agent_wizard.builder.instructions_placeholder')}
                    </div>
                )}
            </div>
        )}
    </div>;
}
