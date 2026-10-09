// "Who can call this": the agents an agent_call automation is linked to. Binding
// an agent gives the AGENT the right to call it; anyone who may chat with that
// agent can have it start the automation, and the run still executes as the
// automation's owner. Saved through its own endpoint, not the definition save
// (a definition is copied by duplicate / import / restore; a grant must not be).
import { Bot, Lock, X } from 'lucide-react';
import { useState } from 'react';
import {
    AgentBindingsError, useAgentBindings, useSaveAgentBindings,
    type AgentBindings, type BoundAgent,
} from '../../../../../../api/queries/automation/agentBindings';
import { useTranslation, type TranslateFn } from '../../../../../../hooks/useTranslation';
import { EmptySectionNote, FormRow, SectionNote, hintTextClass, inputClass } from '../formPrimitives';
import { pickableAgents, refusalText, withAgent, withoutAgent } from './agentBindingsModel';

export interface AgentBindingsSectionProps {
    automationId: string;
}

/** The "Who can call this" row of the agent trigger panel. */
export default function AgentBindingsSection({ automationId }: AgentBindingsSectionProps) {
    const { t } = useTranslation();
    return (
        <FormRow
            label={t('automationAgentBindings.title', 'Who can call this')}
            hint={t('automationAgentBindings.hint', 'Only the agents you link here can start this automation. Anyone who may chat with a linked agent can use it through that agent. It runs as the owner of this automation.')}
        >
            <AgentBindingsBody automationId={automationId} />
        </FormRow>
    );
}

interface RowProps { binding: BoundAgent; removable: boolean; busy: boolean; onUnlink: () => void; t: TranslateFn }

function LinkedAgentRow({ binding: b, removable, busy, onUnlink, t }: RowProps) {
    const name = b.missing
        ? t('automationAgentBindings.deleted_agent', 'A deleted agent')
        : b.canEdit && b.name ? b.name : t('automationAgentBindings.other_agent', 'Another agent');
    return (
        <li
            className="flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-2.5 py-1.5 text-[12px]"
            data-testid="agent-binding-row"
        >
            {b.canEdit
                ? <Bot size={13} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                : <Lock size={13} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />}
            <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[var(--text-primary)]">{name}</span>
                {!b.canEdit ? (
                    <span className={`block ${hintTextClass()}`}>
                        {t('automationAgentBindings.other_agent_hint', 'You cannot edit this agent, so only someone who can edit it can unlink it.')}
                    </span>
                ) : b.usable === false && !b.missing ? (
                    <span className="block text-[11px] text-amber-600 dark:text-amber-400">
                        {t('automationAgentBindings.inactive_hint', 'Linked, but the owner of this automation cannot use this agent (is it published?), so it cannot call it.')}
                    </span>
                ) : b.notGranted === true && !b.missing ? (
                    <span className="block text-[11px] text-amber-600 dark:text-amber-400">
                        {t('automationAgentBindings.not_granted_hint', 'Linked, but this agent leaves this automation out of its list of automations, so it is never offered. Tick it in the agent\'s "Automations as a tool".')}
                    </span>
                ) : null}
            </span>
            {removable ? (
                <button
                    type="button"
                    disabled={busy}
                    onClick={onUnlink}
                    aria-label={t('automationAgentBindings.unlink', 'Unlink {name}', { name })}
                    className="shrink-0 rounded p-0.5 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
                >
                    <X size={12} />
                </button>
            ) : null}
        </li>
    );
}

interface AddProps { data: AgentBindings; busy: boolean; onAdd: (id: string) => void; t: TranslateFn }

/** The picker, or the sentence that says why there is none. */
function AddAgent({ data, busy, onAdd, t }: AddProps) {
    if (!data.canManage) {
        return <EmptySectionNote>{t('automationAgentBindings.read_only', 'Only people who can edit this automation can link agents to it.')}</EmptySectionNote>;
    }
    if (!data.isAgentCall) {
        return <EmptySectionNote>{t('automationAgentBindings.save_trigger_first', 'Set the trigger to "Agent tool" and save it first, then link agents.')}</EmptySectionNote>;
    }
    if (data.candidates === null) {
        return (
            <SectionNote tone="warn">
                {t('automationAgentBindings.candidates_failed', 'Your agents could not be read, so none can be added right now. Try again in a moment.')}
            </SectionNote>
        );
    }
    const pickable = pickableAgents(data);
    if (pickable.length === 0) {
        return (
            <EmptySectionNote>
                {t('automationAgentBindings.no_candidates', 'No more agents to link. You can link agents you can edit and the owner of this automation can use.')}
            </EmptySectionNote>
        );
    }
    return (
        <select
            value=""
            disabled={busy}
            onChange={(e) => { if (e.target.value) onAdd(e.target.value); }}
            aria-label={t('automationAgentBindings.add_label', 'Link an agent')}
            className={inputClass()}
        >
            <option value="">{t('automationAgentBindings.add_placeholder', 'Link an agent…')}</option>
            {pickable.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
    );
}

function AgentBindingsBody({ automationId }: AgentBindingsSectionProps) {
    const { t } = useTranslation();
    const query = useAgentBindings(automationId);
    const save = useSaveAgentBindings(automationId);
    const [error, setError] = useState<string | null>(null);
    const data = query.data;

    const submit = (agentIds: string[]) => {
        setError(null);
        save.mutate(agentIds, {
            onError: (e) => {
                const refusal = e instanceof AgentBindingsError ? refusalText(e.code, e.status) : refusalText(null, 0);
                setError(t(refusal.key, refusal.fallback));
            },
        });
    };

    if (query.isLoading) {
        return <p className={hintTextClass()}>{t('automationAgentBindings.loading', 'Loading…')}</p>;
    }
    if (query.isError || !data) {
        return (
            <SectionNote tone="warn">
                {t('automationAgentBindings.load_failed', 'The linked agents could not be read, so they are not shown. That is not the same as having none.')}
            </SectionNote>
        );
    }

    return (
        <div className="flex flex-col gap-2" data-testid="agent-bindings">
            {data.bindings.length === 0 ? (
                <SectionNote tone="warn">
                    {t('automationAgentBindings.none_yet', 'Not linked to any agent yet. No agent can call this automation until you link one.')}
                </SectionNote>
            ) : (
                <ul className="flex flex-col gap-1" aria-label={t('automationAgentBindings.linked_list', 'Linked agents')}>
                    {data.bindings.map((b, i) => (
                        <LinkedAgentRow
                            key={b.agentId || `other-${i}`}
                            binding={b}
                            removable={data.canManage && b.canEdit && !!b.agentId}
                            busy={save.isPending}
                            onUnlink={() => submit(withoutAgent(data.bindings, b.agentId as string))}
                            t={t}
                        />
                    ))}
                </ul>
            )}
            <AddAgent data={data} busy={save.isPending} onAdd={(id) => submit(withAgent(data.bindings, id))} t={t} />
            {error ? <SectionNote tone="warn">{error}</SectionNote> : null}
        </div>
    );
}
