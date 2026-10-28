// @typecheck strict
/**
 * Output schemas of the Nextcloud FILES tools (integrations/nextcloudFiles/:
 * fileOperations, search, sharing, comments, tags, trash, versions), read off
 * the handlers' success returns. Same contract as ./outputSchemas.js: `shape`
 * names the top-level fields, `sample` is the dry-run placeholder, and `echo`
 * maps a sample field (dotted path) to the tool argument whose value a dry run
 * puts there, so a preview of "upload /Reports/q3.pdf" shows that path.
 *
 * nextcloud_list_files and nextcloud_read_file live in ./outputSchemasPart2.js.
 */
'use strict';

const FILE_ITEM = '{ name, path, type (file|folder), size, contentType, modified, fileId }';
const SAMPLE_FILE = { name: 'Invoice-2026-001.pdf', path: '/Invoices/Invoice-2026-001.pdf', type: 'file', size: 51200, contentType: 'application/pdf', modified: 'Mon, 05 Oct 2026 09:12:00 GMT', fileId: 4211 };

/** @type {Record<string, import('./outputSchemas').OutputSchema>} */
const OUTPUT_SCHEMAS_NEXTCLOUD_FILES = {
    // ── Files: reads ──────────────────────────────────────────────
    nextcloud_search_files: {
        shape: { query: 'string', count: 'integer', items: 'array of { name, path, subline, url }' },
        sample: { query: 'invoice', count: 1, items: [{ name: 'Invoice-2026-001.pdf', path: '/Invoices/Invoice-2026-001.pdf', subline: 'in Invoices', url: 'https://cloud.example.com/f/4211' }] },
        echo: { query: 'query' },
    },
    nextcloud_search: {
        // Unified search across providers (files, mail, deck, talk, ...).
        shape: { query: 'string', count: 'integer', results: 'array of { provider, providerName, title, subline, link, icon, path, fileId }', availableProviders: 'array of string', providersUnavailable: 'array of string|undefined' },
        sample: { query: 'budget', count: 1, results: [{ provider: 'files', providerName: 'Files', title: 'Budget 2026.xlsx', subline: 'in Finance', link: 'https://cloud.example.com/f/512', icon: null, path: '/Finance/Budget 2026.xlsx', fileId: 512 }], availableProviders: ['files', 'mail', 'deck', 'talk-message'] },
        echo: { query: 'query' },
    },
    nextcloud_folder_tree: {
        // Nodes as Nextcloud returns them, each with its full `path`; the
        // children are under `children`.
        shape: { depth: 'integer', tree: 'array of { id, basename, displayName, path, children }' },
        sample: { depth: 3, tree: [{ id: 101, basename: 'Invoices', displayName: 'Invoices', path: '/Invoices', children: [{ id: 102, basename: '2026', displayName: '2026', path: '/Invoices/2026', children: [] }] }] },
        echo: { depth: 'depth' },
    },
    nextcloud_direct_link: {
        shape: { fileId: 'integer', url: 'string (valid for 24 hours)', expiresInHours: 'integer' },
        sample: { fileId: 4211, url: 'https://cloud.example.com/s/dl-sample', expiresInHours: 24 },
        echo: { fileId: 'fileId' },
    },
    nextcloud_list_groups: {
        shape: { count: 'integer', groups: 'array of string (group ids)' },
        sample: { count: 2, groups: ['admin', 'finance'] },
    },
    nextcloud_list_shares: {
        shape: { count: 'integer', shares: 'array of { id, shareType, shareWith, shareWithDisplayName, path, fileTarget, permissions, expiration, token, url, stime, note }' },
        sample: { count: 1, shares: [{ id: 37, shareType: 3, shareWith: null, shareWithDisplayName: null, path: '/Reports/Q3.pdf', fileTarget: '/Q3.pdf', permissions: 1, expiration: null, token: 'aBcD1234', url: 'https://cloud.example.com/s/aBcD1234', stime: 1791100000, note: '' }] },
    },
    nextcloud_list_file_comments: {
        shape: { fileId: 'integer|string', count: 'integer', comments: 'array of { id, message, actor, actorId, created }' },
        sample: { fileId: 4211, count: 1, comments: [{ id: 12, message: 'Checked, looks good.', actor: 'Alice', actorId: 'alice', created: 'Mon, 05 Oct 2026 10:00:00 GMT' }] },
        echo: { fileId: 'fileId' },
    },
    nextcloud_list_tags: {
        shape: { count: 'integer', tags: 'array of { id, name, userVisible, userAssignable }' },
        sample: { count: 2, tags: [{ id: 3, name: 'paid', userVisible: true, userAssignable: true }, { id: 4, name: 'to-review', userVisible: true, userAssignable: true }] },
    },
    nextcloud_find_files_by_tag: {
        shape: { tagId: 'integer|string', count: 'integer', items: `array of ${FILE_ITEM}` },
        sample: { tagId: 3, count: 1, items: [SAMPLE_FILE] },
        echo: { tagId: 'tagId' },
    },
    nextcloud_list_trash: {
        shape: { count: 'integer', items: 'array of { name, trashPath, type (file|folder), size, fileId, originalLocation, deletionTime }' },
        sample: { count: 1, items: [{ name: 'old-draft.docx', trashPath: '/trash/old-draft.docx.d1791100000', type: 'file', size: 18000, fileId: '4300', originalLocation: 'Drafts/old-draft.docx', deletionTime: '2026-10-01T08:00:00.000Z' }] },
    },
    nextcloud_list_versions: {
        shape: { fileId: 'integer|string', count: 'integer', versions: 'array of { versionId, size, modified, contentType, href }' },
        sample: { fileId: 4211, count: 1, versions: [{ versionId: '1791000000', size: 50100, modified: 'Sun, 04 Oct 2026 16:00:00 GMT', contentType: 'application/pdf', href: '/remote.php/dav/versions/alice/versions/4211/1791000000' }] },
        echo: { fileId: 'fileId' },
    },

    // ── Files: writes ─────────────────────────────────────────────
    nextcloud_upload_file: {
        shape: { success: 'boolean', path: 'string', bytes: 'integer', created: 'boolean (a new file)', updated: 'boolean (an existing file was overwritten)' },
        sample: { success: true, path: '/Reports/report.txt', bytes: 1024, created: true, updated: false },
        echo: { path: 'path' },
    },
    nextcloud_convert_file: {
        shape: { success: 'boolean', sourceFileId: 'integer', targetMimeType: 'string', path: 'string|null', fileId: 'integer|null' },
        sample: { success: true, sourceFileId: 4211, targetMimeType: 'application/pdf', path: '/Reports/report.pdf', fileId: 4212 },
        echo: { sourceFileId: 'fileId', targetMimeType: 'targetMimeType', path: 'destination' },
    },
    nextcloud_create_folder: {
        shape: { success: 'boolean', path: 'string' },
        sample: { success: true, path: '/Reports/2026' },
        echo: { path: 'path' },
    },
    nextcloud_delete: {
        shape: { success: 'boolean', path: 'string' },
        sample: { success: true, path: '/Reports/old.txt' },
        echo: { path: 'path' },
    },
    nextcloud_move: {
        shape: { success: 'boolean', operation: 'string (move)', source: 'string', destination: 'string', overwritten: 'boolean' },
        sample: { success: true, operation: 'move', source: '/Inbox/scan.pdf', destination: '/Archive/scan.pdf', overwritten: false },
        echo: { source: 'source', destination: 'destination' },
    },
    nextcloud_copy: {
        shape: { success: 'boolean', operation: 'string (copy)', source: 'string', destination: 'string', overwritten: 'boolean' },
        sample: { success: true, operation: 'copy', source: '/Templates/offer.docx', destination: '/Offers/offer-2026.docx', overwritten: false },
        echo: { source: 'source', destination: 'destination' },
    },
    nextcloud_create_share: {
        // A public link share.
        shape: { success: 'boolean', url: 'string|null', token: 'string|null', id: 'integer|string', path: 'string', expiration: 'string|null' },
        sample: { success: true, url: 'https://cloud.example.com/s/aBcD1234', token: 'aBcD1234', id: 37, path: '/Reports/Q3.pdf', expiration: null },
        echo: { path: 'path' },
    },
    nextcloud_share_with_user: {
        shape: { success: 'boolean', id: 'integer|string', shareId: 'integer|string', shareType: 'integer (0 = user)', shareWith: 'string', path: 'string', permissions: 'integer', expiration: 'string|null' },
        sample: { success: true, id: 38, shareId: 38, shareType: 0, shareWith: 'bob', path: '/Reports/Q3.pdf', permissions: 1, expiration: null },
        echo: { shareWith: 'shareWith', path: 'path', permissions: 'permissions' },
    },
    nextcloud_share_with_group: {
        shape: { success: 'boolean', id: 'integer|string', shareId: 'integer|string', shareType: 'integer (1 = group)', shareWith: 'string', path: 'string', permissions: 'integer', expiration: 'string|null' },
        sample: { success: true, id: 39, shareId: 39, shareType: 1, shareWith: 'finance', path: '/Reports/Q3.pdf', permissions: 1, expiration: null },
        echo: { shareWith: 'shareWith', path: 'path', permissions: 'permissions' },
    },
    nextcloud_share_by_email: {
        shape: { success: 'boolean', id: 'integer|string', shareId: 'integer|string', shareType: 'integer (4 = e-mail)', shareWith: 'string', path: 'string', permissions: 'integer', expiration: 'string|null' },
        sample: { success: true, id: 40, shareId: 40, shareType: 4, shareWith: 'someone@example.com', path: '/Reports/Q3.pdf', permissions: 1, expiration: null },
        echo: { shareWith: 'shareWith', path: 'path' },
    },
    nextcloud_update_share: {
        shape: { success: 'boolean', shareId: 'integer|string' },
        sample: { success: true, shareId: 37 },
        echo: { shareId: 'shareId' },
    },
    nextcloud_delete_share: {
        shape: { success: 'boolean', shareId: 'integer|string' },
        sample: { success: true, shareId: 37 },
        echo: { shareId: 'shareId' },
    },
    nextcloud_add_file_comment: {
        shape: { success: 'boolean', fileId: 'integer|string', commentId: 'integer|null' },
        sample: { success: true, fileId: 4211, commentId: 13 },
        echo: { fileId: 'fileId' },
    },
    nextcloud_create_tag: {
        shape: { success: 'boolean', id: 'integer|null', name: 'string' },
        sample: { success: true, id: 5, name: 'archived' },
        echo: { name: 'name' },
    },
    nextcloud_tag_file: {
        shape: { success: 'boolean', fileId: 'integer|string', tagId: 'integer|string' },
        sample: { success: true, fileId: 4211, tagId: 3 },
        echo: { fileId: 'fileId', tagId: 'tagId' },
    },
    nextcloud_untag_file: {
        shape: { success: 'boolean', fileId: 'integer|string', tagId: 'integer|string' },
        sample: { success: true, fileId: 4211, tagId: 3 },
        echo: { fileId: 'fileId', tagId: 'tagId' },
    },
    nextcloud_restore_from_trash: {
        shape: { success: 'boolean', restoredFrom: 'string (the trashPath)' },
        sample: { success: true, restoredFrom: '/trash/old-draft.docx.d1791100000' },
        echo: { restoredFrom: 'trashPath' },
    },
    nextcloud_permanent_delete_trash: {
        shape: { success: 'boolean', deleted: 'string (the trashPath)' },
        sample: { success: true, deleted: '/trash/old-draft.docx.d1791100000' },
        echo: { deleted: 'trashPath' },
    },
    nextcloud_restore_version: {
        shape: { success: 'boolean', fileId: 'integer|string', versionId: 'string' },
        sample: { success: true, fileId: 4211, versionId: '1791000000' },
        echo: { fileId: 'fileId', versionId: 'versionId' },
    },
};

module.exports = { OUTPUT_SCHEMAS_NEXTCLOUD_FILES };
