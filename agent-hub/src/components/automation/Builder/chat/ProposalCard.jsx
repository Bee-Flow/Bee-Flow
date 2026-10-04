import { useState } from 'react';
import previewBinding from '../mapping/bindingPreview';
import { Check, Eye } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import { proposalChanges, proposalFields, reviewedProposal } from './proposalChanges';

export default function ProposalCard({ proposal, running, onApply, onDiscard, onPreview, realOutputById }) {
    const { t } = useTranslation();
    const [excluded, setExcluded] = useState(new Set());
    if (!proposal) return null;
    const samples = { trigger: { output: realOutputById?.get(proposal.baseDefinition?.trigger?.id) }, steps: Object.fromEntries([...(realOutputById || new Map())].map(([id, output]) => [id, { output }])) };
    const changes = proposalChanges(proposal.baseDefinition, proposal.definition);
    return <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden text-xs" data-testid="assistant-proposal">
        <div className="px-3 py-2.5 border-b border-[var(--border-default)] font-semibold flex justify-between"><span>{t('automations.assistant.proposal', 'Proposal')}</span><span className="font-normal text-[var(--text-tertiary)]">{changes.length} {t('automations.assistant.changes', 'changes')}</span></div>
        <div className="p-3 space-y-2">
            {changes.map(c => <div key={`${c.scope}:${c.id}`} className="flex gap-2 items-start"><span className="text-[var(--type-ai)] font-semibold">{c.kind === 'added' ? '+' : c.kind === 'removed' ? '−' : '~'}</span><span className="min-w-0 flex-1"><span className="block font-medium">{c.label}</span><span className="block text-[var(--text-tertiary)]">{c.scope ? `${c.scope} · ` : ''}{t(`automations.assistant.${c.kind}`, c.kind === 'added' ? 'New step' : c.kind === 'removed' ? 'Removed step' : 'Settings changed')}</span>
                {proposalFields(c).map(field => {
                    const key = `${c.scope}:${c.id}:${field.path.join('.')}`;
                    const value = binding => binding === undefined ? '—' : binding?.kind ? binding.path || String(binding.value ?? '') : typeof binding === 'string' ? binding : JSON.stringify(binding);
                    const oldSample = field.before?.kind && previewBinding(field.before, samples, { raw: false });
                    const newSample = field.after?.kind && previewBinding(field.after, samples, { raw: false });
                    return <label key={key} className="flex gap-2 mt-2 rounded-lg bg-[var(--bg-secondary)] p-2 cursor-pointer">
                        <input type="checkbox" checked={!excluded.has(key)} onChange={() => setExcluded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })} aria-label={field.path.join('.')} className="mt-0.5" />
                        <span className="min-w-0 flex-1 break-words"><span className="block font-medium">{field.path.slice(1).join(' › ')}</span><span className="block text-[var(--text-tertiary)]">{value(field.before)}</span>{oldSample && <span className="block text-[var(--text-tertiary)]">↳ {oldSample}</span>}<span className="block text-[var(--type-ai)]">→ {value(field.after)}</span>{newSample && <span className="block">↳ {newSample}</span>}</span>
                    </label>;
                })}
            </span></div>)}
            <p className="text-[var(--text-tertiary)] leading-4">{t('automations.assistant.preview_hint', 'Nothing has changed yet. The dashed cards on the canvas are a preview.')}</p>
        </div>
        <div className="flex flex-wrap gap-1.5 px-3 pb-3">
            <button type="button" disabled={running} onClick={() => onApply(reviewedProposal(proposal, excluded))} className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 bg-[var(--text-primary)] text-[var(--bg-primary)] disabled:opacity-50"><Check size={12} />{t('automations.assistant.apply', 'Apply')}</button>
            <button type="button" disabled={running} onClick={onDiscard} className="rounded-lg px-2 py-1.5 hover:bg-[var(--bg-secondary)]">{t('automations.assistant.discard', 'Discard')}</button>
            <button type="button" onClick={onPreview} className="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 hover:bg-[var(--bg-secondary)]"><Eye size={12} />{t('automations.assistant.preview', 'Preview')}</button>
        </div>
    </div>;
}
