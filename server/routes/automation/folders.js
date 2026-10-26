/** @typedef {import('express-serve-static-core').Router} Router */
// @typecheck strict
// Automation folders, split out of routes/automation/crud.js: the sidebar's
// org-wide labels. crud.js registers these routes on its own router, at the
// place they always had (before `/:id`).
const { z } = require('../../utils/zod');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const automationStore = require('../../stores/automationStore');
const { MAX_FOLDER_NAME_LEN, FolderError } = require('../../stores/automationStore/folders');
const { orgOf } = require('./crudContext');
const { sessionUser } = require('../../core/http/sessionUser');

// ── Folders ───────────────────────────────────────────────────────────────
// The store trims and truncates a name; the schema says the same thing to the
// caller BEFORE the row is attempted, so a blank name is a 400 naming the
// field rather than a driver error echoed back.
const NAME_REQUIRED = 'A folder needs a name.';
const FolderBody = z.object({
    // Both messages, because zod answers a MISSING field with required_error
    // and a blank one with the min() message, and the caller reads whichever
    // it gets: an unworded rule arrives as the word "Required".
    name: z.string({ error: NAME_REQUIRED })
        .trim().min(1, NAME_REQUIRED)
        .max(MAX_FOLDER_NAME_LEN, `A folder name is at most ${MAX_FOLDER_NAME_LEN} characters.`),
    icon: z.string().trim().max(16).optional(),
    color: z.string().trim().max(32).nullish(),
    // The folder it sits in; absent or null = the top level.
    parentId: z.string().trim().min(1).max(64).nullish(),
}).strict();

/**
 * Every field optional: a rename must not have to resend icon and colour.
 * `parentId` moves the folder (with everything in it) under another folder, or
 * to the top level with null.
 */
const FolderPatch = FolderBody.partial();

/** A refusal of the folder rules is the caller's to read; anything else stays a 500. */
const asHttp = (/** @type {unknown} */ e) => (e instanceof FolderError ? new HttpError(e.status, e.code, e.message) : e);

const isDuplicateFolder = (/** @type {{ message?: string } | null | undefined} */ e) => /duplicate key|unique/i.test(e?.message || '');
const duplicateFolder = () => new HttpError(409, 'folder_name_taken', 'A folder with that name already exists.');

// ── Folders ────────────────────────────────────────────────────────────
//
// Registered BEFORE `/:id` for the same reason the template routes are: the
// param route would otherwise match the literal string 'folders' and answer
// 404 from getAutomation('folders'). automation.routetable.test.js guards it.
//
// Folders are org-wide, so they are readable and editable by anyone in the
// organisation. The automations INSIDE them stay per-user — the list endpoint
// filters on user_id — so a folder is a shared label, not a shared inbox.
/**
 * @param {Router} router
 */
function registerFolderRoutes(router) {
    // Folder ids in the URL and the body are untrusted: every handler loads the
    // folder in the CALLER's organisation first, and another organisation's
    // folder answers 404 like one that does not exist.
    router.get('/folders', async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
        res.json({ folders: await automationStore.listFolders(await orgOf(req), sessionUser(req).id) });
    });

    router.post('/folders', validate({ body: FolderBody }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
        try {
            const folder = await automationStore.createFolder({
                organizationId: await orgOf(req),
                ...req.body,
            });
            res.status(201).json({ folder });
        } catch (e) {
            // A duplicate name is the user's doing, not a server fault; the unique
            // index is the backstop behind the store's own check.
            if (isDuplicateFolder(e)) return next(duplicateFolder());
            return next(asHttp(e));
        }
    });

    router.put('/folders/:folderId', validate({ body: FolderPatch }), async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res, /** @type {import('express').NextFunction} */ next) => {
        try {
            const orgId = await orgOf(req);
            const existing = await automationStore.getFolderInOrg(req.params.folderId, orgId);
            if (!existing) return res.status(404).json({ error: 'Not found' });
            const { parentId, ...patch } = req.body;
            // The server refuses a loop, a tree that is too deep and a name taken in the new parent.
            if (parentId !== undefined) await automationStore.moveFolder(existing.id, parentId, orgId);
            const folder = Object.keys(patch).length ? await automationStore.updateFolder(existing.id, patch) : await automationStore.getFolder(existing.id);
            return res.json({ folder });
        } catch (e) {
            if (isDuplicateFolder(e)) return next(duplicateFolder());
            return next(asHttp(e));
        }
    });

    router.delete('/folders/:folderId', async (/** @type {import('express').Request} */ req, /** @type {import('express').Response} */ res) => {
        const existing = await automationStore.getFolderInOrg(req.params.folderId, await orgOf(req));
        if (!existing) return res.status(404).json({ error: 'Not found' });
        // Detaches, never deletes: the folder may hold automations belonging to
        // colleagues this user cannot see. Its subfolders move up one level.
        const { detached, reparented } = await automationStore.deleteFolder(existing.id);
        return res.json({ success: true, detached, reparented });
    });
}

/**
 * The folder an automation is filed in, for its update: the folder must exist in
 * the caller's organisation (an id from the client is not trusted). Null = the top level.
 * @param {string | null | undefined} folderId
 * @param {string | null} organizationId
 */

async function folderIdForUpdate(
folderId, organizationId) {
    if (!folderId) return null;
    try {
        return (await automationStore.requireFolderForAutomation(folderId || null, organizationId))?.id ?? null;
    } catch (e) {
        throw asHttp(e);
    }
}

module.exports = { registerFolderRoutes, folderIdForUpdate };
