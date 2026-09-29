// "Which agent": the chosen agent as a card (Choose another · Open), and the
// list to choose from.
//
// The list keeps the honesty rules of R2:
//   - an agent that cannot be picked is still listed, WITH the reason;
//   - "could not read the list" is not "there are no agents";
//   - an agent the step names that is no longer listed stays selected.
import { ArrowUpRight, Bot } from 'lucide-react';
import { useState } from 'react';
import type { MouseEvent } from 'react';
import type { AgentStepPreview } from '../../../../../../api/queries/automation/agents';
import type { TranslateFn } from '../../../../../../hooks/useTranslation';
import { studioHref, studioTarget } from '../../studioLinks';
import { EmptySectionNote, SectionNote, hintTextClass } from '../formPrimitives';
import { agentMetaLine } from './agentStepModel';

export interface AgentRow {
    id: string;
    name: string;
    description?: string | null;
    scope?: string | null;
    canUse?: boolean;
    reason?: string | null;
}

/** Rows the picker can show, or `null` when the list could not be read. */
export function agentRowsOf(catalog: unknown): AgentRow[] | null {
    if (!catalog || typeof catalog !== 'object') return null;
    const c = catalog as { agentsError?: unknown; agents?: unknown };
    if (c.agentsError) return null;                 // read failed, server said so
    if (!Array.isArray(c.agents)) return null;      // older server: unknown, not empty
    return c.agents as AgentRow[];
}

/** The sentence under an agent that cannot be chosen. Never silence. */
function agentReasonText(t: TranslateFn, reason: string | null | undefined): string {
    switch (reason) {
        case 'not_published':
            return t('routine_editor.agent_reason_not_published', 'Not published yet — publish it to use it in a routine.');
        case 'other_org':
            return t('routine_editor.agent_reason_other_org', 'Belongs to another workspace.');
        case 'not_shared':
            return t('routine_editor.agent_reason_not_shared', 'Not shared with you.');
        default:
            return t('routine_editor.agent_reason_unavailable', 'Not available to this routine.');
    }
}

interface AgentChooserProps {
    rows: AgentRow[] | null;
    agentId: string | null;
    onPick: (id: string) => void;
    t: TranslateFn;
}

function AgentChooser({ rows, agentId, onPick, t }: AgentChooserProps) {
    const listed = (rows || []).some((a) => a.id === agentId);
    return (
        <div className="space-y-2">
            <div className="flex max-h-56 flex-col gap-1.5 overflow-auto" role="radiogroup" aria-label={t('routine_editor.agent_field_label', 'Which agent')}>
                {agentId && !listed ? (
                    <label className="flex cursor-pointer items-start gap-2 text-sm text-[var(--text-primary)]">
                        <input
                            type="radio" className="mt-0.5" name="ai-step-agent" checked readOnly
                            aria-label={t('routine_editor.agent_unlisted_aria', 'Agent {id}', { id: agentId })}
                        />
                        <span className="min-w-0">
                            <span className="block truncate">{agentId}</span>
                            <span className={`block ${hintTextClass()}`}>
                                {t('routine_editor.agent_unlisted_hint', 'This step runs on this agent, and it is not in the list above. Pick another one, or leave it and the step will say so when it runs.')}
                            </span>
                        </span>
                    </label>
                ) : null}
                {(rows || []).map((a) => (
                    <label
                        key={a.id}
                        className={`flex items-start gap-2 text-sm ${a.canUse ? 'cursor-pointer text-[var(--text-primary)]' : 'cursor-not-allowed text-[var(--text-tertiary)]'}`}
                    >
                        <input
                            type="radio" className="mt-0.5" name="ai-step-agent"
                            disabled={!a.canUse}
                            checked={agentId === a.id}
                            onChange={() => onPick(a.id)}
                            aria-label={a.name}
                        />
                        <span className="min-w-0">
                            <span className="flex items-center gap-1.5">
                                <Bot size={12} className="shrink-0 opacity-70" aria-hidden="true" />
                                <span className="truncate">{a.name}</span>
                                {a.scope === 'personal' ? (
                                    <span className="shrink-0 rounded-full bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[10px] text-[var(--text-secondary)]">
                                        {t('routine_editor.agent_scope_personal', 'Personal')}
                                    </span>
                                ) : null}
                            </span>
                            {!a.canUse ? (
                                <span className={`block ${hintTextClass()}`}>{agentReasonText(t, a.reason)}</span>
                            ) : a.description ? (
                                <span className={`block truncate ${hintTextClass()}`}>{a.description}</span>
                            ) : null}
                        </span>
                    </label>
                ))}
            </div>
            {rows === null ? (
                <SectionNote tone="warn">
                    {t('routine_editor.agent_list_unreadable', 'The list of agents could not be read, so it is not shown. That is not the same as having none — try again in a moment. A step that already names an agent keeps it.')}
                </SectionNote>
            ) : null}
            {rows !== null && rows.length === 0 ? (
                <EmptySectionNote>{t('routine_editor.agent_list_empty', 'No agents yet — build one under Agents first.')}</EmptySectionNote>
            ) : null}
        </div>
    );
}

export interface AgentPickerProps {
    rows: AgentRow[] | null;
    agentId: string | null;
    preview: AgentStepPreview | null;
    skillCount: number;
    onPick: (id: string) => void;
    onNavigate?: ((target: string) => void) | null;
    t: TranslateFn;
}

export default function AgentPicker({ rows, agentId, preview, skillCount, onPick, onNavigate = null, t }: AgentPickerProps) {
    const [choosing, setChoosing] = useState(false);
    const title = t('routine_editor.agent_field_label', 'Which agent');
    const row = (rows || []).find((a) => a.id === agentId) || null;
    const name = preview?.name || row?.name || agentId;
    const open = (e: MouseEvent) => {
        if (!onNavigate || !agentId) return;
        e.preventDefault();
        onNavigate(studioTarget('agents', agentId));
    };

    return (
        <div className="flex flex-col gap-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-[.06em] text-[var(--text-tertiary)]">{title}</div>
            {agentId ? (
                <div className="flex items-center gap-2.5 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2.5" data-testid="agent-card">
                    <span aria-hidden="true" className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[color-mix(in_srgb,var(--type-ai)_14%,transparent)] text-[var(--type-ai)]">
                        <Bot size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-[var(--text-primary)]">{name}</span>
                        <span className="block truncate text-[11px] text-[var(--text-secondary)]">{agentMetaLine(t, preview, skillCount)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 text-[11px] font-medium">
                        <button
                            type="button"
                            onClick={() => setChoosing((v) => !v)}
                            aria-expanded={choosing}
                            className="rounded px-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
                        >
                            {t('routines.agent_step.choose_another', 'Choose another')}
                        </button>
                        <a
                            href={studioHref('agents', agentId)}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={open}
                            className="inline-flex items-center gap-0.5 rounded px-1 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:underline"
                        >
                            {t('routines.agent_step.open_agent', 'Open')}
                            <ArrowUpRight size={12} aria-hidden="true" />
                        </a>
                    </span>
                </div>
            ) : null}
            {!agentId || choosing ? (
                <AgentChooser
                    rows={rows}
                    agentId={agentId}
                    onPick={(id) => { setChoosing(false); onPick(id); }}
                    t={t}
                />
            ) : null}
        </div>
    );
}
