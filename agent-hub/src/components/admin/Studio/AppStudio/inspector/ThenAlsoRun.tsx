import { Plus, X } from 'lucide-react';
import IconButton from '@/components/shared/IconButton';
import useTranslation from '@/hooks/useTranslation';
import { describeAction } from './actionLabels';
import { MAX_ACTIONS_PER_EVENT, slotIds, withAdded, withRemoved, withReplaced, type SlotValue } from './eventSlots';
import { INPUT_CLS } from './panels/kit';
import { setNodeEvent } from '../state/definitionOps';
import type { AppDefinition, AppNode } from './appDefinition';

/**
 * "Then also run": the actions an event runs AFTER its own one (schema 3). They run in this
 * order and the chain stops at the first that fails. The slot's own action (the first id)
 * stays where it always was, in the select above with its inline editor; this list picks
 * further actions the app already has. Shown once the slot has an action.
 */

export interface ThenAlsoRunProps {
    node: AppNode | null | undefined;
    event: string;
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    titleFor?: ((automationId?: string | null) => string | null) | null;
    disabled?: boolean;
}

// setNodeEvent writes the slot as given: one id, a list, or null.
const wireSlot = setNodeEvent as (def: AppDefinition, nodeId: string, event: string, slot: SlotValue) => AppDefinition;

const ADD_BTN = 'self-start inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]';

/** The app's actions as select options, in the words the event editor uses. */
export function useActionChoices(definition: AppDefinition, titleFor: ThenAlsoRunProps['titleFor'] = null) {
    const { t } = useTranslation();
    return Object.entries(definition?.actions || {}).map(([id, a]) => ({ id, label: describeAction(id, a, definition, titleFor, t) }));
}

export default function ThenAlsoRun({ node, event, definition, onCommit, titleFor = null, disabled = false }: ThenAlsoRunProps) {
    const choices = useActionChoices(definition, titleFor);
    if (!node) return null;
    const onChange = (next: SlotValue) => {
        const def = wireSlot(definition, node.id, event, next);
        if (def !== definition) onCommit(def);
    };
    return <ActionSlotList slot={node[event]} choices={choices} onChange={onChange} disabled={disabled} />;
}

export interface ActionSlotListProps {
    slot: unknown;
    choices: Array<{ id: string; label: string }>;
    onChange: (slot: SlotValue) => void;
    disabled?: boolean;
}

/** The "then also run" list of any slot (a node event, a screen's onOpen). */
export function ActionSlotList({ slot, choices, onChange, disabled = false }: ActionSlotListProps) {
    const { t } = useTranslation();
    const ids = slotIds(slot);
    if (!ids.length) return null;
    const extra = ids.slice(1);
    const first = choices[0]?.id;
    return (
        <div className="flex flex-col gap-1.5" data-app-then-also-run="true">
            {extra.length ? (
                <span className="text-xs font-medium text-[var(--text-secondary)]">{t('studio_apps_triggers.slot.then_also', 'Then also run, in this order')}</span>
            ) : null}
            {extra.map((id, i) => (
                <div key={`${i}:${id}`} className="flex items-center gap-2">
                    <select
                        className={INPUT_CLS}
                        value={id}
                        onChange={(e) => onChange(withReplaced(slot, i + 1, e.target.value))}
                        disabled={disabled}
                        aria-label={t('studio_apps_triggers.slot.extra_action', 'Action {n} of this event', { n: i + 2 })}
                    >
                        {choices.some((c) => c.id === id) ? null : <option value={id}>{id}</option>}
                        {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <IconButton ariaLabel={t('studio_apps_triggers.slot.remove', 'Do not run this one')} onClick={() => onChange(withRemoved(slot, i + 1))} disabled={disabled}>
                        <X />
                    </IconButton>
                </div>
            ))}
            {ids.length < MAX_ACTIONS_PER_EVENT && first ? (
                <button type="button" className={ADD_BTN} disabled={disabled} onClick={() => onChange(withAdded(slot, first))}>
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('studio_apps_triggers.slot.add', 'Then also run another action')}
                </button>
            ) : null}
            {extra.length ? (
                <span className="text-xs text-[var(--text-muted)]">{t('studio_apps_triggers.slot.stops', 'If one of them fails, the ones after it do not run.')}</span>
            ) : null}
        </div>
    );
}
