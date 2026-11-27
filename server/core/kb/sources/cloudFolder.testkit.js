'use strict';
/**
 * The world of the cloud-folder source tests (cloudFolder*.test.js): a fake storage and a fake
 * extractor behind the adapter's `deps.cloud`, the refresh engine's stores as doubles, and the
 * shapes of a listed file, a folder, the source and a stored document.
 * A test file calls `useCloudWorld()` once: it puts the env caps and the failure memory back after each test.
 */

const test = require('node:test');
const cloudFolder = require('./cloudFolder.mts');

const KB = { id: 'kb1', tenant_id: 'tenant1', organization_id: 'org1' };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ENV = ['KB_CLOUD_MAX_FILES', 'KB_CLOUD_MAX_FILE_MB', 'KB_CLOUD_CHANGE_POLL_SECONDS'];
/** Put the caps and the failure memory back after each test. */
function useCloudWorld() {
    test.afterEach(() => { for (const k of ENV) delete process.env[k]; cloudFolder.forgetFailures(); });
}

const file = (id, name, extra = {}) => ({
    provider: 'nextcloud_files', fileId: id, driveId: null, path: `/Docs/${name}`, name, mimeType: 'application/pdf',
    format: 'pdf', size: 100, modifiedAt: '2026-09-01T10:00:00Z', webUrl: `https://nc/f/${id}`, isFolder: false,
    marker: { etag: `"${id}-v1"` }, ...extra,
});
const folder = (id, name, extra = {}) => ({ provider: 'nextcloud_files', fileId: id, path: `/Docs/${name}`, name, isFolder: true, ...extra });

/** A storage with a tree: key = the folder path, value = its entries (or an Error to throw). */
function fakeStorage({ tree = {}, cursor = null, linkerError = null, extractImpl = null } = {}) {
    const calls = { list: [], download: [], extract: [], resolved: 0, changeCursor: [] };
    const api = {
        list: async (opts) => {
            const key = opts.path || (opts.parentId && typeof opts.parentId === 'object' ? opts.parentId.id : opts.parentId) || '/';
            calls.list.push(key);
            const node = tree[key];
            if (node instanceof Error) throw node;
            return { items: node || [], nextPageToken: null };
        },
        download: async (ref, opts) => {
            calls.download.push({ ref, opts });
            return { buffer: Buffer.from(`BYTES-${ref.fileId}`), marker: { etag: `"${ref.fileId}-dl"` } };
        },
        ...(cursor ? { changeCursor: async (f, c) => { calls.changeCursor.push({ f, c }); return cursor(f, c); } } : {}),
    };
    const cloud = {
        resolveLinker: async (source, opts) => {
            calls.resolved += 1;
            calls.linkerArgs = { source, opts };
            if (linkerError) throw linkerError;
            return { api };
        },
        extract: async (buffer, mime, filename) => {
            calls.extract.push({ mime, filename });
            if (extractImpl) return extractImpl(buffer, mime, filename);
            return { text: `text of ${filename}`, meta: { pageCount: 3, sheetNames: null } };
        },
    };
    return { calls, cloud };
}

function engine({ stored = [], storage, cursorStore = true } = {}) {
    const calls = { ingest: [], reingest: [], deleted: [], cursor: [] };
    const deps = {
        kbStore: {
            getKB: async () => KB,
            listDocuments: async (kbId, { offset = 0 } = {}) => (offset > 0 ? [] : stored),
            getDocument: async (id) => stored.find((d) => d.id === id) || null,
            bumpKBVersion: async () => {},
        },
        kbSourcesStore: {
            isCancelRequested: async () => false,
            ...(cursorStore ? { setSyncCursor: async (id, c) => { calls.cursor.push({ id, c }); } } : {}),
        },
        helpers: {
            ingestDocument: async (t, k, content, title, sourceType, sourceUri, opts) => {
                calls.ingest.push({ content, title, sourceType, sourceUri, ...opts });
                return { document: { id: `new_${opts.externalId}` }, chunks: 1, status: 'processed' };
            },
            reingestDocument: async (t, k, docId, content, opts) => {
                calls.reingest.push({ docId, content, ...opts });
                return { document: { id: docId }, chunks: 1, status: 'processed' };
            },
            deleteDocumentChunks: async (kbId, docId) => { calls.deleted.push(docId); },
        },
        extractSummary: { summarise: async () => ({ summary: null }) },
        cloud: storage.cloud,
    };
    return { deps, calls };
}

const SOURCE = {
    id: 'src1', knowledgeBaseId: 'kb1', kind: 'cloud_folder', refreshMode: 'on_change', createdBy: 'u1',
    config: { provider: 'nextcloud_files', path: '/Docs', folderName: 'Docs', recursive: true },
};
const stored = (id, externalId, marker, over = {}) => ({
    id, external_id: externalId, title: externalId, status: 'processed', metadata: marker ? { marker } : {}, ...over,
});

module.exports = { useCloudWorld, KB, DOCX, file, folder, fakeStorage, engine, SOURCE, stored };
