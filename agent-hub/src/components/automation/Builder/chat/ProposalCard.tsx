import { useState } from 'react';
import previewBinding from '../mapping/bindingPreview';
import { Check, Eye } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { proposalChanges, proposalFields } from './proposalChanges';
import ProposalTables from './ProposalTables';
import { describeBinding, fieldPathLabel, plainTerm, stepLabelsOf } from './plainVocabulary';
import type { StepLabels } from './plainVocabulary';
import type { Translator } from './toolCallDisplay';
import type { PendingTable, UsedTable } from './pendingTables';
import type { ProposalChange, FieldChange } from './proposalChanges';
import type { FlowDefinition, FlowStep } from '../flow/types';
import type { Binding } from '../mapping/itemRefs';
import { nodeTypeLabel } from '../flow/nodeDefs';

interface CardProposal {

    baseDefinition?: FlowDefinition | null;
    definition?: FlowDefinition;
    pendingDatatables?: PendingTable[];
    usedDatatables?: UsedTable[];
}

/** The real run / pinned outputs by step id; `get` takes the optional id of `trigger?.id`. */
export interface OutputLookup extends Iterable<[string, unknown]> {
    get(id: string | undefined): unknown;
}

interface Props {
    proposal?: CardProposal | null;
    running?: boolean;
    applying?: boolean;
    onApply: (excluded: Set<string>) => void;
    onDiscard?: () => void;
    onPreview?: () => void;
    realOutputById?: OutputLookup | null;
}

/** Every step's label by id, from the proposal and what it replaces (a removed step keeps its name). */
function labelsOf(proposal: CardProposal, t: Translator): StepLabels {
    const all: StepLabels = new Map();
    const add = (def: FlowDefinition | null | undefined) => {
        if (!def) return;
        for (const [id, label] of stepLabelsOf(def, t)) if (!all.has(id)) all.set(id, label);
        for (const layer of Object.values(def.layers || {})) add(layer);
    };
    add(proposal.definition);
    add(proposal.baseDefinition);
    return all;
}

/** A change's step as the canvas names it: its label, its type's palette label, or "How it starts". */
function stepName(change: ProposalChange, labels: StepLabels, t: Translator): string {
    const step = (change.after || change.before) as FlowStep | undefined;
    if (step?.label) return step.label;
    return labels.get(change.id) || nodeTypeLabel(step?.type, t) || plainTerm('a_step', t);
}

/** A change inside a flowlet says which one, by its title. */
function scopeName(proposal: CardProposal, scope: string): string {
    if (!scope) return '';
    const layer = proposal.definition?.layers?.[scope] || proposal.baseDefinition?.layers?.[scope];
    return (layer as { title?: string } | undefined)?.title || '';
}

// `applying` is the request in flight: with new tables it creates them,
// which a second click must not repeat, so both buttons wait for it.
// onApply gets the Set of unticked fields; the caller merges them into the
// definition the server returns (the server, not this card, owns table ids).
//
// Everything the person reads here is in the plain vocabulary
// (plainVocabulary.ts): "Preview of the change", fields by name, a reference
// as "uses Email from "Read the form"". The step ids and the raw bindings stay
// behind each change's Details.
export default function ProposalCard({ proposal, running, applying = false, onApply, onDiscard, onPreview, realOutputById }: Props) {
    const { t } = useTranslation();
    const [excluded, setExcluded] = useState<Set<string>>(new Set());
    if (!proposal) return null;
    const samples = { trigger: { output: realOutputById?.get(proposal.baseDefinition?.trigger?.id) }, steps: Object.fromEntries([...(realOutputById || new Map())].map(([id, output]) => [id, { output }])) };
    const changes = proposalChanges(proposal.baseDefinition, proposal.definition);
    const labels = labelsOf(proposal, t);
    const newTables = Array.isArray(proposal.pendingDatatables) ? proposal.pendingDatatables.length : 0;
    // The table a step uses, by name; a staged one says it is new.
    const tableOf = (change: ProposalChange) => {
        if (change.after?.type !== 'datatable') return null;
        const used = (proposal.usedDatatables || []).find((u: UsedTable) => Array.isArray(u.stepIds) && u.stepIds.includes(change.id));
        if (!used) return null;
        const name = used.pending ? t('automations.assistant.table_new_label', '{name} (new)', { name: used.name }) : used.name;
        return t('automations.assistant.table_label', 'Table: {name}', { name });
    };
    const toggle = (key: string) => setExcluded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; });
    const busy = running || applying;
    return <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden text-xs" data-testid="assistant-proposal">
        <div className="px-3 py-2.5 border-b border-[var(--border-default)] font-semibold flex justify-between"><span>{t('handover.proposal.title', 'Preview of the change')}</span><span className="font-normal text-[var(--text-tertiary)]">{changes.length + newTables} {t('automations.assistant.changes', 'changes')}</span></div>
        <div className="p-3 space-y-2">
            <ProposalTables proposal={proposal} />
            {changes.map((c: ProposalChange) => {
                const fields = proposalFields(c);
                const where = scopeName(proposal, c.scope);
                return <div key={`${c.scope}:${c.id}`} className="flex gap-2 items-start"><span className="text-[var(--type-ai)] font-semibold">{c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'}</span><span className="min-w-0 flex-1"><span className="block font-medium">{stepName(c, labels, t)}</span><span className="block text-[var(--text-tertiary)]">{where ? `${where} · ` : ''}{t(`automations.assistant.${c.kind}`, c.kind === 'added' ? 'New step' : c.kind === 'removed' ? 'Removed step' : 'Settings changed')}</span>
                    {tableOf(c) && <span className="block text-[var(--text-tertiary)]">{tableOf(c)}</span>}
                    {fields.map((field: FieldChange) => {
                        const key = `${c.scope}:${c.id}:${field.path.join('.')}`;
                        const name = fieldPathLabel(field.path);
                        const oldSample = (field.before as Binding)?.kind && previewBinding(field.before as Binding, samples, { raw: false });
                        const newSample = (field.after as Binding)?.kind && previewBinding(field.after as Binding, samples, { raw: false });
                        return <label key={key} className="flex gap-2 mt-2 rounded-lg bg-[var(--bg-secondary)] p-2 cursor-pointer">
                            <input type="checkbox" checked={!excluded.has(key)} onChange={() => toggle(key)} aria-label={name} className="mt-0.5" />
                            <span className="min-w-0 flex-1 break-words"><span className="block font-medium">{name}</span><span className="block text-[var(--text-tertiary)]">{describeBinding(field.before, labels, t)}</span>{oldSample && <span className="block text-[var(--text-tertiary)]">↳ {oldSample}</span>}<span className="block text-[var(--type-ai)]">→ {describeBinding(field.after, labels, t)}</span>{newSample && <span className="block">↳ {newSample}</span>}</span>
                        </label>;
                    })}
                    <ChangeDetails change={c} fields={fields} />
                </span></div>;
            })}
            <p className="text-[var(--text-tertiary)] leading-4">{t('automations.assistant.preview_hint', 'Nothing has changed yet. The dashed cards on the canvas are a preview.')}</p>
            <p className="text-[var(--text-tertiary)] leading-4">{t('handover.proposal.apply_hint', 'Saying yes in the chat does not make this change. Press Make the change to apply it, or Discard to drop it. The assistant hears which one you chose.')}</p>
        </div>
        <div className="flex flex-wrap gap-1.5 px-3 pb-3">
            <button type="button" disabled={busy} onClick={() => onApply(excluded)} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 bg-[var(--text-primary)] text-[var(--bg-primary)] disabled:opacity-50"><Check size={12} />{applying && newTables ? t('automations.assistant.applying_tables', 'Creating table…') : t('handover.proposal.apply', 'Make the change')}</button>
            <button type="button" disabled={busy} onClick={onDiscard} className="rounded-lg px-2 py-1.5 hover:bg-[var(--bg-secondary)]">{t('automations.assistant.discard', 'Discard')}</button>
            <button type="button" onClick={onPreview} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-[var(--bg-secondary)]"><Eye size={12} />{t('automations.assistant.preview', 'Preview')}</button>
        </div>
    </div>;
}

/** The raw side of one change, for whoever needs it: the step id and each field's path and stored value. */
function ChangeDetails({ change, fields }: { change: ProposalChange; fields: FieldChange[] }) {
    const { t } = useTranslation();
    return <details className="mt-1 text-[var(--text-tertiary)]" data-testid="proposal-change-details">
        <summary className="cursor-pointer select-none">{t('handover.proposal.details', 'Details')}</summary>
        <div className="mt-1 font-mono text-[10px] break-all space-y-1">
            <div>{t('handover.proposal.step_id', 'Step id')}: {change.id}{change.scope ? ` (${change.scope})` : ''}</div>
            {fields.map((f) => <div key={f.path.join('.')}>{f.path.join('.')}: {JSON.stringify(f.before) ?? '—'} → {JSON.stringify(f.after) ?? '—'}</div>)}
        </div>
    </details>;
}
