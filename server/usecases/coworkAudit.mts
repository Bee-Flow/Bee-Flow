/**
 * The trail of a Cowork item: who created, changed, paused, deleted it, and who named, approved or took off its plan
 * (routes/coworkAuditRoutes.js writes and reads it). It goes to the organisation's access audit log
 * (stores/user/audit.js, target type `cowork_item`), where an administrator finds it next to every other change.
 *
 * What is written is built from an explicit allow-list, never from the request as a whole: which fields changed by
 * name, and the values of the fields that say WHEN and HOW the work runs (its schedule, whether it is on, its agent,
 * its plan's fingerprint). The text of the work (its title and brief) is marked as changed, never copied.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export const TARGET_TYPE = 'cowork_item';

export type AuditAction =
    | 'cowork.created' | 'cowork.updated' | 'cowork.toggled' | 'cowork.deleted'
    | 'cowork.plan_attached' | 'cowork.plan_approved' | 'cowork.plan_removed' | 'cowork.plan_made'
    | 'cowork.review_handled' | 'cowork.independence_set';

/** Fields whose values may be kept: they say when and how the work runs, not what it is about. */
const VALUE_FIELDS: readonly string[] = Object.freeze([
    'isActive', 'repeatInterval', 'daysOfWeek', 'timeOfDay', 'timezone', 'modelTier', 'agentId', 'triggerKind',
    'nextRunAt', 'enabledApps', 'automationId', 'fingerprint', 'version', 'action', 'level',
]);
/** Fields that are only ever named: their content is the owner's text. */
const NAME_ONLY_FIELDS: readonly string[] = Object.freeze(['title', 'prompt', 'trigger', 'answer']);

export interface AuditChange { changed: string[]; values: Record<string, unknown> }

/** What a change records, from the fields it carried. */
export function changeOf(fields: Record<string, unknown> | null | undefined): AuditChange {
    const out: AuditChange = { changed: [], values: {} };
    for (const [key, value] of Object.entries(fields ?? {})) {
        if (value === undefined) continue;
        if (VALUE_FIELDS.includes(key)) { out.changed.push(key); out.values[key] = value; }
        else if (NAME_ONLY_FIELDS.includes(key)) out.changed.push(key);
    }
    out.changed.sort();
    return out;
}

export interface AuditDeps {
    logAccessAudit: (action: string, targetType: string, targetId: string, changedBy: string, oldValues: unknown, newValues: unknown, organizationId?: string | null) => Promise<unknown>;
    getAccessAuditLog: (opts: { targetType: string; targetId: string; limit: number }) => Promise<Array<Record<string, unknown>>>;
}

const defaults = (): AuditDeps => {
    const users = () => nodeRequire('../stores/userStore.js') as AuditDeps;
    return {
        logAccessAudit: (...args) => users().logAccessAudit(...args),
        getAccessAuditLog: (opts) => users().getAccessAuditLog(opts),
    };
};

/** Write one entry. Never throws: a trail that could not be written never undoes the change it describes. */
export async function recordCowork(action: AuditAction, itemId: string, by: { userId: string; organizationId?: string | null }, fields: Record<string, unknown> | null, deps: AuditDeps = defaults()): Promise<void> {
    try {
        await deps.logAccessAudit(action, TARGET_TYPE, itemId, by.userId, null, changeOf(fields), by.organizationId ?? null);
    } catch {
        // logAccessAudit logs its own failures; nothing here may fail the request.
    }
}

/** One entry of the trail, as its owner reads it. */
export interface TrailEntry { action: string; at: string | null; byYou: boolean; changed: string[]; values: Record<string, unknown> }

export const TRAIL_LIMIT = 100;

/** The trail of one item, newest first. Entries written by someone else (an administrator) say so, without a name. */
export async function trailOf(itemId: string, viewerId: string, deps: AuditDeps = defaults()): Promise<TrailEntry[]> {
    const rows = await deps.getAccessAuditLog({ targetType: TARGET_TYPE, targetId: itemId, limit: TRAIL_LIMIT });
    return rows.map((r) => {
        const recorded = (r.new_values && typeof r.new_values === 'object' ? r.new_values : {}) as Partial<AuditChange>;
        return {
            action: String(r.action),
            at: r.created_at ? new Date(r.created_at as string).toISOString() : null,
            byYou: r.changed_by === viewerId,
            changed: Array.isArray(recorded.changed) ? recorded.changed : [],
            values: recorded.values && typeof recorded.values === 'object' ? recorded.values : {},
        };
    });
}
