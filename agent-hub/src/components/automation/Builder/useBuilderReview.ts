import { useState } from 'react';
import { API_BASE, authFetch } from '@/utils/helpers';
import { deepEqual } from '@/utils/deepEqual';
import { toast } from '../../shared/Toast';
import { hasPendingDatatableRefs } from './chat/pendingTables';
import { reviewedProposal } from './chat/proposalChanges';
import { isBlankDefinition } from './flow/normalizeDefinition';
import type useAutomationBuilderStream from '@/hooks/useAutomationBuilderStream';
import type useBuilderHydration from './useBuilderHydration';
import type { FlowDefinition } from './flow/types';


export interface UseBuilderReviewOptions {
    state: ReturnType<typeof useAutomationBuilderStream>['state'];
    serverAutomation: ReturnType<typeof useBuilderHydration>['serverAutomation'];
    effectiveDef: FlowDefinition | null;
    dismissPlan: () => void;
    dismissProposal: () => void;
    onVisualEditRoot: (def: FlowDefinition) => void;
    onSaveAutomation: (patch: Record<string, unknown>) => Promise<void>;
    t: (key: string, fallback?: string, vars?: Record<string, unknown>) => string;
}

/**
 * The AI builder's review cards: Apply or Discard a proposal (Apply may create
 * datatables first) and Reject a plan, each recorded on the server before the
 * card goes. Split out of BuilderShell without a change in behaviour.
 */
export default function useBuilderReview({
    state, serverAutomation, effectiveDef, dismissPlan, dismissProposal, onVisualEditRoot, onSaveAutomation, t,
}: UseBuilderReviewOptions) {
    // An Apply in flight (it may be creating tables): blocks a second Apply and the composer.
    const [applyingProposal, setApplyingProposal] = useState(false);
    // Bumped after Apply created tables, so the canvas refetches the catalog and names them.
    const [catalogNonce, setCatalogNonce] = useState(0);

    // Records the review action on the server. Returns the parsed answer (the
    // Apply of a proposal with new tables carries the definition with the real
    // table ids, `createdDatatables`; a Discard `keptDatatables`), or null when
    // it was refused: then the server's message is shown and nothing is dismissed.
    const clearReview = async (action: string, revisionId: string | null | undefined) => {
        try {
        const aid = state.automationId || serverAutomation?.id;
        let body: { ok?: boolean; message?: string; error?: string; definition?: FlowDefinition; createdDatatables?: { name: string }[]; keptDatatables?: { name: string }[] } = { ok: true };
        if (aid && revisionId) {
            const response = await authFetch(`${API_BASE}/api/automation/builder/session/${encodeURIComponent(aid)}/review`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, revisionId }),
            });
            body = await response.json().catch(() => ({}));
            if (!response.ok) { toast.error(body?.message || body?.error || t('automations.assistant.review_changed', 'The saved review has changed. Reload the latest revision.')); return null; }
        }
        if (action === 'rejectPlan') dismissPlan(); else dismissProposal();
        const kept = Array.isArray(body?.keptDatatables) ? body.keptDatatables : [];
        if (kept.length) toast.info(t('automations.assistant.tables_kept', 'Already created and kept in Studio → Datatables: {names}', { names: kept.map((k: { name: string }) => k.name).join(', ') }));
        return body || { ok: true };
        } catch (error: unknown) { toast.error((error as Error).message || String(error)); return null; }
    };

    // `excluded` is the Set of fields the user unticked on the proposal card.
    // They are reverted on the definition the SERVER answers with: when the
    // proposal creates tables, only that one points at the real table ids.
    const applyProposal = async (excluded: any) => {
        const proposal = state.proposal;
        if (!proposal || state.running || applyingProposal) return;
        if (!deepEqual(effectiveDef, proposal.baseDefinition) && !(isBlankDefinition(effectiveDef) && isBlankDefinition(proposal.baseDefinition))) {
            toast.error(t('automations.assistant.stale_proposal', 'The flow has changed since this proposal. Ask the assistant for an updated proposal.'));
            return;
        }
        setApplyingProposal(true);
        let res;
        try { res = await clearReview('applyProposal', proposal.id as string | undefined); }
        finally { setApplyingProposal(false); }
        if (!res) return;
        const definition = reviewedProposal({ ...proposal, definition: res.definition ?? (proposal.definition as FlowDefinition) }, excluded instanceof Set ? excluded : new Set());
        if (hasPendingDatatableRefs(definition)) {
            toast.error(t('automations.assistant.apply_failed', 'The proposal could not be applied. Nothing was changed.'));
            return;
        }
        onVisualEditRoot(definition);
        if (proposal.title || proposal.description != null) await onSaveAutomation({ title: proposal.title || serverAutomation?.title, description: proposal.description || '' });
        const created = Array.isArray(res.createdDatatables) ? res.createdDatatables : [];
        if (created.length) {
            const names = created.map((c) => `"${c.name}"`).join(', ');
            toast.success(created.length > 1
                ? t('automations.assistant.applied_tables_plural', 'Proposal applied and tables {names} created. Undo reverts the flow changes; the tables stay in Studio → Datatables.', { names })
                : t('automations.assistant.applied_tables', 'Proposal applied and table {names} created. Undo reverts the flow changes; the table stays in Studio → Datatables.', { names }));
            setCatalogNonce(n => n + 1);
        } else {
            toast.success(t('automations.assistant.applied', 'Proposal applied. Undo reverts the flow changes.'));
        }
    };

    return { applyingProposal, catalogNonce, clearReview, applyProposal };
}
