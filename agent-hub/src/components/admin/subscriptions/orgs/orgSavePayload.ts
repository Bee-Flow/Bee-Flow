import { LIMIT_FIELDS } from '../constants';

/** The editable part of an organization subscription, as the editor holds it. */
export interface OrgForm {
    plan_id: string;
    status: string;
    max_cost_per_month: number | '' | null;
    max_users: number | '' | null;
    max_agents: number | '' | null;
    max_knowledge_sources: number | '' | null;
    allowed_features: string[] | null;
    notes: string;
}

const LIMIT_KEYS = new Set<string>(LIMIT_FIELDS.map(f => f.key));

/**
 * The PUT body for a save: only the fields the admin changed.
 *
 * Sending the loaded limit values back unchanged would turn a stale override
 * (say the Free plan's 5 agents) into an explicit write, and an explicit limit
 * is exactly what stops the server from clearing stale overrides when the plan
 * is (re)assigned (BFSF-249).
 *
 * "Override" switched on but left empty ('') is no override: it goes as null,
 * because the server would read '' as a cap of 0.
 */
export function orgSavePayload(initial: OrgForm, form: OrgForm): Partial<Record<keyof OrgForm, unknown>> {
    const payload: Partial<Record<keyof OrgForm, unknown>> = {};
    for (const key of Object.keys(form) as Array<keyof OrgForm>) {
        const normalise = (v: unknown) => (LIMIT_KEYS.has(key) && v === '' ? null : v);
        const before = normalise(initial[key]);
        const after = normalise(form[key]);
        if (JSON.stringify(before) !== JSON.stringify(after)) payload[key] = after;
    }
    return payload;
}
