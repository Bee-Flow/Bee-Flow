/**
 * Project files — files uploaded straight into a collaborative project.
 *
 * ── ONE KNOWLEDGE BASE PER PROJECT ──────────────────────────────────
 * The files live in a knowledge base of their own, created the first time
 * somebody uploads into the project:
 *
 *   owner         the project's owner (the base outlives no one but them)
 *   organisation  the project's organisation
 *   source kind   `project_files`, so the Knowledge screens and pickers
 *                 (which list `manual` bases by default) leave it alone
 *   name          "<project> · Files"
 *
 * The organisation stamp is for the privacy shield and the org's embedding
 * settings, NOT an access grant: the generic knowledge-base ACL gives a
 * `project_files` base to its owner only and manages nothing in it
 * (stores/knowledgeBases.js PROJECT_FILES_KIND). Members read it through the
 * project, and files come and go through the routes here, by project role.
 *
 * Its id is recorded on the project (`projects.files_kb_id`, through
 * `projectStore.setFilesKbId`, which only writes when nothing is recorded yet:
 * two first uploads at once create two bases and the loser deletes its own)
 * and appended to `knowledge_base_ids`, which is what the chat paths search.
 * Retrieval for members goes through core/kb/projectFilesKb.js.
 *
 * ── THE SAME PIPELINE AS A KNOWLEDGE BASE UPLOAD ────────────────────
 * No second ingestion pipeline. A file is taken exactly the way the Knowledge
 * Studio's upload source takes one (routes/knowledgeBases/sources.js): the
 * documents row is created up front, parked as `skipped` with a "queued"
 * reason (there is no `processing` status in `documents`), the request is
 * answered, and the file is then extracted, screened, deduplicated and
 * embedded under that same row by the shared helpers in
 * core/kb/kbIngestionHelpers.js.
 *
 * The screen is the knowledge-base Privacy Shield (core/kb/ingestPrivacy.js,
 * K4), applied BEFORE the content is hashed — the same order ingestDocument
 * uses. A project's files are quoted to every member, most of whom were never
 * party to the document, so what gets stored is what the organisation's
 * policy lets through: redacted, held back with a reason, or as it came.
 *
 * ── WHAT A FILE LOOKS LIKE FROM OUTSIDE ─────────────────────────────
 * A projection of the documents row, never its text:
 *   { id, name, mimeType, size, status: 'ready'|'processing'|'failed',
 *     statusReason, redacted, uploadedBy, createdAt }
 *
 * Every collaborator is injectable (`makeProjectFiles(deps)`); the default
 * instance requires the real modules lazily.
 */

'use strict';

const { HttpError, conflict, notFound } = require('../core/http/errors');
const {
    PROJECT_FILES_SOURCE_KIND, filesKbIdOf, isProjectFilesKb,
} = require('../core/kb/projectFilesKb');

/** The knowledge-base upload limit (routes/knowledgeBases/ingest.js, sources.js). */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** A ceiling on one project's files, so a runaway client cannot fill a base. */
const MAX_PROJECT_FILES = 500;

/** How many files one listing returns (newest first). */
const LIST_LIMIT = 500;

/**
 * The reason a row carries while it waits. Same words as the Knowledge
 * Studio's upload source, so the row reads the same wherever it is opened.
 */
const QUEUED_REASON = 'Queued for processing';

/**
 * A row still "queued" after this long was accepted by a server that stopped
 * before finishing it. It is reported as failed so the person can remove it
 * and upload again, instead of watching a spinner for ever.
 */
const STALE_AFTER_MS = 30 * 60 * 1000;

/** The activity rows about one project file (routes/projects/workspace.js). */
const FILE_ACTIONS = new Set(['file.added', 'file.removed']);

const DUPLICATE_REASON = 'The same file is already in this project.';
const STALLED_REASON = 'Processing did not finish. Remove the file and upload it again.';

/** Where the project's chats may use the base. Not an access rule (see core/kb/usageContexts.js). */
const USAGE_CONTEXTS = Object.freeze(['agent', 'direct_chat']);

/** A file name as people will read it: one line, no control characters, capped. */
function cleanName(name) {
    const cleaned = String(name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned ? cleaned.slice(0, 200) : 'Untitled file';
}

/** The base's name: "<project> · Files", within the KB name column's reasonable length. */
function filesKbName(project) {
    const base = String(project?.name || 'Project').replace(/\s+/g, ' ').trim() || 'Project';
    return `${base.slice(0, 180)} · Files`;
}

function isQueued(doc) {
    return doc.status === 'skipped' && doc.status_reason === QUEUED_REASON;
}

/**
 * The outside status of a documents row.
 * @param {object} doc
 * @param {number} now  epoch ms
 */
function fileStatus(doc, now) {
    if (doc.status === 'processed' || doc.status === 'redacted') return 'ready';
    if (isQueued(doc)) {
        const since = new Date(doc.updated_at || doc.created_at || 0).getTime();
        return Number.isFinite(since) && now - since > STALE_AFTER_MS ? 'failed' : 'processing';
    }
    return 'failed';
}

/** One documents row as a project file. Never the text. */
function toFile(doc, now) {
    const status = fileStatus(doc, now);
    let statusReason = null;
    if (status === 'failed') {
        statusReason = isQueued(doc) ? STALLED_REASON
            : doc.status === 'duplicate' ? DUPLICATE_REASON
                : (doc.status_reason || null);
    }
    const size = Number(doc.size_bytes);
    return {
        id: doc.id,
        name: doc.title || 'Untitled file',
        mimeType: doc.mime || null,
        size: doc.size_bytes != null && Number.isFinite(size) ? size : null,
        status,
        statusReason,
        // Personal data was replaced by placeholders before the text was stored.
        redacted: doc.status === 'redacted' || doc.pii_status === 'redacted',
        uploadedBy: doc.created_by || null,
        createdAt: doc.created_at || null,
    };
}

function storedIds(project) {
    const ids = Array.isArray(project?.knowledgeBaseIds) ? project.knowledgeBaseIds : [];
    return ids.filter(id => typeof id === 'string' && id);
}

/**
 * @param {object} [deps]
 * @param {object} [deps.kbStore]        stores/knowledgeBases
 * @param {object} [deps.projectStore]   stores/projectStore (getProject, setFilesKbId, updateProject)
 * @param {object} [deps.helpers]        core/kb/kbIngestionHelpers
 * @param {object} [deps.ingestPrivacy]  core/kb/ingestPrivacy ({ applyShield, OUTCOME })
 * @param {Function} [deps.ensureKbSource] core/kb/sources/ensureSource.ensureKbSource
 * @param {Function} [deps.publishTransient] core/projectEventBus.publishTransient
 * @param {Function} [deps.resolveKbProvider] core/kb/resolveProvider.resolveKbProvider
 * @param {Function} [deps.deleteChunksLocally] core/kb/localKBIngest.deleteChunksLocally
 * @param {number}   [deps.maxKbIds]     the per-project base cap (projects/knowledgeBaseMembership)
 * @param {() => number} [deps.now]
 * @param {object} [deps.log]
 */
function makeProjectFiles(deps = {}) {
    const kbStore = () => deps.kbStore || require('../stores/knowledgeBases');
    const projectStore = () => deps.projectStore || require('../stores/projectStore');
    const helpers = () => deps.helpers || require('../core/kb/kbIngestionHelpers');
    const privacy = () => deps.ingestPrivacy || require('../core/kb/ingestPrivacy');
    const ensureKbSource = (...a) => (deps.ensureKbSource || require('../core/kb/sources/ensureSource').ensureKbSource)(...a);
    const publishTransient = (...a) => (deps.publishTransient || require('../core/projectEventBus').publishTransient)(...a);
    const log = deps.log || require('../telemetry/log');
    const now = deps.now || (() => Date.now());
    const maxKbIds = () => deps.maxKbIds || require('./knowledgeBaseMembership').MAX_KB_IDS;

    /** In-flight processing jobs, so tests and a graceful shutdown can wait for them. */
    const pending = new Set();
    function track(promise) {
        const job = Promise.resolve(promise).catch((e) => {
            log.error('[ProjectFiles] processing failed:', e && e.message ? e.message : e);
        });
        pending.add(job);
        job.then(() => pending.delete(job));
        return job;
    }
    async function settle() {
        while (pending.size > 0) await Promise.all(Array.from(pending));
    }

    /**
     * The project's files base, or null when it has none (yet). A recorded id
     * that resolves to something that is not this project's files base is
     * treated as none: it is never read as the project's files.
     */
    async function getFilesKb(project) {
        const id = filesKbIdOf(project);
        if (!id) return null;
        const kb = await kbStore().getKB(id);
        return isProjectFilesKb(kb, project) ? kb : null;
    }

    /**
     * Make sure the files base is in `knowledge_base_ids`, which is what the
     * direct-chat path searches. Compare-and-swap on the project's version
     * like every other writer of that column (knowledgeBaseMembership.js), so
     * a colleague's KB change a moment earlier is kept, not overwritten.
     *
     * Best-effort: the agent path and the team-chat assistant reach the files
     * through `files_kb_id` either way, so a failure here is logged, not
     * raised. Returns true when this call added the id.
     */
    async function ensureListed(projectId, kbId) {
        for (let attempt = 0; attempt < 3; attempt++) {
            const project = await projectStore().getProject(projectId);
            if (!project) return false;
            const ids = storedIds(project);
            if (ids.includes(kbId)) return false;
            if (ids.length >= maxKbIds()) {
                log.warn(`[ProjectFiles] project ${projectId} already holds ${ids.length} knowledge bases; its files base is searched through files_kb_id only`);
                return false;
            }
            if (!Number.isFinite(Number(project.version))) return false;
            const result = await projectStore().updateProject(
                projectId, { knowledgeBaseIds: [...ids, kbId] }, { expectedVersion: Number(project.version) },
            );
            if (!result) return false;
            if (result.conflict) continue;
            // The project row's version moved: open settings forms must reload
            // before they save, or their next PUT is a needless conflict.
            try {
                await publishTransient(projectId, { kind: 'project_updated', payload: { changes: ['knowledgeBaseIds'] } });
            } catch (_) { /* presence-grade: never fail the upload over it */ }
            return true;
        }
        log.warn(`[ProjectFiles] could not list the files base on project ${projectId} after three attempts`);
        return false;
    }

    async function discardBase(kb) {
        try { await kbStore().deleteKB(kb.id); } catch (e) {
            log.warn(`[ProjectFiles] could not remove the redundant files base ${kb.id}:`, e.message);
        }
    }

    /**
     * The project's files base, created on first use.
     * @param {object} project  a getProject() result
     */
    async function ensureFilesKb(project) {
        const recorded = filesKbIdOf(project);
        if (recorded) {
            const existing = await kbStore().getKB(recorded);
            if (isProjectFilesKb(existing, project)) {
                await ensureListed(project.id, existing.id);
                return existing;
            }
            if (existing) {
                // The project names a base that is not its files base. Refuse
                // rather than upload into somebody else's knowledge base.
                log.error(`[ProjectFiles] project ${project.id} records base ${recorded} as its files, but it is not`);
                throw new HttpError(409, 'FILES_UNAVAILABLE', 'The files of this project cannot be stored right now.');
            }
            // Recorded, but the base is gone: make a new one below and replace
            // the stale id (only if it is still the one we saw).
        }

        const kb = await kbStore().createKB(
            project.ownerId,
            filesKbName(project),
            'Files uploaded into this project. Every member of the project can search them in its chats.',
            project.organizationId || null,
            { sourceKind: PROJECT_FILES_SOURCE_KIND, usageContexts: [...USAGE_CONTEXTS] },
        );

        let winner;
        try {
            winner = recorded
                ? await projectStore().setFilesKbId(project.id, kb.id, { expected: recorded })
                : await projectStore().setFilesKbId(project.id, kb.id);
        } catch (e) {
            await discardBase(kb);
            throw e;
        }
        if (winner === kb.id) {
            log.info(`[ProjectFiles] created files base ${kb.id} for project ${project.id}`);
            await ensureListed(project.id, kb.id);
            return kb;
        }

        // Somebody else's first upload won (or the project went away).
        await discardBase(kb);
        if (!winner) throw notFound('not_found', 'Not found');
        const other = await kbStore().getKB(winner);
        if (!isProjectFilesKb(other, { ...project, filesKbId: winner })) {
            throw new HttpError(409, 'FILES_UNAVAILABLE', 'The files of this project cannot be stored right now.');
        }
        await ensureListed(project.id, other.id);
        return other;
    }

    /**
     * Every file in the project, newest first.
     * @returns {Promise<{files: object[], kbId: string|null}>}
     */
    async function listFiles(project) {
        const kb = await getFilesKb(project);
        if (!kb) return { files: [], kbId: null };
        const rows = await kbStore().listDocuments(kb.id, { limit: LIST_LIMIT, offset: 0 });
        const t = now();
        return { files: (rows || []).map(doc => toFile(doc, t)), kbId: kb.id };
    }

    /**
     * The names of those of `ids` that are still files of this project, read
     * now. A file that was removed (or never was this project's) is absent.
     * @param {object} project  a getProject() result
     * @param {string[]} ids
     * @returns {Promise<Map<string, string>>}
     */
    async function fileNames(project, ids) {
        const wanted = new Set((Array.isArray(ids) ? ids : []).filter(id => typeof id === 'string' && id));
        const out = new Map();
        if (wanted.size === 0) return out;
        const kb = await getFilesKb(project);
        if (!kb) return out;
        // One read of at most MAX_PROJECT_FILES rows (the listing's own query,
        // projected, never the text) rather than a lookup per activity row.
        const rows = await kbStore().listDocuments(kb.id, { limit: LIST_LIMIT, offset: 0 });
        for (const doc of rows || []) {
            if (wanted.has(doc.id)) out.set(doc.id, toFile(doc, now()).name);
        }
        return out;
    }

    /**
     * Name the file rows of an activity page, at READ time.
     *
     * The `file.added` / `file.removed` rows carry the file's id only
     * (routes/projects/workspace.js): a file name can be personal data, and
     * the activity row lives as long as the project. So the name is looked up
     * here, from the project's own files, and only while the file is still
     * there; a removed file stays unnamed ("deleted a file"). A `name` an older
     * row still stores is dropped for the same reason, never shown.
     *
     * Never throws: a files base that cannot be read leaves the rows unnamed.
     * @param {object} project  a getProject() result
     * @param {object[]} items  listActivity() rows
     * @returns {Promise<object[]>}
     */
    async function nameFileActivity(project, items) {
        const list = Array.isArray(items) ? items : [];
        const isFileRow = (item) => !!item && FILE_ACTIONS.has(item.action);
        if (!list.some(isFileRow)) return list;
        const idOf = (item) => item.targetId || item.details?.targetId || null;
        let names = new Map();
        try {
            names = await fileNames(project, list.filter(isFileRow).map(idOf));
        } catch (e) {
            log.warn('[ProjectFiles] could not name the files in the activity feed:', e.message);
        }
        return list.map((item) => {
            if (!isFileRow(item)) return item;
            const details = { ...(item.details || {}) };
            delete details.name;
            const name = names.get(idOf(item));
            if (name) details.name = name;
            return { ...item, details };
        });
    }

    /**
     * Extract, screen, deduplicate and embed one accepted file under its row.
     * Never throws; returns the outside status it ended in, or 'removed' when
     * the file was deleted while it was being processed.
     */
    async function processFile(kb, doc, upload, { userId }) {
        const h = helpers();
        const store = kbStore();
        const name = doc.title;
        const markFailed = async (status, statusReason) => {
            try { await store.updateDocumentStatus(doc.id, { status, statusReason, chunkCount: 0 }); } catch (e) {
                log.warn(`[ProjectFiles] could not record why "${doc.id}" failed:`, e.message);
            }
            return 'failed';
        };

        try {
            let text = '';
            let meta = {};
            try {
                const extracted = await h.extractFileContentWithMeta(upload.buffer, upload.mimetype, name);
                text = extracted?.text || '';
                meta = extracted?.meta || {};
            } catch (e) {
                log.warn(`[ProjectFiles] extraction failed for ${doc.id}: ${e.message}`);
                return await markFailed('error', h.friendlyError(e));
            }
            const pages = Array.isArray(meta.pages) && meta.pages.length ? meta.pages : null;

            // Privacy BEFORE the hash, as ingestDocument does it: what is hashed
            // is what is stored, and what is stored is what the policy allows.
            let status = 'processed';
            let piiStatus;
            let piiCategories;
            if (text && text.trim().length >= 3) {
                const { applyShield, OUTCOME } = privacy();
                const verdict = await applyShield({
                    orgId: kb.organization_id || null, userId, text, filename: name, pages,
                });
                piiStatus = verdict.piiStatus;
                piiCategories = verdict.piiCategories;
                if (verdict.outcome === OUTCOME.SKIPPED) {
                    await store.replaceDocumentContent(doc.id, {
                        status: 'skipped', statusReason: verdict.reason, chunkCount: 0, piiStatus, piiCategories,
                    });
                    return 'failed';
                }
                text = verdict.text;
                if (verdict.outcome === OUTCOME.REDACTED) status = 'redacted';

                // The same content already in the project: an alias, not a
                // second embedding (the Knowledge Studio upload's rule).
                const existing = await store.findDocumentByContentHash(kb.id, store.hashContent(text));
                if (existing && String(existing.id) !== String(doc.id)) {
                    return await markFailed('duplicate', DUPLICATE_REASON);
                }
            }

            const result = await h.reingestDocument(kb.tenant_id, kb.id, doc.id, text, {
                title: name,
                sizeBytes: upload.size != null ? upload.size : (upload.buffer ? upload.buffer.length : null),
                mime: upload.mimetype || null,
                pageCount: Number.isFinite(meta.pageCount) ? meta.pageCount : null,
                sheetCount: Array.isArray(meta.sheetNames) ? meta.sheetNames.length : null,
                pages,
                externalId: name,
                onFailure: 'record',
                status,
                piiStatus,
                piiCategories,
            });

            // Removed while it was being embedded: its chunks may have landed
            // after the row went, and deleted text must not stay searchable.
            if (!(await store.getDocument(doc.id))) {
                await h.purgeDocumentChunks(kb.id, doc.id, kb.tenant_id).catch((e) => {
                    log.warn(`[ProjectFiles] could not purge chunks of removed file ${doc.id}:`, e.message);
                });
                return 'removed';
            }
            return result && (result.status === 'processed' || result.status === 'redacted') ? 'ready' : 'failed';
        } catch (e) {
            if (e && e.code === 'NOT_FOUND') return 'removed';
            log.error(`[ProjectFiles] processing ${doc.id} failed:`, e && e.message ? e.message : e);
            return await markFailed('error', h.friendlyError(e));
        }
    }

    /**
     * Accept one uploaded file into the project.
     *
     * Creates the row and returns it as a `processing` file. The work runs
     * when the caller calls `start()` — after it has answered and announced
     * the file — so the "processed" notice can never overtake the "added" one.
     *
     * @param {object} project   a getProject() result
     * @param {{originalname?: string, mimetype?: string, size?: number, buffer: Buffer}} upload
     * @param {{userId: string}} who
     * @returns {Promise<{file: object, start: (opts?: {onDone?: (status: string) => any}) => Promise<void>}>}
     */
    async function addFile(project, upload, { userId }) {
        const kb = await ensureFilesKb(project);
        const store = kbStore();

        const count = await store.countDocuments(kb.id, {});
        if (count >= MAX_PROJECT_FILES) {
            throw conflict('too_many_files', `A project holds at most ${MAX_PROJECT_FILES} files. Remove one before adding another.`);
        }

        const name = cleanName(upload.originalname);
        const source = await ensureKbSource(kb.id, 'upload', {
            name: 'Project files', config: {}, createdBy: userId,
        });
        const doc = await store.createDocument(
            kb.tenant_id, kb.id, name, 'upload', name, null, 0, null, null,
            {
                sourceId: source ? source.id : null,
                externalId: name,
                createdBy: userId,
                sizeBytes: upload.size != null ? upload.size : (upload.buffer ? upload.buffer.length : null),
                mime: upload.mimetype || null,
                status: 'skipped',
                statusReason: QUEUED_REASON,
            },
        );

        let started = false;
        const start = ({ onDone } = {}) => {
            if (started) return Promise.resolve();
            started = true;
            return track(processFile(kb, doc, upload, { userId }).then(async (status) => {
                if (typeof onDone === 'function') await onDone(status);
            }));
        };
        return { file: toFile(doc, now()), start };
    }

    /**
     * Remove one file: its row, its chunks, and its search index entries.
     * Returns the removed file, or null when the id is not one of this
     * project's files (never a different project's, never another base's).
     */
    async function removeFile(project, fileId, { userId }) {
        const kb = await getFilesKb(project);
        if (!kb) return null;
        const store = kbStore();
        const doc = await store.getDocument(fileId);
        if (!doc || String(doc.knowledge_base_id) !== String(kb.id)) return null;

        // The same recovery snapshot a knowledge-base document delete takes,
        // carrying who removed it; then the store skips its own.
        await store.snapshotDocumentVersion(doc.id, userId).catch((e) => {
            log.warn(`[ProjectFiles] snapshot before removing ${doc.id} failed:`, e.message);
        });
        await helpers().deleteDocumentChunks(kb.id, doc.id, kb.tenant_id, { skipSnapshot: true });
        return toFile(doc, now());
    }

    /**
     * Delete the project's files base with every chunk in it. For the project
     * delete path: a base nobody can reach any more is personal data kept for
     * no purpose. Mirrors routes/knowledgeBases/detail.js DELETE.
     * @returns {Promise<boolean>} true when a base was removed
     */
    async function removeFilesKb(project) {
        const kb = await getFilesKb(project);
        if (!kb) return false;
        const store = kbStore();
        const resolveKbProvider = deps.resolveKbProvider || require('../core/kb/resolveProvider').resolveKbProvider;
        const deleteChunksLocally = deps.deleteChunksLocally || require('../core/kb/localKBIngest').deleteChunksLocally;

        if ((await resolveKbProvider()) !== 'local') {
            const PAGE = 200;
            for (let offset = 0; offset < PAGE * 50; offset += PAGE) {
                const docs = await store.listDocuments(kb.id, { limit: PAGE, offset });
                if (!docs || docs.length === 0) break;
                for (const doc of docs) await helpers().purgeDocumentChunks(kb.id, doc.id, kb.tenant_id);
                if (docs.length < PAGE) break;
            }
        }
        try { await deleteChunksLocally(kb.tenant_id, kb.id); } catch (e) {
            log.warn(`[ProjectFiles] local chunk cleanup for ${kb.id} failed:`, e.message);
        }
        await store.deleteKB(kb.id);
        return true;
    }

    return {
        getFilesKb, ensureFilesKb, listFiles, fileNames, nameFileActivity, addFile, removeFile, removeFilesKb, settle,
    };
}

const defaultInstance = makeProjectFiles();

module.exports = {
    makeProjectFiles,
    ...defaultInstance,
    MAX_FILE_BYTES,
    MAX_PROJECT_FILES,
    QUEUED_REASON,
    STALE_AFTER_MS,
    toFile,
    cleanName,
    filesKbName,
};
