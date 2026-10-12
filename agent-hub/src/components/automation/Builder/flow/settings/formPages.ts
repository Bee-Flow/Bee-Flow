import type { FlowDefinition, FlowStep } from '../types';

/**
 * The hosted-form pages of one automation, in the order a visitor meets them:
 * page one is the form trigger, then every `form_page` step as the flow
 * reaches it (a closing page is a `form_page` with mode 'ending').
 */
export interface FormPageEntry {
    id: string;
    kind: 'trigger' | 'page' | 'ending';
    label: string;
    form: Record<string, unknown>;
    /** 'trigger.output' or 'steps.<id>.output' — what a question's answer is bound under. */
    bindingBase: string;
    /** Only a page after the trigger can use `{{…}}`: the trigger renders before anything ran. */
    allowVariables: boolean;
}

const formOf = (s: FlowStep): Record<string, unknown> | null =>
    (s.form && typeof s.form === 'object') ? (s.form as Record<string, unknown>) : null;

export function collectFormPages(definition: FlowDefinition | null | undefined): FormPageEntry[] {
    if (!definition) return [];
    const trigger = definition.trigger || null;
    const steps = (definition.steps || []).filter(s => s?.type === 'form_page' && formOf(s));
    const order = new Map<string, number>();

    // Flow order: a walk from the trigger along the edges; whatever it does not
    // reach (a half-wired page) follows in array order.
    const edges = definition.edges || [];
    const queue: string[] = trigger?.id ? [trigger.id] : [];
    const seen = new Set<string>(queue);
    while (queue.length) {
        const cur = queue.shift() as string;
        order.set(cur, order.size);
        for (const e of edges) {
            if (e?.from === cur && e.to && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
        }
    }
    const ranked = steps
        .map((s, i) => ({ s, rank: order.has(s.id) ? (order.get(s.id) as number) : 1e6 + i }))
        .sort((a, b) => a.rank - b.rank)
        .map(x => x.s);

    const pages: FormPageEntry[] = [];
    const titleOf = (form: Record<string, unknown>, fallback: string) => (typeof form.title === 'string' && form.title.trim()) || fallback;
    if (trigger && trigger.kind === 'form' && formOf(trigger)) {
        const form = formOf(trigger) as Record<string, unknown>;
        pages.push({ id: trigger.id, kind: 'trigger', label: titleOf(form, 'Form'), form, bindingBase: 'trigger.output', allowVariables: false });
    }
    for (const s of ranked) {
        const form = formOf(s) as Record<string, unknown>;
        const ending = s.mode === 'ending';
        const named = typeof s.label === 'string' && s.label.trim() ? s.label.trim() : '';
        pages.push({
            id: s.id,
            kind: ending ? 'ending' : 'page',
            label: named || titleOf(form, ending ? 'Closing page' : 'Page'),
            form,
            bindingBase: `steps.${s.id}.output`,
            allowVariables: true,
        });
    }
    return pages;
}
