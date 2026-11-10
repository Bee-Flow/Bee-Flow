/**
 * The app owner's automations in the shape validate.js expects for
 * opts.ownedAutomations: `{ id, userId, isActive }` with the stored status.
 *
 * One lookup for every place that checks a definition against the owner's
 * automations: the publication gate and the publish check
 * (routes/studioApps/publish.js, runtime.js, via appHelpers) and the AI
 * builder's app_finalize (builderTools/persistence.js).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type OwnedAutomation = { id: string; userId: string; isActive: boolean };

type AutomationRow = { id: string; userId: string; isActive: boolean } | null | undefined;
type AutomationLister = { getAutomationsForUser(userId: string): Promise<AutomationRow[] | null | undefined> };

const automationStore = (): AutomationLister => nodeRequire('../stores/automationStore');

export async function loadOwnedAutomations(ownerId: string, store: AutomationLister = automationStore()): Promise<OwnedAutomation[]> {
    const owned = await store.getAutomationsForUser(ownerId);
    return (owned || []).flatMap((a) => (a ? [a] : [])).map((a) => ({ id: a.id, userId: a.userId, isActive: a.isActive }));
}

const INACTIVE_AUTOMATION = 'action.automation_inactive';

type Finding = { code?: string; severity?: string } & Record<string, unknown>;
type Validation = { ok: boolean; errors: Finding[]; warnings: Finding[] };

const isInactive = (e: Finding | null | undefined): boolean => !!e && e.code === INACTIVE_AUTOMATION;

/**
 * Finalize saves a draft; publishing is what needs every wired automation to be
 * active. So at finalize the validator's "not active" errors are warnings: the
 * builder hears about them there, and the publication gate still refuses them.
 */
export function inactiveAutomationsAsWarnings<V extends Validation>(validation: V): V {
    const inactive = validation.errors.filter(isInactive);
    if (!inactive.length) return validation;
    const errors = validation.errors.filter((e) => !isInactive(e));
    return {
        ...validation,
        ok: errors.length === 0,
        errors,
        warnings: [...validation.warnings, ...inactive.map((e) => ({ ...e, severity: 'warning' }))],
    };
}
