/**
 * Who and what a paused run continues as (backgroundRun.mts resumeBackgroundRun).
 *
 * A run on hold goes on unattended: nobody is at the page, and the resume may come from a timer
 * hours or days later. So nothing the run does after the pause rests on what was true when it
 * started. THE RULE, checked at every resume and read fresh from the database (never from the
 * request, never from the stored state except the two values it is compared with):
 *
 *   1. The app exists and its owner's account is active (the owner pays for the run and its
 *      steps act with the app's connections).
 *   2. The run has a starter, and that account exists and is active. A run without a signed-in
 *      starter (an anonymous visitor, an erased account) is never continued.
 *   3. The starter may still open the app: they own it, or it is published and reaches them
 *      through their organisation, a shared group or its project, exactly as the app gate of a
 *      request decides (studioAppRunGate.loadVisibleApp).
 *   4. The run belongs to a definition that is still there: a draft run only for the owner,
 *      with the current draft; any other run with the current PUBLISHED definition. An app that
 *      was unpublished continues nothing.
 *   5. The action the run was started on still exists in that definition, under its id.
 *        - An action that was EDITED does not end the run: the run walks the steps its pause
 *          kept (backgroundRunDurable.mts, the snapshot), because a wait can last days and its
 *          position names a step of the action as it was.
 *        - An action that was REMOVED ends the run (`action_removed`): the author took the
 *          thing away, and nothing in the app can start, show or gate it any more.
 *        - An action the run CALLS that was removed, or the run's action no longer being a
 *          server run or a sequence, is an edit: the run goes on in its snapshot.
 *   6. The starter's role, resolved again (membership, group mapping, default), is the role the
 *      run started with, and that role can still reach the action in the definition as it is
 *      now. The run goes on with that identity and role: a demoted, promoted or removed
 *      member's run does not continue.
 *
 * What the run reads and writes after the pause follows today's app, never the snapshot: the
 * data model and its row rules, the declared variables, the documents, the connections.
 *
 * A run that fails the rule ends as `refused` with a code and a sentence that names no person.
 * The answer here is only read; the caller ends the row.
 */

import { createRequire } from 'node:module';
import { ownAction } from './actionCalls.mts';
import type { App, StartInput } from './backgroundRunParts.mts';
import type { ActionRunRow } from '../stores/studioAppData/actionRuns.mts';

const nodeRequire = createRequire(import.meta.url);

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What a pause keeps about the run beside the walk and its actions: compared at resume (the role) or carried on (the rest). */
export type RunMeta = {
    role: string | null;
    /** Milliseconds the run was really running before this pause (the run-time limit counts these). */
    activeMs: number;
    /** The names of the variables the run wrote so far. */
    written: string[];
};

export type ResumeRefusal = { ok: false; code: string; error: string };
export type ResumeContext = { ok: true; input: StartInput } | ResumeRefusal;

type UserRow = Obj & { id: string; status?: string | null; organizationId?: string | null };
type AppRow = App & {
    isPublished?: boolean; definition?: Obj | null; publishedDefinition?: Obj | null; projectId?: string | null; sharedGroups?: unknown;
};

export type IdentityDeps = {
    getApp: (appId: string) => Promise<AppRow | null>;
    getUser: (userId: string) => Promise<UserRow | null>;
    isActiveAccount: (user: unknown) => boolean;
    /** The starter's groups and organisations, as the app gate reads them. */
    audienceOf: (user: UserRow) => Promise<{ userGroups: string[]; orgIds: string[] }>;
    canReadApp: (app: AppRow, userId: string, userGroups: string[], orgIds: string[]) => Promise<boolean>;
    getModel: (app: AppRow) => Promise<unknown>;
    resolveRole: (app: AppRow, userId: string, model: unknown, audience: { userGroups: string[] }) => Promise<string | null>;
    roleAccess: (def: Obj, actionId: string, role: string | null) => { referenced: boolean; allowed: boolean };
};

const GONE = 'The app is no longer published, so the run that was waiting was ended.';
const PERSON = 'Whoever started this run can no longer use this action, so the run that was waiting was ended.';
const REMOVED = 'The action was removed from the app while this run was waiting, so the run was ended.';
const refuse = (code: string, error: string): ResumeRefusal => ({ ok: false, code, error });

/** The real stores, each loaded when first asked (a test that injects every reader loads none). */
function defaultDeps(): IdentityDeps {
    const users = () => nodeRequire('../stores/userStore') as { getUser: IdentityDeps['getUser']; getAllGroups: () => Promise<unknown[]> };
    const apps = () => nodeRequire('../stores/studioAppStore') as { getStudioApp: IdentityDeps['getApp']; canReadStudioAppAsync: IdentityDeps['canReadApp'] };
    return {
        getApp: (appId) => apps().getStudioApp(appId),
        getUser: (userId) => users().getUser(userId),
        isActiveAccount: (user) => (nodeRequire('../auth/accountStatusGate') as { isActiveAccount: (u: unknown) => boolean }).isActiveAccount(user),
        audienceOf: async (user) => {
            const { resolveUserGroups } = nodeRequire('../auth/audience') as { resolveUserGroups: (id: string) => Promise<string[]> };
            const { orgIdsForUser } = nodeRequire('../auth/orgMembership') as { orgIdsForUser: (u: unknown, groups: unknown[]) => Set<string> };
            return { userGroups: await resolveUserGroups(user.id), orgIds: [...orgIdsForUser(user, await users().getAllGroups())] };
        },
        canReadApp: (app, userId, userGroups, orgIds) => apps().canReadStudioAppAsync(app, userId, userGroups, orgIds),
        getModel: async (app) => {
            const store = nodeRequire('../stores/studioAppDataStore') as { getDataModel: (appId: string, ownerId: string) => Promise<{ model?: unknown } | null> };
            const meta = await store.getDataModel(app.id, app.userId);
            return meta && meta.model ? meta.model : null;
        },
        resolveRole: async (app, userId, model, audience) => {
            const gateway = nodeRequire('./rlsGateway') as { resolveViewerRole: (a: unknown, u: string, m: unknown, au: unknown) => Promise<string | null> };
            return (await gateway.resolveViewerRole(app, userId, model, audience)) || null;
        },
        roleAccess: (def, actionId, role) => (nodeRequire('../routes/studioAppRunGate') as { actionRoleAccess: IdentityDeps['roleAccess'] }).actionRoleAccess(def, actionId, role),
    };
}

/** Rules 1 to 3: the app, its owner, the starter and their way into the app. */
async function whoContinues(row: ActionRunRow, deps: IdentityDeps): Promise<{ app: AppRow; starter: UserRow; userGroups: string[] } | ResumeRefusal> {
    const app = await deps.getApp(row.appId);
    if (!app) return refuse('app_gone', GONE);
    if (!deps.isActiveAccount(await deps.getUser(app.userId))) return refuse('owner_inactive', 'The account that owns the app is not active, so the run that was waiting was ended.');
    const starter = row.viewerUserId ? await deps.getUser(row.viewerUserId) : null;
    if (!starter || !deps.isActiveAccount(starter)) return refuse('starter_gone', PERSON);
    if (app.userId === starter.id) return { app, starter, userGroups: [] };
    const { userGroups, orgIds } = await deps.audienceOf(starter);
    if (!(await deps.canReadApp(app, starter.id, userGroups, orgIds))) return refuse(app.isPublished ? 'no_access' : 'unpublished', app.isPublished ? PERSON : GONE);
    return { app, starter, userGroups };
}

/** Rules 4 and 5: the definition the run belongs to, with its action still in it. */
function whatContinues(row: ActionRunRow, app: AppRow, isOwner: boolean): { def: Obj } | ResumeRefusal {
    if (row.draft && !isOwner) return refuse('no_access', PERSON);
    if (!row.draft && !app.isPublished) return refuse('unpublished', GONE);
    const def = row.draft ? app.definition : app.publishedDefinition;
    if (!isObject(def)) return refuse('unpublished', GONE);
    if (!ownAction(def.actions, row.actionId)) return refuse('action_removed', REMOVED);
    return { def };
}

/** The context a paused run continues with, or why it may not (the rule in the header). */
export async function loadResumeContext(row: ActionRunRow, meta: RunMeta, given: Partial<IdentityDeps> = {}): Promise<ResumeContext> {
    const deps = { ...defaultDeps(), ...given };
    const who = await whoContinues(row, deps);
    if ('ok' in who) return who;
    const { app, starter, userGroups } = who;
    const isOwner = app.userId === starter.id;
    const what = whatContinues(row, app, isOwner);
    if ('ok' in what) return what;
    // Rule 6: the role today is the role the run started with, and it still reaches the action.
    const model = await deps.getModel(app);
    const role = await deps.resolveRole(app, starter.id, model, { userGroups });
    if (role !== meta.role) return refuse('role_changed', PERSON);
    if (!isOwner && role !== 'owner') {
        if (!deps.roleAccess(what.def, row.actionId, role).allowed) return refuse('role_denied', PERSON);
    }
    const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
    return {
        ok: true,
        input: {
            // The whole app row, as a request's start passes it: the executor reads more of it than the runner does.
            app, def: what.def, model, actionId: row.actionId, role, isOwner, draft: row.draft, definitionVersion: row.definitionVersion,
            viewer: { id: starter.id, name: text(starter.name) ?? text(starter.username), email: text(starter.email), organizationId: text(starter.organizationId) },
            scope: {},
        },
    };
}
