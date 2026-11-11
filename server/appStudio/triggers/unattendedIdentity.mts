/**
 * Who and what an unattended run is: a run a trigger starts, with nobody at the page.
 *
 * A click has a person: a session, a role, a page that shows what happens. A trigger has none of
 * that, and it fires long after the owner looked. So nothing a trigger run does rests on what was
 * true when the app was published. THE RULE, checked at every fire (and again when a run that
 * waited goes on), read fresh from the database and never from the armed row except the three
 * values it is compared with (the owner, the trigger id, the fingerprint):
 *
 *   1. The app exists, IS PUBLISHED and has a published definition. A draft never runs, and an
 *      app that was unpublished runs nothing.
 *   2. The app still belongs to the account the trigger was armed for, and that account is
 *      active. A deactivated or erased owner's triggers do not fire.
 *   3. The owner still has App Studio (the capability: licence and module), as a request of
 *      theirs would be gated.
 *   4. The trigger is in the published definition, switched on, and exactly what was armed: its
 *      kind, its own fields, its action and every action that one calls (triggerSpec.mts
 *      triggerFingerprint). A published copy that changed without a publish (a deploy, a restore
 *      written straight to the row) arms nothing: the trigger is disarmed until someone publishes.
 *   5. Every step of the action may run unattended (unattendedPolicy.mts), checked on the
 *      published definition of this moment.
 *   6. THE RUN IS THE OWNER. Its viewer is the owner's account, its role is `owner`, resolved by
 *      the same resolver a request uses. There is no visitor, so `viewer.*` in a formula or a row
 *      rule (id, e-mail, groups, organisation) is the owner's. Whoever caused the fire (a clock
 *      now; a changed record or a call from outside in a later kind) is never the run's
 *      identity and gets nothing of its rights.
 *
 * What follows from 6, and is deliberate: a trigger run reads and writes what the owner can
 * (every row), sends e-mail from the mailbox the owner connected (inside that mailbox's daily
 * limit), starts the owner's automations and files approvals in the owner's name. That is why
 * only the owner can publish, why a draft arms nothing, and why the steps a run may carry are a
 * closed list (unattendedPolicy.mts says what it may NOT do). Personal data still leaves
 * Bee Flow only by e-mail: every step applies its own outbound checks as on a click.
 *
 * A refusal says whether the armed row is STALE (it no longer matches what is published: the
 * caller disarms it) or only held back for now (the owner's account, the capability: the trigger
 * stays armed and the next fire asks again).
 */

import { createRequire } from 'node:module';
import { ownAction } from '../actionCalls.mts';
import type { RunMeta } from '../backgroundRunIdentity.mts';
import type { App, StartInput } from '../backgroundRunParts.mts';
import type { ActionRunRow } from '../../stores/studioAppData/actionRuns.mts';
import { chainRefusedKinds } from './recordTriggerRule.mts';
import { refusedKindsOf, triggerKind } from './triggerKinds.mts';
import { readTriggers, triggerFingerprint } from './triggerSpec.mts';
import type { AppTrigger } from './triggerSpec.mts';
import { unattendedActionProblems } from './unattendedPolicy.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

type UserRow = Obj & { id: string; status?: string | null; organizationId?: string | null };
type AppRow = App & { isPublished?: boolean; publishedDefinition?: Obj | null; publishedVersion?: number | null };

/** What a fire is checked against: the armed row's owner, trigger and fingerprint. */
export type ArmedRef = {
    appId: string; triggerId: string; ownerUserId: string; fingerprint: string;
    /** Step kinds this one fire refuses besides: what the chain it is in refuses (recordTriggerRule.mts rule 6). */
    refusedKinds?: readonly string[];
};

export type UnattendedRefusal = { ok: false; code: string; error: string; stale: boolean };
export type UnattendedContext = { ok: true; input: StartInput; trigger: AppTrigger } | UnattendedRefusal;

export type UnattendedDeps = {
    getApp: (appId: string) => Promise<AppRow | null>;
    getUser: (userId: string) => Promise<UserRow | null>;
    isActiveAccount: (user: unknown) => boolean;
    /** Does this owner still have App Studio (licence and module), as a request of theirs is gated? */
    hasAppStudio: (owner: { userId: string; orgId: string | null }) => Promise<boolean>;
    getModel: (app: AppRow) => Promise<unknown>;
    resolveRole: (app: AppRow, userId: string, model: unknown) => Promise<string | null>;
    /** The `trigger` root of a run that goes on after a wait (a kind that hands its action one; recordDrain.mts), or null. */
    resumeScope: (runId: string, trigger: AppTrigger) => Promise<Obj | null>;
};

const stale = (code: string, error: string): UnattendedRefusal => ({ ok: false, code, error, stale: true });
const held = (code: string, error: string): UnattendedRefusal => ({ ok: false, code, error, stale: false });

const UNPUBLISHED = 'The app is not published, so its triggers do not run.';
const GONE = 'The trigger that started this run is no longer in the published app, so the run that was waiting was ended.';
const CHANGED = 'The published app changed since this trigger was armed. Publish the app to arm it again.';

/** The real stores, each loaded when first asked (a test that injects every reader loads none). */
function defaultDeps(): UnattendedDeps {
    return {
        getApp: (appId) => (nodeRequire('../../stores/studioAppStore') as { getStudioApp: UnattendedDeps['getApp'] }).getStudioApp(appId),
        getUser: (userId) => (nodeRequire('../../stores/userStore') as { getUser: UnattendedDeps['getUser'] }).getUser(userId),
        isActiveAccount: (user) => (nodeRequire('../../auth/accountStatusGate') as { isActiveAccount: (u: unknown) => boolean }).isActiveAccount(user),
        hasAppStudio: ({ userId, orgId }) => (nodeRequire('../../core/entitlements/entitlements') as { hasCapability: (id: string, ctx: Obj) => Promise<boolean> }).hasCapability('app_studio', { userId, orgId }),
        getModel: async (app) => {
            const store = nodeRequire('../../stores/studioAppDataStore') as { getDataModel: (appId: string, ownerId: string) => Promise<{ model?: unknown } | null> };
            const meta = await store.getDataModel(app.id, app.userId);
            return meta && meta.model ? meta.model : null;
        },
        resolveRole: async (app, userId, model) => {
            const gateway = nodeRequire('../rlsGateway') as { resolveViewerRole: (a: unknown, u: string, m: unknown, au: unknown) => Promise<string | null> };
            return (await gateway.resolveViewerRole(app, userId, model, {})) || null;
        },
        resumeScope: (runId, trigger) => (nodeRequire('./recordDrain.mts') as { resumeScope: UnattendedDeps['resumeScope'] }).resumeScope(runId, trigger),
    };
}

/** The real readers, for a module that checks the owner the same way (triggers/deploySync.mts). */
export { defaultDeps as unattendedReaders };

/** Rules 1 to 3: the published app, its owner, and the owner's App Studio. */
async function publishedAppOf(appId: string, ownerUserId: string, deps: UnattendedDeps): Promise<{ app: AppRow; def: Obj; owner: UserRow } | UnattendedRefusal> {
    const app = await deps.getApp(appId);
    if (!app) return stale('app_gone', UNPUBLISHED);
    if (!app.isPublished || !isObject(app.publishedDefinition)) return stale('unpublished', UNPUBLISHED);
    if (app.userId !== ownerUserId) return stale('owner_changed', 'The app has another owner than when this trigger was armed. Publish the app to arm it again.');
    const owner = await deps.getUser(app.userId);
    if (!owner || !deps.isActiveAccount(owner)) return held('owner_inactive', 'The account that owns the app is not active, so its triggers do not run.');
    if (!(await deps.hasAppStudio({ userId: owner.id, orgId: app.organizationId || null }))) {
        return held('capability_off', 'App Studio is not available to the owner of this app right now, so its triggers do not run.');
    }
    return { app, def: app.publishedDefinition, owner };
}

/** Rules 4 and 5 for a trigger of the published definition (its fingerprint is the caller's to compare). */
function triggerOf(def: Obj, triggerId: string, chainRefused: readonly string[]): { trigger: AppTrigger } | UnattendedRefusal {
    const trigger = readTriggers(def).find((t) => t.id === triggerId);
    if (!trigger || trigger.enabled === false || !triggerKind(trigger.kind)) return stale('trigger_gone', CHANGED);
    const action = ownAction(def.actions, trigger.actionId);
    const problems = unattendedActionProblems(action, trigger.actionId, {
        resolveCalled: (id) => ownAction(def.actions, id), refusedKinds: [...refusedKindsOf(triggerKind(trigger.kind), trigger), ...chainRefused],
    });
    if (problems.length) return held('not_unattended', problems[0].message);
    return { trigger };
}

/** Rule 6: the run's identity. The viewer is the owner; anything else than role `owner` refuses. */
async function ownerInput(found: { app: AppRow; def: Obj; owner: UserRow }, trigger: AppTrigger, deps: UnattendedDeps, chainRefused: readonly string[] = []): Promise<StartInput | UnattendedRefusal> {
    const { app, def, owner } = found;
    const model = await deps.getModel(app);
    const role = await deps.resolveRole(app, owner.id, model);
    if (role !== 'owner') return held('owner_role', 'The owner of the app could not be confirmed, so the trigger did not run.');
    const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    return {
        // The whole app row, as a request's start passes it: the executor reads more of it than the runner does.
        app, def, model, actionId: trigger.actionId, role, isOwner: true, draft: false,
        definitionVersion: typeof app.publishedVersion === 'number' ? app.publishedVersion : null,
        viewer: { id: owner.id, name: text(owner.name) ?? text(owner.username), email: text(owner.email), organizationId: text(owner.organizationId) },
        scope: {},
        unattended: { refusedKinds: [...refusedKindsOf(triggerKind(trigger.kind), trigger), ...chainRefused], ...chainStartOf(trigger) },
    };
}

/** How this trigger starts a chain of runs, when a call from outside or a stranger's write can start it (recordTriggerRule.mts rule 6). */
function chainStartOf(trigger: AppTrigger): { start?: 'public' | 'webhook' } {
    if (trigger.kind === 'webhook') return { start: 'webhook' };
    return trigger.kind === 'record' && trigger.allowPublicWrites === true ? { start: 'public' } : {};
}

/** What a fire of the armed trigger runs as, or why it does not run (the rule in the header). */
export async function loadUnattendedContext(armed: ArmedRef, given: Partial<UnattendedDeps> = {}): Promise<UnattendedContext> {
    const deps = { ...defaultDeps(), ...given };
    const found = await publishedAppOf(armed.appId, armed.ownerUserId, deps);
    if ('ok' in found) return found;
    const chainRefused = armed.refusedKinds ?? [];
    const what = triggerOf(found.def, armed.triggerId, chainRefused);
    // Rule 4 before rule 5: a trigger that is not what was armed is stale, whatever its steps are.
    const trigger = 'trigger' in what ? what.trigger : readTriggers(found.def).find((t) => t.id === armed.triggerId);
    if (trigger && triggerFingerprint(found.def, trigger) !== armed.fingerprint) return stale('definition_changed', CHANGED);
    if ('ok' in what) return what;
    const input = await ownerInput(found, what.trigger, deps, chainRefused);
    return 'ok' in input ? input : { ok: true, input, trigger: what.trigger };
}

/**
 * A trigger run that was on hold and goes on (backgroundRunResume.mts). Rules 1 to 3 and 6 are
 * read again. For what it runs, the rule of every paused run holds (backgroundRunIdentity.mts
 * rule 5): the run walks the actions its pause kept, so an edited action does not end it, but
 * the trigger must still be in the published definition and switched on, and its action must
 * still exist there (`trigger_gone`, `action_removed`: the author took it away). The steps of
 * the kept actions are still refused one by one when they may not run unattended (the run stays
 * marked `unattended`). A run that may not go on ends as `refused`.
 */
export async function loadUnattendedResumeContext(row: ActionRunRow, meta: RunMeta, given: Partial<UnattendedDeps> = {}): Promise<{ ok: true; input: StartInput } | { ok: false; code: string; error: string }> {
    const deps = { ...defaultDeps(), ...given };
    const no = (code: string, error: string) => ({ ok: false as const, code, error });
    if (!row.triggerId || row.draft || meta.role !== 'owner') return no('trigger_gone', GONE);
    const found = await publishedAppOf(row.appId, row.ownerUserId, deps);
    if ('ok' in found) return no(found.code, found.error);
    const trigger = readTriggers(found.def).find((t) => t.id === row.triggerId);
    if (!trigger || trigger.enabled === false || !triggerKind(trigger.kind)) return no('trigger_gone', GONE);
    if (!ownAction(found.def.actions, row.actionId)) return no('action_removed', 'The action was removed from the app while this run was waiting, so the run was ended.');
    const scope = await deps.resumeScope(row.id, trigger);
    // The chain the run is in is read again from its root: what it refused before the wait, it refuses after it.
    const input = await ownerInput(found, { ...trigger, actionId: row.actionId }, deps, chainRefusedKinds(scope));
    if ('ok' in input) return no(input.code, input.error);
    return { ok: true, input: scope ? { ...input, scope: { ...input.scope, trigger: scope } } : input };
}
