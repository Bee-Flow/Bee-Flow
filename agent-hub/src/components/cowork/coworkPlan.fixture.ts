// The plan the Cowork plan tests share: "Supplier radar", as /api/cowork/:id/plan answers it for the running
// example of the server's plan tests (server/core/cowork/plan/plan.testkit.js).
import type { PlanDraft, PlanState, PlanStep } from '../../api/coworkPlan.types';
import type { TranslateFn } from '../../hooks/useTranslation';

/** The English fallback with its {params} filled in, as the real hook answers without a dictionary. */
export const englishT: TranslateFn = (_key, fallback, params) => {
    const text = typeof fallback === 'string' ? fallback : '';
    const values = (typeof fallback === 'object' ? fallback : params) || {};
    return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String((values as Record<string, unknown>)[k]) : m));
};

const step = (id: string, kind: PlanStep['kind'], title: string, over: Partial<PlanStep> = {}): PlanStep => ({
    id, type: 'integration_action', kind, title, effect: 'reads', app: null, tool: null, readsOutsideText: false, depth: 0, ...over,
});

export function supplierRadarDraft(): PlanDraft {
    return {
        view: {
            trigger: 'schedule',
            steps: [
                step('mail', 'fixed', 'Get the new supplier mail', { app: 'outlook', tool: 'outlook_search' }),
                step('orders', 'ai', 'Read each mail and pick out the order', { type: 'data_extraction', readsOutsideText: true }),
                step('overdue', 'fixed', 'Keep what is overdue', { type: 'filter' }),
                step('table', 'fixed', 'Update the Open orders table', { type: 'datatable', effect: 'writes' }),
                step('reply', 'ai', 'Write a reply for each overdue order', { type: 'ai_step', readsOutsideText: true }),
                step('draft', 'fixed', 'Save the replies as drafts', { app: 'outlook', tool: 'outlook_create_draft', effect: 'writes' }),
                step('digest', 'deliver', 'Send me the digest', { type: 'notification', effect: 'sends' }),
            ],
            makeUp: { fixed: 4, ai: 2, ask: 0, deliver: 1 },
        },
        permissions: {
            v: 1,
            grants: [
                { app: 'datatables', effect: 'writes', tools: ['datatable.save_row'] },
                { app: 'outlook', effect: 'reads', tools: ['outlook_search'] },
                { app: 'outlook', effect: 'writes', tools: ['outlook_create_draft'] },
            ],
            sends: 'owner',
            ai: true,
            outsideText: true,
        },
        findings: [],
        fingerprint: 'f'.repeat(64),
    };
}

/** A plan state: by default a plan that was never approved. */
export function planState(over: Partial<PlanState> = {}): PlanState {
    return { automationId: 'auto-1', draft: supplierRadarDraft(), approved: null, widens: ['This plan has not been approved yet.'], upToDate: false, ...over };
}
