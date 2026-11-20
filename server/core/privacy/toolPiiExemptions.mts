/**
 * Per-app exceptions to the Privacy Shield's tool block lists.
 *
 * The admin picks, per tool class ("Outside tools" = `external`, "Own server" =
 * `internal`), the kinds of personal data a tool may not carry
 * (`toolPiiPolicy.<class>.blockCategories`). That list holds for EVERY tool in
 * the class. An exception narrows it for one app:
 *
 *   toolPiiPolicy.external = {
 *     blockCategories: ['Person', 'Email', 'InternationalBankingAccountNumber'],
 *     appExemptions: { outlook: ['Person', 'Email'] },
 *   }
 *
 * reads "Outlook may receive names and e-mail addresses; IBANs stay blocked for
 * Outlook too, and every other outside tool keeps the whole list".
 *
 * ── What an exception changes ────────────────────────────────────────────
 * Only the block list of a call to THAT app: the argument check before the
 * call and the strip of that tool's result before the model reads it. A
 * category the app may receive is also left in that app's result (the same
 * list decides both halves, as it always has). It changes nothing about
 * "Hide from AI": the model keeps seeing pseudonyms, and the real values are
 * put back just before the call, as they are without an exception. Knowledge
 * passages injected without a tool call have no app and keep the whole list.
 *
 * ── Who the app is ───────────────────────────────────────────────────────
 * Decided here, on the server, from the tool NAME through the tool registry's
 * attribution index (core/agentRuntime/toolPolicy/appIndex.js `appIdForTool`):
 * the same index the agent grants are keyed on. Never from the tool's
 * arguments or anything the model or the client sends. A name the index does
 * not attribute (a built-in tool, an MCP or custom-integration tool, a name
 * whose module did not load, a registry that could not be read) has no app and
 * so gets no exception: fail closed.
 *
 * ── What can never be exempted ───────────────────────────────────────────
 * HARD_BLOCKED_CATEGORIES: API keys and secrets (a credential in a tool call is
 * a credential handed to a third party, and no app needs one to do its work),
 * and passport and driving-licence numbers (identity-document numbers: what an
 * impostor needs, and nothing a mail, calendar or file app has a reason to
 * carry). The save refuses them, and the runtime ignores them even in a row
 * that holds them anyway.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { z } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { CANONICAL_IDS } = nodeRequire('./piiCategories.js') as { CANONICAL_IDS: string[] };
const { isCustomTypeId } = nodeRequire('./customTypes/ids.js') as { isCustomTypeId: (id: unknown) => boolean };

export type ToolClass = 'external' | 'internal';
export const TOOL_CLASSES: readonly ToolClass[] = ['external', 'internal'];

/** appId → the category keys that app may receive although its class blocks them. */
export type AppExemptions = Record<string, string[]>;

/** One class of a resolved or stored `toolPiiPolicy`. */
export interface ClassPolicy {
    blockCategories?: unknown;
    appExemptions?: unknown;
}

export type ToolPolicyLike = Partial<Record<ToolClass, ClassPolicy | null | undefined>> | null | undefined;

/** Never exempted, in any class, for any app (see the header). */
export const HARD_BLOCKED_CATEGORIES: ReadonlySet<string> = new Set([
    'ApiKeyOrSecret',
    'PassportNumber',
    'DriversLicenseNumber',
]);

/** Bounds of one class's exceptions. */
export const MAX_EXEMPT_APPS_PER_CLASS = 50;
export const MAX_EXEMPT_CATEGORIES_PER_APP = 64;

const BUILT_IN: ReadonlySet<string> = new Set(CANONICAL_IDS);

interface AppIndexReader {
    appIdForTool: (toolName: string) => string | null;
    actionsOfApp: (appId: string) => string[];
    appDefersGrants: (appId: string) => boolean;
}

interface RegistryEntry { app?: unknown; label?: unknown }

/** Lazy, so this module stays out of the import cycle orgShield sits in. Tests swap the fields. */
export const _deps = {
    appIndex: (): AppIndexReader => nodeRequire('../agentRuntime/toolPolicy/appIndex.js') as AppIndexReader,
    registryApps: (): RegistryEntry[] => {
        const { featureModule } = nodeRequire('../featureModules.js') as { featureModule: (name: string) => { ALL_TOOL_APPS?: RegistryEntry[] } };
        return featureModule('automation/toolRegistry').ALL_TOOL_APPS || [];
    },
};

const hasOwn = (obj: object, key: string) => Object.prototype.hasOwnProperty.call(obj, key);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * The app a tool call belongs to, for the exceptions; null when it has none.
 * From the tool name and the registry only (see the header).
 */
export function exemptionAppIdForTool(toolName: unknown): string | null {
    if (!isText(toolName)) return null;
    try {
        const appId = _deps.appIndex().appIdForTool(toolName);
        return isText(appId) ? appId : null;
    } catch {
        return null;
    }
}

/** May an exception be stored under this app id? An app that owns tool names in the registry. */
export function isExemptableApp(appId: unknown): boolean {
    if (!isText(appId)) return false;
    try {
        const idx = _deps.appIndex();
        // An app that lends its names to another (`grantsVia`) never owns a name, so an exception on it would decide nothing.
        return !idx.appDefersGrants(appId) && idx.actionsOfApp(appId).length > 0;
    } catch {
        return false;
    }
}

/** An app an exception can be made for, with the tool names it owns. */
export interface ExemptableApp {
    id: string;
    label: string;
    actions: string[];
}

/** Every app of the tool registry an exception can be made for, in registry order. Empty when the registry cannot be read. */
export function listExemptableApps(): ExemptableApp[] {
    let entries: RegistryEntry[];
    try { entries = _deps.registryApps(); } catch { return []; }
    const out: ExemptableApp[] = [];
    for (const entry of entries) {
        const id = entry?.app;
        if (!isText(id) || !isExemptableApp(id) || out.some(a => a.id === id)) continue;
        out.push({ id, label: isText(entry.label) ? entry.label : id, actions: _deps.appIndex().actionsOfApp(id) });
    }
    return out;
}

/** A category key an exception may name: a built-in kind or an org's own type id, never a hard one. */
export function isExemptableCategory(key: unknown): boolean {
    if (!isText(key) || HARD_BLOCKED_CATEGORIES.has(key)) return false;
    return BUILT_IN.has(key) || isCustomTypeId(key);
}

/**
 * The block list that holds for ONE tool call: the class's list minus what the
 * tool's own app may receive. Returns the class's list itself (the same array)
 * when no exception applies, so a policy without exceptions decides exactly as
 * before.
 */
export function effectiveBlockCategories(classPolicy: ClassPolicy | null | undefined, toolName: unknown): unknown[] {
    const list = Array.isArray(classPolicy?.blockCategories) ? classPolicy.blockCategories as unknown[] : [];
    const exemptions = classPolicy?.appExemptions;
    if (list.length === 0 || !exemptions || typeof exemptions !== 'object' || Array.isArray(exemptions)) return list;
    const appId = exemptionAppIdForTool(toolName);
    if (!appId || !hasOwn(exemptions, appId)) return list;
    const allowed = (exemptions as Record<string, unknown>)[appId];
    if (!Array.isArray(allowed)) return list;
    const drop = new Set(allowed.filter((c): c is string => isText(c) && !HARD_BLOCKED_CATEGORIES.has(c)));
    return drop.size ? list.filter(c => !(typeof c === 'string' && drop.has(c))) : list;
}

/**
 * The block list of `toolClass` for ONE call of `toolName` in a resolved
 * `toolPiiPolicy` (orgShield.blockCategoriesForTool re-exports it): every tool
 * loop asks this, through orgShield.isBlockedForTool, toolPiiGate and the
 * streaming agent loop's piiPolicy.
 */
export function blockCategoriesForTool(policy: unknown, toolClass: string, toolName: unknown): string[] {
    const classPolicy = (policy as Record<string, ClassPolicy | null | undefined> | null | undefined)?.[toolClass];
    if (!classPolicy || !Array.isArray(classPolicy.blockCategories)) return [];
    return effectiveBlockCategories(classPolicy, toolName) as string[];
}

/** One class of a stored row as the resolver hands it on: its string list, and its exceptions only when it holds some. */
export function normaliseClassPolicy(v: ClassPolicy | null | undefined): { blockCategories: string[]; appExemptions?: AppExemptions } {
    const blockCategories = Array.isArray(v?.blockCategories) ? (v.blockCategories as unknown[]).filter((c): c is string => typeof c === 'string') : [];
    const appExemptions = normaliseAppExemptions(v?.appExemptions, blockCategories);
    return appExemptions ? { blockCategories, appExemptions } : { blockCategories };
}

/**
 * A stored or sent `appExemptions` as the runtime and the row keep it: only
 * string keys and lists, no hard category, only categories the class actually
 * blocks, no empty entry, within the bounds. Null when nothing is left, so a
 * class without exceptions carries no `appExemptions` key at all.
 */
export function normaliseAppExemptions(raw: unknown, blockCategories: unknown): AppExemptions | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const blocked = new Set(Array.isArray(blockCategories) ? blockCategories.filter(isText) : []);
    if (blocked.size === 0) return null;
    const out: AppExemptions = {};
    let apps = 0;
    for (const [appId, cats] of Object.entries(raw as Record<string, unknown>)) {
        if (apps >= MAX_EXEMPT_APPS_PER_CLASS) break;
        if (!isText(appId) || !Array.isArray(cats)) continue;
        const keep = [...new Set(cats.filter((c): c is string => isText(c) && !HARD_BLOCKED_CATEGORIES.has(c) && blocked.has(c)))]
            .slice(0, MAX_EXEMPT_CATEGORIES_PER_APP);
        if (keep.length === 0) continue;
        out[appId] = keep;
        apps++;
    }
    return apps > 0 ? out : null;
}

const EXEMPTIONS_TEXT = 'appExemptions is { "<app id>": ["<category>", ...] }: per app, the blocked kinds of data that app may receive.';

/**
 * What a save may send as one class's `appExemptions`. Known apps only (the
 * registry), known category keys only (built-in kinds and the shape of an
 * org's own type id; the route checks that such an id is one of the org's
 * types), never a hard category, within the bounds.
 */
export const AppExemptionsSchema = z.record(
    z.string({ error: EXEMPTIONS_TEXT }),
    z.array(z.string({ error: EXEMPTIONS_TEXT }), { error: EXEMPTIONS_TEXT })
        .max(MAX_EXEMPT_CATEGORIES_PER_APP, `An app exception names at most ${MAX_EXEMPT_CATEGORIES_PER_APP} kinds of data.`),
    { error: EXEMPTIONS_TEXT },
// Typed by hand: agent-hub's typecheck reaches this file without server/node_modules, where zod's own types are absent.
).superRefine((value: Record<string, string[]>, ctx: { addIssue: (issue: { code: 'custom'; message: string; path?: (string | number)[] }) => void }) => {
    const appIds = Object.keys(value);
    if (appIds.length > MAX_EXEMPT_APPS_PER_CLASS) {
        ctx.addIssue({ code: 'custom', message: `appExemptions holds at most ${MAX_EXEMPT_APPS_PER_CLASS} apps per tool class.` });
    }
    for (const appId of appIds) {
        if (!isExemptableApp(appId)) {
            ctx.addIssue({ code: 'custom', path: [appId], message: `${appId} is not an app an exception can be made for.` });
            continue;
        }
        for (const key of value[appId]) {
            if (HARD_BLOCKED_CATEGORIES.has(key)) {
                ctx.addIssue({ code: 'custom', path: [appId], message: `${key} can never be released to an app: it stays blocked for every tool.` });
            } else if (!isExemptableCategory(key)) {
                ctx.addIssue({ code: 'custom', path: [appId], message: `${key} is not a kind of personal data.` });
            }
        }
    }
});

/**
 * One class of the save's `toolPiiPolicy`: the block list (refused in the
 * route's words, `listText`, when it is not a list of text) and the optional
 * per-app exceptions. Left out = keep the stored ones (withAppExemptionsForSave).
 */
export function toolClassPolicySchema(policyText: string) {
    const listText = 'blockCategories is a list of text.';
    return z.object({
        blockCategories: z.array(z.string({ error: listText }), { error: listText }).optional(),
        appExemptions: AppExemptionsSchema.optional(),
    }, { error: policyText }).strict();
}

type SavedClass = { blockCategories: string[]; appExemptions?: AppExemptions };
type PolicyIn = Record<string, { appExemptions?: unknown } | null | undefined> | null | undefined;

function unknownOwnTypes(cls: ToolClass, sent: unknown, ownTypeIds: ReadonlySet<string>): Array<{ path: string; message: string }> {
    const details: Array<{ path: string; message: string }> = [];
    for (const [appId, cats] of Object.entries(sent && typeof sent === 'object' ? sent as Record<string, unknown> : {})) {
        for (const c of Array.isArray(cats) ? cats : []) {
            if (isCustomTypeId(c) && !ownTypeIds.has(c)) {
                details.push({ path: `body.toolPiiPolicy.${cls}.appExemptions.${appId}`, message: `${c} is not one of this organisation's own data types.` });
            }
        }
    }
    return details;
}

/**
 * The save's per-app exceptions, written into `policy` (the block lists the
 * save already built) and returned: per class the body's when it sends
 * `appExemptions`, else the stored ones, so a client that does not know them
 * (an older page, the mobile app) leaves them alone; either way narrowed to
 * what the class now blocks, and no key when nothing is left. An own-type id
 * in a sent exception must be one of the org's types (the schema only checks
 * its shape): otherwise the 400 `validate` answers with, before anything is written.
 */
export function withAppExemptionsForSave(policy: Record<ToolClass, SavedClass>, sentPolicy: PolicyIn, storedPolicy: PolicyIn, ownTypeIds: ReadonlySet<string>): Record<ToolClass, SavedClass> {
    const details: Array<{ path: string; message: string }> = [];
    for (const cls of TOOL_CLASSES) {
        const sent = sentPolicy?.[cls]?.appExemptions;
        details.push(...unknownOwnTypes(cls, sent, ownTypeIds));
        const kept = normaliseAppExemptions(sent !== undefined ? sent : storedPolicy?.[cls]?.appExemptions, policy[cls].blockCategories);
        if (kept) policy[cls].appExemptions = kept;
    }
    if (details.length) {
        const { badRequest } = nodeRequire('../http/errors.js') as { badRequest: (code: string, message: string, details: unknown) => Error };
        throw badRequest('invalid_request', details[0].message, details);
    }
    return policy;
}

type SentToolPolicy = Record<string, { blockCategories?: unknown; appExemptions?: unknown } | null | undefined> | null | undefined;

/**
 * The tool policy a save stores: per class the built-in kinds (capped at 40) then the org's own types,
 * then the per-app exceptions via withAppExemptionsForSave. `builtInPart` is the route's filter of built-in keys.
 */
export function toolPolicyForSave(
    sent: SentToolPolicy,
    custom: { lists: Record<ToolClass, string[]>; customDataTypes: Array<{ id: string }> },
    storedPolicy: PolicyIn,
    builtInPart: (list: unknown, max?: number) => string[],
): Record<ToolClass, SavedClass> {
    const policy = {
        external: { blockCategories: [...builtInPart(sent?.external?.blockCategories, 40), ...custom.lists.external] },
        internal: { blockCategories: [...builtInPart(sent?.internal?.blockCategories, 40), ...custom.lists.internal] },
    };
    return withAppExemptionsForSave(policy, sent, storedPolicy, new Set(custom.customDataTypes.map(t => t.id)));
}

/**
 * One audit line per app whose exceptions changed: org, admin, class, app id
 * and category keys. No personal data: a key names a kind of data, and an own
 * type is named by its id, never by the admin's words.
 */
export function exemptionAuditLines(orgId: string, userId: string, before: unknown, after: unknown): string[] {
    return exemptionChanges(before as ToolPolicyLike, after as ToolPolicyLike).map(ch => `[OrgPrivacyShield] app exception changed org=${orgId} by=${userId} `
        + `class=${ch.toolClass} app=${ch.appId} added=${ch.added.join(',') || '-'} removed=${ch.removed.join(',') || '-'}`);
}

/** One audit line's worth: which app, in which class, gained or lost which category keys. Ids only. */
export interface ExemptionChange {
    toolClass: ToolClass;
    appId: string;
    added: string[];
    removed: string[];
}

function exemptionsOf(policy: ToolPolicyLike, cls: ToolClass): Record<string, string[]> {
    const raw = policy?.[cls]?.appExemptions;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, string[]> = {};
    for (const [appId, cats] of Object.entries(raw as Record<string, unknown>)) {
        if (Array.isArray(cats)) out[appId] = cats.filter(isText);
    }
    return out;
}

/** What changed between two policies' exceptions, per class and app, sorted. Empty when nothing did. */
export function exemptionChanges(before: ToolPolicyLike, after: ToolPolicyLike): ExemptionChange[] {
    const changes: ExemptionChange[] = [];
    for (const toolClass of TOOL_CLASSES) {
        const was = exemptionsOf(before, toolClass);
        const now = exemptionsOf(after, toolClass);
        for (const appId of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
            const a = new Set(was[appId] || []);
            const b = new Set(now[appId] || []);
            const added = [...b].filter(c => !a.has(c)).sort();
            const removed = [...a].filter(c => !b.has(c)).sort();
            if (added.length || removed.length) changes.push({ toolClass, appId, added, removed });
        }
    }
    return changes;
}
