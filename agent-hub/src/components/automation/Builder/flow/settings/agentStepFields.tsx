// "Who does the thinking" in an AI step (handoff 5, round 3, artboard 3a).
//
// Left: the two mode cards (loose instruction | use an agent), which agent,
// the skills of this step, and the task field the caller renders. Right (a
// rail once this block is wide enough, stacked below otherwise): what the
// step continues as, and what the agent may do here.
//
// The layout folds by its OWN width (`@container/aistep`), never by the
// viewport: the same block sits in a narrow drawer and a wide one.
//
// ── WHY THE TOOL LIST IS FETCHED AND NOT COMPUTED ───────────────────
// "Would this tool ask a person first" is answered by the server's tool
// policy: the tool registry, the agent's per-action grants, and the
// `sends => ask` floor. Deriving it here from the catalog would put a second
// copy of the rights layer in the browser, and the copy that drifts is always
// the one nobody looks at. GET /catalog/agent/:id runs the SAME functions the
// run does (api/queries/automation/agents.ts).
import { useState } from 'react';
import type { ReactNode } from 'react';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { useTranslation } from '../../../../../hooks/useTranslation';
import AgentPermissionsPanel from './agentStep/AgentPermissionsPanel';
import AgentPicker, { agentRowsOf } from './agentStep/AgentPicker';
import ContinuesAs from './agentStep/ContinuesAs';
import StepSkillsList from './agentStep/StepSkillsList';
import ThinkingModeCards from './agentStep/ThinkingModeCards';
import { agentStepIsLive, plainAgentStepState, useAgentStepState } from './agentStep/useAgentStepState';
import type { AgentStepState, AgentStepUi, AiStepDraft, SetField } from './agentStep/useAgentStepState';

export interface AgentStepFieldsProps {
    draft: AiStepDraft;
    set: SetField;
    catalog?: { apps?: unknown[]; agents?: unknown; agentsError?: unknown } | null;
    /** The task / prompt field, rendered by the caller under the skills. */
    renderTask?: (opts: { withAgentOrSkill: boolean }) => ReactNode;
    onNavigate?: ((target: string) => void) | null;
}

interface LayoutProps extends Omit<AgentStepFieldsProps, 'draft' | 'set'> { s: AgentStepState; t: TranslateFn }

function AgentStepLayout({ s, t, catalog = null, renderTask, onNavigate = null }: LayoutProps) {
    const apps = (Array.isArray(catalog?.apps) ? catalog.apps : []) as Array<{ id?: string; label?: string }>;
    const agentSkillCount = (s.preview?.skills || []).filter((k) => k.fromAgent).length;
    return (
        <div className="@container/aistep" data-testid="agent-step-fields">
            <div className="grid grid-cols-1 gap-4 @[720px]/aistep:grid-cols-[minmax(0,1fr)_280px]">
                <div className="flex min-w-0 flex-col gap-4">
                    <ThinkingModeCards mode={s.mode} onChange={s.actions.chooseMode} t={t} />
                    {s.mode === 'agent' ? (
                        <AgentPicker
                            rows={agentRowsOf(catalog)} agentId={s.agentId} preview={s.preview}
                            skillCount={agentSkillCount} onPick={s.actions.chooseAgent} onNavigate={onNavigate} t={t}
                        />
                    ) : null}
                    {s.previewForbidden ? (
                        <p className="text-[11px] text-[var(--warning)]">
                            {t('routine_editor.agent_capsule_forbidden', 'This agent cannot be used by this routine. Pick another one — an agent has to be published and shared with the routine\'s owner.')}
                        </p>
                    ) : null}
                    <StepSkillsList
                        rows={s.skillRows} withAgent={!!s.agentId} atCap={s.atCap} cap={s.cap}
                        skillList={s.skillList} skillListStatus={s.skillListStatus}
                        adding={s.adding} onSetAdding={s.actions.setAdding} onAdd={s.actions.addSkill}
                        onRemove={s.actions.removeSkill} onToggleAgentSkill={s.actions.toggleAgentSkill} t={t}
                    />
                    {renderTask ? renderTask({ withAgentOrSkill: s.withAgentOrSkill }) : null}
                </div>
                {s.withAgentOrSkill ? (
                    <div className="flex min-w-0 flex-col gap-4">
                        <ContinuesAs skillFields={s.skillFields} skillName={s.leadName} stepFields={s.stepFields} t={t} />
                        {s.agentId ? (
                            <AgentPermissionsPanel
                                permissions={s.permissions} onChange={s.actions.setPermission}
                                preview={s.preview} status={s.previewStatus} apps={apps} t={t}
                            />
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

type InnerProps = AgentStepFieldsProps & { ui: AgentStepUi };

/** A step with an agent or a skill (or one asking for either): reads from the server. */
function LiveAgentStepFields({ draft, set, ui, ...rest }: InnerProps) {
    const { t } = useTranslation();
    return <AgentStepLayout s={useAgentStepState(draft, set, ui)} t={t} {...rest} />;
}

/** The bare step: no reads, so it renders without a query client. */
function PlainAgentStepFields({ draft, set, ui, ...rest }: InnerProps) {
    const { t } = useTranslation();
    return <AgentStepLayout s={plainAgentStepState(draft, set, ui)} t={t} {...rest} />;
}

export function AgentStepFields(props: AgentStepFieldsProps) {
    // Held here so it survives the switch from the plain block to the live one.
    const [wantAgent, setWantAgent] = useState(false);
    const [adding, setAdding] = useState(false);
    const ui: AgentStepUi = { wantAgent, setWantAgent, adding, setAdding };
    return agentStepIsLive(props.draft, ui)
        ? <LiveAgentStepFields {...props} ui={ui} />
        : <PlainAgentStepFields {...props} ui={ui} />;
}
