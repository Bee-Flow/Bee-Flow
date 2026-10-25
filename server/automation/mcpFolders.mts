/**
 * Folders over MCP: create folders (and subfolders), list the tree, move a
 * folder under another, and file automations in a folder.
 *
 *   automations_folder_list      {}                              the folder tree, flat, each with parentId and path
 *   automations_folder_create    {name, parentId?}               a folder, at the top level or under parentId
 *   automations_folder_move      {folderId, parentId|null}       a folder and everything in it, under another parent
 *   automations_move_to_folder   {automationIds[1..20], folderId|null}   file automations in a folder, or take them out
 *
 * Who may do what, in this order:
 *   - The gate (auth/mcpAccess/gate.js) has already judged the request: token,
 *     account, every organisation's policy, IP list, rate limits per message.
 *     The tool scope is checked in routes/mcpAutomations.js (the three write tools
 *     are not read-only, so a read token never reaches them).
 *   - The organisation is resolved from the account on every call, the same one
 *     the product's sidebar uses. If it cannot be resolved the call is refused.
 *   - A folder id from the client is untrusted: the store loads the folder and
 *     its parent and checks that they are in the caller's organisation, so
 *     another organisation's folder answers "not found".
 *   - An automation is moved only by its owner (the product's rule: the sidebar
 *     folder is the owner's call), and only into a folder of its own organisation.
 *   - Writes spend a per-user budget, one unit per folder or automation
 *     (AUTOMATION_MCP_FOLDER_WRITES_PER_MINUTE, default 120, 0 = unlimited), next
 *     to the per-token and per-user budget the gate charges per message.
 *
 * Nothing here deletes anything. Collaborators are injected, so the tests hand
 * in fakes and nothing is required from the database layer at load time.
 */

import { createRequire } from 'node:module';
import { FolderError } from '../stores/automationStore/folderStore.mts';
import type { Folder } from '../stores/automationStore/folderStore.mts';

const nodeRequire = createRequire(import.meta.url);
// Through utils/zod, which installs the wording of the refusal texts.
const { z } = nodeRequire('../utils/zod.js') as { z: typeof import('zod').z };

/** Automations moved in one call. The same cap the MCP endpoint puts on a batch of messages. */
export const MAX_MOVE_BATCH = 20;

export interface ToolDef {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}

export const FOLDER_TOOLS: ToolDef[] = [
    {
        name: 'automations_folder_list',
        description: 'List the automation folders of this account\'s organisation as a flat list with the tree in it: folderId, parentId (null = top level), name, path ("Finance / Invoices"), depth (1 = top level) and automationCount (YOUR automations directly in that folder). Read-only. Folders are shared by the whole organisation; the automations inside stay per person.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'automations_folder_create',
        description: 'Create an automation folder. Without parentId it is a top-level folder; with parentId it is a subfolder of that folder (a folderId from automations_folder_list or an earlier create). Names are unique among the folders of one parent, ignoring case. Folders can be nested up to a depth the organisation sets (default 8). Returns the new folder.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Folder name (max 80 characters).' },
                parentId: { type: ['string', 'null'], description: 'The folder to create it in. Omit or null for the top level.' },
            },
            required: ['name'],
        },
    },
    {
        name: 'automations_folder_move',
        description: 'Move a folder, with everything in it, under another folder, or to the top level with parentId null. A folder cannot be moved into itself or into one of its own subfolders, the result may not nest deeper than the depth limit, and the name must be free in the new parent. Returns the folder with its new path.',
        parameters: {
            type: 'object',
            properties: {
                folderId: { type: 'string', description: 'The folder to move (from automations_folder_list).' },
                parentId: { type: ['string', 'null'], description: 'The new parent folder, or null for the top level. Required: say null explicitly to mean the top level.' },
            },
            required: ['folderId', 'parentId'],
        },
    },
    {
        name: 'automations_move_to_folder',
        description: `Put automations in a folder, or take them out of any folder with folderId null. Up to ${MAX_MOVE_BATCH} automations per call. You can move only automations you own, into a folder of their own organisation; each automation is answered on its own, so one that cannot be moved does not stop the others. Returns moved[] and failed[] (automationId, code, error).`,
        parameters: {
            type: 'object',
            properties: {
                automationIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_MOVE_BATCH, description: 'Automations to move (ids from automations_list).' },
                folderId: { type: ['string', 'null'], description: 'The folder to file them in, or null to take them out of their folder. Required.' },
            },
            required: ['automationIds', 'folderId'],
        },
    },
];

export const FOLDER_TOOL_NAMES: ReadonlySet<string> = new Set(FOLDER_TOOLS.map((t) => t.name));
/** The tools that change something. They are not advertised as read-only, so a read-level token cannot call them. */
export const FOLDER_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(['automations_folder_create', 'automations_folder_move', 'automations_move_to_folder']);

/** A section for the guide automations_get_guide returns. */
export function guideSection(): string {
    return [
        '## Folders',
        '',
        'Automations can be filed in folders, and folders can hold subfolders. A folder is shared by the whole organisation; the automations inside stay yours.',
        '- automations_folder_list {}: every folder with folderId, parentId (null = top level), name, path, depth and automationCount.',
        '- automations_folder_create { name, parentId? }: a folder, or a subfolder of parentId. Names are unique within one parent (case-insensitive).',
        '- automations_folder_move { folderId, parentId }: move a folder and everything in it under parentId, or to the top level with parentId null. Not into itself or one of its own subfolders; not deeper than the depth limit (default 8, set by AUTOMATION_FOLDER_MAX_DEPTH, 0 = unlimited).',
        `- automations_move_to_folder { automationIds (1-${MAX_MOVE_BATCH}), folderId }: file your automations in a folder, or take them out with folderId null. Each one is answered separately in moved[] / failed[].`,
        'Deleting a folder is done in the product, never here. It does not delete automations (they go back to the top level) or subfolders (they move up one level).',
        'The folder tools spend a per-person budget: one unit per folder or automation, 120 a minute by default.',
    ].join('\n');
}

// ── Arguments ───────────────────────────────────────────────────────────────

const Id = z.string({ error: 'must be an id (text).' }).trim().min(1, 'must not be empty.').max(200, 'is too long.');
const NewName = z.string({ error: 'A folder needs a name.' }).trim().min(1, 'A folder needs a name.').max(80, 'A folder name is at most 80 characters.');

const ListArgs = z.object({}).strict();
const CreateArgs = z.object({ name: NewName, parentId: Id.nullish() }).strict();
const MoveArgs = z.object({ folderId: Id, parentId: Id.nullable() }).strict();
const FileArgs = z.object({
    automationIds: z.array(Id, { error: 'automationIds is a list of automation ids.' })
        .min(1, 'Name at least one automation.')
        .max(MAX_MOVE_BATCH, `At most ${MAX_MOVE_BATCH} automations per call.`),
    folderId: Id.nullable(),
}).strict();

class ToolRefusal extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(message);
        this.code = code;
    }
}

function parseArgs<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: { path: PropertyKey[]; message: string }[] } } }, args: unknown): T {
    const out = schema.safeParse(args && typeof args === 'object' ? args : {});
    if (out.success) return out.data;
    const issue = out.error.issues[0];
    const where = issue?.path?.length ? `${issue.path.map(String).join('.')}: ` : '';
    throw new ToolRefusal('invalid_arguments', `${where}${issue?.message ?? 'The arguments are not valid.'}`);
}

// ── Collaborators ───────────────────────────────────────────────────────────

export interface AutomationRow {
    id: string;
    userId: string;
    organizationId?: string | null;
    deletedAt?: string | null;
}

export interface FolderToolDeps {
    store: {
        listFolders(orgId: string | null, userId: string): Promise<Folder[]>;
        createFolder(input: { organizationId: string | null; name: string; parentId?: string | null }): Promise<Folder>;
        moveFolder(id: string, newParentId: string | null, orgId: string | null): Promise<Folder>;
        requireFolderForAutomation(folderId: string | null, orgId: string | null): Promise<Folder | null>;
        getAutomation(id: string): Promise<AutomationRow | null>;
        updateAutomation(id: string, updates: { folderId: string | null }, savedByUserId: string): Promise<unknown>;
    };
    /** The organisation the account acts in and every organisation it belongs to. Throws when that cannot be resolved. */
    caller(userId: string): Promise<{ orgId: string | null; memberOrgIds: string[] }>;
    /** Spend `cost` units of the per-user write budget. False = out of budget. */
    charge(userId: string, cost: number): Promise<boolean>;
    log?: { error(message: string): void };
}

// ── The tools ───────────────────────────────────────────────────────────────

function describeFolders(folders: Folder[]) {
    const byId = new Map(folders.map((f) => [f.id, f]));
    const pathOf = (f: Folder): { path: string; depth: number } => {
        const names: string[] = [];
        const seen = new Set<string>();
        for (let cur: Folder | undefined = f; cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
            seen.add(cur.id);
            names.unshift(cur.name);
        }
        return { path: names.join(' / '), depth: names.length };
    };
    return (f: Folder) => ({
        folderId: f.id,
        parentId: f.parentId,
        name: f.name,
        ...pathOf(f),
        ...(f.automationCount !== undefined ? { automationCount: f.automationCount } : {}),
    });
}

export function makeFolderTools(deps: FolderToolDeps) {
    const { store } = deps;

    async function resolveCaller(userId: string) {
        try {
            return await deps.caller(userId);
        } catch {
            // Fail closed: an organisation that cannot be read is not "no organisation".
            throw new ToolRefusal('organization_unresolved', 'Your organisation could not be resolved, so folders are not available right now. Try again in a moment.');
        }
    }

    async function spend(userId: string, cost: number) {
        if (!await deps.charge(userId, cost)) {
            throw new ToolRefusal('rate_limited', 'Too many folder changes in the last minute. Wait a moment and try again.');
        }
    }

    async function describedFolder(orgId: string | null, userId: string, folderId: string) {
        const all = await store.listFolders(orgId, userId);
        const folder = all.find((f) => f.id === folderId);
        return folder ? describeFolders(all)(folder) : { folderId };
    }

    async function list(userId: string, rawArgs: unknown) {
        parseArgs(ListArgs, rawArgs);
        const { orgId } = await resolveCaller(userId);
        const all = await store.listFolders(orgId, userId);
        return { folders: all.map(describeFolders(all)) };
    }

    async function create(userId: string, rawArgs: unknown) {
        const args = parseArgs(CreateArgs, rawArgs);
        const { orgId } = await resolveCaller(userId);
        await spend(userId, 1);
        const folder = await store.createFolder({ organizationId: orgId, name: args.name, parentId: args.parentId ?? null });
        return { folder: await describedFolder(orgId, userId, folder.id) };
    }

    async function move(userId: string, rawArgs: unknown) {
        const args = parseArgs(MoveArgs, rawArgs);
        const { orgId } = await resolveCaller(userId);
        await spend(userId, 1);
        const folder = await store.moveFolder(args.folderId, args.parentId, orgId);
        return { folder: await describedFolder(orgId, userId, folder.id) };
    }

    async function moveToFolder(userId: string, rawArgs: unknown) {
        const args = parseArgs(FileArgs, rawArgs);
        const ids = [...new Set(args.automationIds)];
        const { orgId, memberOrgIds } = await resolveCaller(userId);
        await spend(userId, ids.length);

        const moved: { automationId: string; folderId: string | null }[] = [];
        const failed: { automationId: string; code: string; error: string }[] = [];
        for (const automationId of ids) {
            try {
                const automation = await store.getAutomation(automationId).catch(() => null);
                // Somebody else's automation, a trashed one and one that does not exist answer alike.
                if (!automation || automation.userId !== userId || automation.deletedAt) {
                    throw new ToolRefusal('automation_not_found', 'Automation not found, or you do not own it. Call automations_list for the automations you own.');
                }
                // The organisation the automation lives in: its own, else the account's. It must be one the account still belongs to.
                const automationOrg = automation.organizationId || orgId;
                if (automationOrg && !memberOrgIds.includes(automationOrg)) {
                    throw new ToolRefusal('automation_not_found', 'Automation not found, or you do not own it. Call automations_list for the automations you own.');
                }
                const folder = await store.requireFolderForAutomation(args.folderId, automationOrg ?? null);
                await store.updateAutomation(automation.id, { folderId: folder?.id ?? null }, userId);
                moved.push({ automationId: automation.id, folderId: folder?.id ?? null });
            } catch (e) {
                if (e instanceof ToolRefusal || e instanceof FolderError) {
                    failed.push({ automationId, code: e.code, error: e.message });
                } else {
                    deps.log?.error(`[automations-mcp] automations_move_to_folder failed for ${automationId}: ${e instanceof Error ? e.message : String(e)}`);
                    failed.push({ automationId, code: 'move_failed', error: 'This automation could not be moved.' });
                }
            }
        }
        return { moved, failed };
    }

    const handlers: Record<string, (userId: string, args: unknown) => Promise<unknown>> = {
        automations_folder_list: list,
        automations_folder_create: create,
        automations_folder_move: move,
        automations_move_to_folder: moveToFolder,
    };

    /** Run one folder tool. Never throws: a refusal is `{ error, code }`. */
    async function call(name: string, args: unknown, ctx: { userId: string }): Promise<unknown> {
        const handler = handlers[name];
        if (!handler) return { error: `Unknown tool: ${name}`, code: 'unknown_tool' };
        try {
            return await handler(ctx.userId, args);
        } catch (e) {
            if (e instanceof ToolRefusal || e instanceof FolderError) return { error: e.message, code: e.code };
            deps.log?.error(`[automations-mcp] ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
            return { error: `${name} failed.`, code: 'internal_error' };
        }
    }

    return { call };
}
