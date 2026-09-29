import { AppWindow, Clock, Loader2, Settings2, Sparkles, Upload } from 'lucide-react';
import ActionPill from './ActionPill';
import InstructionsEditor from './InstructionsEditor';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import ModelTierSelector from '../../../licensing/ModelTierSelector';
import MarkdownRenderer from '../../../renderers/MarkdownRenderer';
import { toast } from '../../../shared/Toast';
import Toggle from '../../../shared/Toggle';
import AppsPicker from '../pickers/AppsPicker';
import { RoutinesPicker } from '../pickers/RoutinePickers';
import SkillPicker from '../pickers/SkillPicker';

/**
 * De ROL-tab van de agent-editor: de actiepillen-balk met haar popovers en de
 * instructie-editor.
 *
 * Sinds A2 stap 1 zit hier GEEN kopbalk en GEEN identiteitsblok meer. De
 * opslagstatus, publiceren, de zichtbaarheidscapsule en de terugpijl zitten in
 * de gedeelde `AgentEditorHeader`; avatar, naam, omschrijving, de chips en —
 * sinds A3 deel B — de categorietag in `AgentHero`, boven de tabs. Dit bestand
 * tekent alleen nog wat ONDER de heldere identiteit hoort — en alles komt nog
 * steeds via props binnen; er staat hier geen state.
 */
export default function BuilderConfigPanel({
    ro, t, agent,
    flushNow,
    actionBarRef, tiers, selectedTier, updateModel,
    enabledIntegrationCount, appsPickerOpen, setAppsPickerOpen,
    uploadDocCount, setKnowledgeOpen,
    strictKnowledge, onStrictKnowledgeChange,
    attachedSkillIds, skillPickerOpen, setSkillPickerOpen,
    routinesAllowed, agentRoutines, routinesPickerOpen, setRoutinesPickerOpen,
    advancedOpen, setAdvancedOpen, memoryEnabled, embedEnabled,
    refreshAgentRoutines, setRoutineModal, setRoutineDeleteTarget,
    allSkills, setAllSkills, automations, skillSearch, setSkillSearch, toggleSkill,
    setAttachedSkillIds, patchConfig,
    availableIntegrations, enabledIntegrations, toggleIntegration,
    refining, instructionsEditing, setInstructionsEditing,
    instructionsTextareaRef, instructions, updateInstructions,
}) {
    return (
        <div className="max-w-4xl mx-auto px-10 pt-6 pb-12">
            {/* `inert` (React 19 native) blokkeert muis én toetsenbord voor de
                hele subtree zonder de layout aan te raken — anders dan
                fieldset[disabled], waarvan display:contents door browsers niet
                gehonoreerd wordt (een fieldset maakt altijd een eigen blok en
                zou deze flex-rijen voor IEDEREEN breken). */}
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
                {agent?.id && routinesAllowed && (
                    <ActionPill
                        icon={<Clock size={14} />}
                        label={t('routines.title', 'Routines')}
                        count={agentRoutines.filter(r => r.isActive).length}
                        onClick={() => setRoutinesPickerOpen(v => !v)}
                        active={routinesPickerOpen}
                        popoverTrigger="routines"
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

                {routinesPickerOpen && agent?.id && routinesAllowed && (
                    <RoutinesPicker
                        t={t}
                        agent={agent}
                        routines={agentRoutines}
                        onClose={() => setRoutinesPickerOpen(false)}
                        onCreate={() => { setRoutinesPickerOpen(false); setRoutineModal({ mode: 'create' }); }}
                        onEdit={(r) => { setRoutinesPickerOpen(false); setRoutineModal({ mode: 'edit', routine: r }); }}
                        onToggle={async (r) => {
                            try {
                                await authFetch(`${API_BASE}/api/ai-tasks/${r.id}/toggle`, { method: 'POST' });
                                await refreshAgentRoutines();
                            } catch (_) { /* non-fatal */ }
                        }}
                        onRunNow={async (r) => {
                            try {
                                await authFetch(`${API_BASE}/api/ai-tasks/${r.id}/run-now`, { method: 'POST' });
                                await refreshAgentRoutines();
                            } catch (_) { /* non-fatal */ }
                        }}
                        onDelete={(r) => {
                            // Route through the in-app modal so the styling,
                            // focus management and i18n match the rest of the
                            // studio. window.confirm can also be disabled by
                            // some browsers.
                            setRoutineDeleteTarget(r);
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
                                toast.error(err.message);
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

            {/* De categorie stond hier als volle-breedte veld met een kop
                erboven. Sinds A3 deel B staat hij in de identiteitsrij als
                "Sales ▾"-tag naast de naam (AgentHero) — hij hoort bij wie de
                agent IS, en hier stond hij vóór de vijf rolkaarten. Eén
                besturing, één plek: twee categorie-keuzelijsten op één scherm
                zijn twee plekken waar iemand hem kan zetten en één waar hij
                daarna niet meer klopt. */}

            {/* "Als het niet weet" (Agents-artboard 1c, ingevuld door A2 stap 2).
                `strictKnowledge` stond tot nu toe als vinkje BOVEN een
                bestandenlijst in de uploadmodal — twee klikken diep, op een
                scherm dat over bestanden gaat terwijl de instelling over
                ANTWOORDEN gaat. Het artboard tekent hier nog twee keuzes naast
                ("zoek op het web", "geef door aan een mens"); die bestaan nog
                niet als agentinstelling, en drie knoppen tekenen waarvan er
                één werkt is erger dan één knop die het doet. */}
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

            <div className="mb-2">
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
                        onBlurEnd={() => { flushNow(); setInstructionsEditing(false); }}
                    />
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
            </div>
        </div>
    );
}
