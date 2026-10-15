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
const { makeFilesKbAccess, filesKbName } = require('./projectFilesKb');
const { makeFileProcessor, DUPLICATE_REASON } = require('./projectFilesProcess');

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

const STALLED_REASON = 'Processing did not finish. Remove the file and upload it again.';

/** A file name as people will read it: one line, no control characters, capped. */
function cleanName(name) {
    const cleaned = String(name || '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned ? cleaned.slice(0, 200) : 'Untitled file';
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

    const { getFilesKb, ensureFilesKb, removeFilesKb } = makeFilesKbAccess({
        kbStore, projectStore, helpers, maxKbIds, publishTransient, log,
        resolveKbProvider: () => deps.resolveKbProvider || require('../core/kb/resolveProvider').resolveKbProvider,
        deleteChunksLocally: () => deps.deleteChunksLocally || require('../core/kb/localKBIngest').deleteChunksLocally,
        kit: { HttpError, notFound, PROJECT_FILES_SOURCE_KIND, filesKbIdOf, isProjectFilesKb },
    });
    const processFile = makeFileProcessor({ kbStore, helpers, privacy, log });

    /**
     * Every file in the project, newest first.
     * @returns {Promise<{files: object[], kbId: string|null}>}
     */
    async function fileContent(project, fileId) {
        const kb = await getFilesKb(project);
        if (!kb) return null;
        const doc = await kbStore().getDocument(fileId);
        if (!doc || String(doc.knowledge_base_id) !== String(kb.id)) return null;
        const file = toFile(doc, now());
        // Only successfully processed, shielded content can be shown.
        let content = '';
        if (file.status === 'ready') {
            content = await kbStore().getDocumentOriginalContent(doc.id) || '';
            if (!content) content = await (deps.getDocumentContent || require('../core/kb/localKBIngest').getDocumentContent)(kb.tenant_id, kb.id, doc.id) || '';
        }
        return { file, content, available: !!content };
    }

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


    return {
        getFilesKb, ensureFilesKb, listFiles, fileContent, fileNames, nameFileActivity, addFile, removeFile, removeFilesKb, settle,
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
