// @typecheck noImplicitAny
/**
 * OneDrive (Microsoft Graph) as a spreadsheet-mirror storage — the linker's
 * personal drive plus what is shared with them; no SharePoint libraries
 * (that needs Sites.* scopes the login does not ask for).
 *
 * Everything goes through msGraphClient.graphRequest, the raw variant that
 * keeps the HTTP status: 412 (the file moved under our If-Match), 423 (Excel
 * has it locked) and 404 each mean something different to the engine.
 * Three Graph facts shape the code:
 *   • an item has TWO tags. `cTag` moves only when the CONTENT changes and is
 *     the marker the mirror compares; `eTag` also moves on a rename or a
 *     move and is what `If-Match` must carry. The marker stores both.
 *   • the own drive id is fetched once (GET /me/drive) and every item is
 *     addressed as /drives/{driveId}/items/{id}, so an own file and a
 *     shared-with-me file (which lives in SOMEONE ELSE's drive —
 *     remoteItem.parentReference.driveId) go through one code path. `owned`
 *     is exactly "that driveId is mine".
 *   • bytes are fetched from the pre-authenticated @microsoft.graph.downloadUrl
 *     with a bare fetch — that host is NOT Graph and must never see the
 *     bearer token. Simple upload (PUT …/content) is capped at 4 MB by Graph;
 *     above that an upload session with ranged PUTs is used, and it honours
 *     If-Match too.
 * The Excel workbook API (…/workbook/…) gives cell-precise reads and writes
 * for xlsx/xlsm — on OneDrive for Business. Consumer accounts are routinely
 * refused (ApiNotSupported / AccessDenied), so `detectWorkbook` is asked per
 * file at describe time and the engine falls back to exceljs + PUT. Workbook
 * writes run inside one persisted session (workbook-session-id) and close it
 * in `finally`; they have no If-Match, so the guard is emulated (probe cTag
 * before, refuse when moved, re-probe after).
 * Dates cross this boundary as Excel serial numbers in both directions.
 * A TEXT cell whose value starts with = + - @ (or a tab / CR) is typed Text
 * (numberFormat '@') BEFORE the value lands: Range.values parses such a
 * string as a formula otherwise, so `=WEBSERVICE(…)` typed by an editor
 * would run in the linker's Excel, and a Dutch phone number ("+31 6 …")
 * would be refused as a broken formula. The format goes in its own PATCH
 * ahead of the value — Graph does not promise the order of keys in one
 * body. The same rule the CSV export in routes/datatables.js applies.
 *
 * The vocabulary is in ./oneDriveFormat.js, the workbook cells in
 * ./oneDriveWorkbook.js.
 */

'use strict';

const { SpreadsheetSourceError, fromHttp } = require('../errors');
// The Graph client is injected by integrations/ (core/integrations/integrationClients.js).
const { integrationClient } = require('../../../../integrations/integrationClients');
const format = require('./oneDriveFormat');
const { makeWorkbookCells } = require('./oneDriveWorkbook');

const {
    provider, oauthProvider, integrationAppIds,
    PAGE_SIZE, ITEM_SELECT, PROBE_SELECT, SIMPLE_UPLOAD_MAX, UPLOAD_CHUNK, DOWNLOAD_TIMEOUT_MS,
    refusalRef, markerOf, markerEquals, toFileRef, graphError,
} = format;

/** @typedef {import('./index').FileRef} FileRef */
/** @typedef {import('./oneDriveFormat').DriveItem} DriveItem */
/** @typedef {import('./oneDriveFormat').GraphMarker} GraphMarker */
/** @typedef {{ what?: string, file?: FileRef|null, okStatuses?: number[]|null }} CallMeta */
/**
 * The api context makeApi builds; the bound helpers are attached right after
 * the object is created.
 * @typedef {{ cred: object,
 *             ownDrivePromise: Promise<string|null>|null,
 *             mine: string|null,
 *             workbookKnown: Map<string, boolean>,
 *             graph: typeof graph,
 *             refOf?: (file: FileRef) => ReturnType<typeof refusalRef>,
 *             call?: (path: string, options?: RequestInit, meta?: CallMeta) => Promise<Response>,
 *             json?: (path: string, options?: RequestInit, meta?: CallMeta) => ReturnType<typeof json>,
 *             itemPath?: (file: FileRef) => Promise<string>,
 *             probe?: (file: FileRef) => ReturnType<typeof probe> }} GraphCtx
 */
/** @typedef {string | { id?: string, driveId?: string }} ParentId */
/**
 * A parsed Graph answer: a driveItem, a collection page, an upload session
 * or a workbook range / session, depending on the path.
 * @typedef {DriveItem & { value?: GraphBody[], uploadUrl?: string, '@odata.nextLink'?: string,
 *             position?: number, visibility?: string, address?: string, rowCount?: number, columnCount?: number,
 *             values?: unknown[][], numberFormat?: unknown[][], formulas?: unknown[][] }} GraphBody
 */

/** @returns {{ graphRequest: (path: string, session: object, options?: RequestInit) => Promise<Response>, GRAPH_BASE: string }} */
function graph() {
    return integrationClient('msGraph');
}

// ─── The FileApi ────────────────────────────────────────────────────────
//
// Every function below takes the api context `g` makeApi builds (one per
// api instance: the own drive id is learned once, the workbook answer is
// remembered per file).

/**
 * graphRequest with the mirror's error translation; returns the Response.
 * @param {GraphCtx} g
 * @param {string} path
 * @param {RequestInit} [options]
 * @param {CallMeta} [meta]
 * @returns {Promise<Response>}
 */
async function call(g, path, options = {}, { what = 'file', file = null, okStatuses = null } = {}) {
    let res;
    try {
        res = await graph().graphRequest(path, g.cred, options);
    } catch (e) {
        if (e && e.message === 'NOT_CONNECTED') throw fromHttp(provider, 401, '', what, { ref: g.refOf(file) });
        throw e;
    }
    const ok = okStatuses ? okStatuses.includes(res.status) : res.ok;
    if (!ok) {
        const { code, message } = await graphError(res);
        const err = /** @type {InstanceType<typeof SpreadsheetSourceError> & { graphCode?: string }} */ (fromHttp(provider, res.status, message, what, { ref: g.refOf(file) }));
        if (code) err.graphCode = code;
        throw err;
    }
    return res;
}

/**
 * @param {GraphCtx} g
 * @param {string} path
 * @param {RequestInit} [options]
 * @param {CallMeta} [meta]
 * @returns {Promise<GraphBody>} the parsed Graph body ({} for 202/204)
 */
async function json(g, path, options, meta) {
    const res = await call(g, path, options, meta);
    if (res.status === 204 || res.status === 202) return {};
    return /** @type {Promise<GraphBody>} */ (res.json());
}

/**
 * @param {GraphCtx} g
 * @returns {Promise<string|null>}
 */
async function ownDriveId(g) {
    if (!g.ownDrivePromise) {
        g.ownDrivePromise = json(g, '/me/drive?$select=id', {}, { what: 'drive' })
            .then((d) => { g.mine = d.id || null; return g.mine; })
            .catch((e) => { g.ownDrivePromise = null; throw e; });
    }
    return g.ownDrivePromise;
}

/**
 * @param {GraphCtx} g
 * @param {FileRef} file
 */
async function itemPath(g, file) {
    const id = file && (file.fileId || file.id);
    if (!id) throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A OneDrive file needs an id.');
    const driveId = (file && file.driveId) || await ownDriveId(g);
    return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}`;
}

/**
 * The Graph path a listing view asks for; null for a search without a term.
 * @param {{ view?: string, parentId?: ParentId|null, q?: string|null, pageToken?: string|null, mine?: string|null }} opts
 */
function listPath({ view, parentId, q, pageToken, mine }) {
    if (pageToken) {
        // An @odata.nextLink is opaque, but it must still be a Graph URL —
        // it is fetched with the bearer.
        if (!String(pageToken).startsWith(graph().GRAPH_BASE)) {
            throw new SpreadsheetSourceError(400, 'spreadsheet_rejected', 'That page token is not a OneDrive page.');
        }
        return pageToken;
    }
    if (view === 'search') {
        const term = String(q || '').trim();
        if (!term) return null;
        return `/me/drive/search(q='${encodeURIComponent(term.replace(/'/g, "''"))}')?$top=${PAGE_SIZE}&$select=${ITEM_SELECT}`;
    }
    if (view === 'shared' && !parentId) return `/me/drive/sharedWithMe?$select=id,name,remoteItem`;
    if (view === 'recent') return `/me/drive/recent?$top=${PAGE_SIZE}&$select=${ITEM_SELECT}`;
    if (!parentId || parentId === 'root') return `/me/drive/root/children?$top=${PAGE_SIZE}&$select=${ITEM_SELECT}&$orderby=name`;
    // A folder id may come with its drive ("<driveId>!<itemId>" is
    // OneDrive's own id shape, so a shared folder's id carries its
    // drive already; a plain id is looked up in the own drive).
    const driveId = (parentId && typeof parentId === 'object' && parentId.driveId) || mine;
    const id = /** @type {string} */ (parentId && typeof parentId === 'object' ? parentId.id : parentId);
    return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}/children?$top=${PAGE_SIZE}&$select=${ITEM_SELECT}&$orderby=name`;
}

/**
 * @param {GraphCtx} g
 * @param {{ view?: string, parentId?: ParentId|null, q?: string|null, pageToken?: string|null }} [opts]
 */
async function list(g, { view = 'mine', parentId = null, q = null, pageToken = null } = {}) {
    const mine = await ownDriveId(g);
    const path = listPath({ view, parentId, q, pageToken, mine });
    if (path === null) return { items: [], nextPageToken: null };
    const data = await json(g, path, {}, { what: 'folder', file: { fileId: /** @type {string|null} */ (parentId && typeof parentId === 'object' ? parentId.id : parentId) } });
    const items = (data.value || [])
        .map((/** @type {DriveItem} */ it) => toFileRef(it, { ownDriveId: mine, parentId: typeof parentId === 'string' ? parentId : null }))
        .filter(Boolean);
    return { items, nextPageToken: data['@odata.nextLink'] || null };
}

/**
 * @param {GraphCtx} g
 * @param {FileRef} file
 */
async function probeItem(g, file) {
    const item = await json(g, `${await itemPath(g, file)}?$select=${PROBE_SELECT}`, {}, { what: 'file', file });
    if (!item || item.deleted) {
        throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', 'OneDrive no longer has this file.', { ref: g.refOf(file) });
    }
    return item;
}

/**
 * @param {GraphCtx} g
 * @param {FileRef} file
 */
async function probe(g, file) {
    const mine = await ownDriveId(g);
    const item = await probeItem(g, file);
    const ref = /** @type {import('./index').FileRef} */ (toFileRef(item, { ownDriveId: mine }));
    if (!ref) {
        throw new SpreadsheetSourceError(415, 'format_unsupported', `"${item.name}" is not a spreadsheet Bee Flow can read.`, { ref: g.refOf(file) });
    }
    return {
        marker: markerOf(item),
        name: ref.name,
        size: ref.size,
        mimeType: ref.mimeType,
        format: ref.format,
        path: ref.path,
        webUrl: ref.webUrl,
        owned: ref.owned,
        // Graph has no cheap per-item permission fact; a refused write
        // surfaces as spreadsheet_forbidden at write time.
        writable: true,
        file: ref,
        downloadUrl: item['@microsoft.graph.downloadUrl'] || null,
    };
}

/**
 * @param {GraphCtx} g
 * @param {FileRef} file
 * @param {{ maxBytes?: number|null }} [opts]
 */
async function download(g, file,{ maxBytes = null } = {}) {
    const p = await probe(g, file);
    if (maxBytes && p.size != null && p.size > maxBytes) {
        throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is ${Math.round(p.size / 1048576)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB.`, { ref: g.refOf(file) });
    }
    if (!p.downloadUrl) {
        throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', 'OneDrive gave no download link for this file.', { ref: g.refOf(file) });
    }
    // Pre-authenticated URL on a content host: a bare fetch, NO bearer.
    let res;
    try {
        res = await fetch(p.downloadUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    } catch (e) {
        throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', `OneDrive did not deliver the file (${e && e.name === 'TimeoutError' ? 'timeout' : 'network error'}).`, { ref: g.refOf(file) });
    }
    if (!res.ok) throw fromHttp(provider, res.status, '', 'file', { ref: g.refOf(file) });
    const buffer = Buffer.from(await res.arrayBuffer());
    if (maxBytes && buffer.length > maxBytes) {
        throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is larger than ${Math.round(maxBytes / 1048576)} MB.`, { ref: g.refOf(file) });
    }
    return { buffer, marker: p.marker };
}

/**
 * The ranged PUTs of an upload session (pre-authenticated — no bearer on that host either).
 * @param {GraphCtx} g
 * @param {FileRef} file
 * @param {string} uploadUrl
 * @param {Buffer} buffer
 * @returns {Promise<DriveItem|null>}
 */
async function uploadChunks(g, file, uploadUrl, buffer) {
    let item = null;
    for (let start = 0; start < buffer.length; start += UPLOAD_CHUNK) {
        const end = Math.min(start + UPLOAD_CHUNK, buffer.length);
        const chunk = buffer.subarray(start, end);
        let res;
        try {
            res = await fetch(uploadUrl, {
                method: 'PUT',
                headers: {
                    'Content-Length': String(chunk.length),
                    'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}`,
                },
                // A Node Buffer is backed by a plain (not shared) ArrayBuffer.
                body: /** @type {Uint8Array<ArrayBuffer>} */ (chunk),
                signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
            });
        } catch (e) {
            throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', `OneDrive dropped the upload (${e && e.name === 'TimeoutError' ? 'timeout' : 'network error'}).`, { ref: g.refOf(file) });
        }
        if (!res.ok) {
            const { message } = await graphError(res);
            throw fromHttp(provider, res.status, message, 'file', { ref: g.refOf(file) });
        }
        if (res.status === 200 || res.status === 201) item = await res.json().catch(/** @returns {null} */ () => null);
    }
    return item;
}

/**
 * Replace the file's content. `ifMatch` is the marker the bytes were
 * derived from; its eTag goes out as If-Match and Graph answers 412 when
 * the file moved (→ spreadsheet_conflict). Content type is left to Graph
 * (it types by extension) — an octet-stream body never mislabels a file.
 * @param {GraphCtx} g
 * @param {FileRef} file
 * @param {Buffer} buffer
 * @param {{ ifMatch?: GraphMarker|null, contentType?: string|null }} [opts]
 */
async function upload(g, file, buffer, { ifMatch = null, contentType = null } = {}) {
    void contentType;
    const base = await itemPath(g, file);
    const ifMatchHeader = ifMatch && ifMatch.eTag ? { 'If-Match': ifMatch.eTag } : {};
    if (buffer.length <= SIMPLE_UPLOAD_MAX) {
        const item = await json(g, `${base}/content`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/octet-stream', ...ifMatchHeader },
            body: /** @type {Uint8Array<ArrayBuffer>} */ (buffer),
        }, { what: 'file', file });
        return { marker: markerOf(item) };
    }
    // Above 4 MB: an upload session, then ranged PUTs to the session URL.
    const session = await json(g, `${base}/createUploadSession`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...ifMatchHeader },
        body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
    }, { what: 'file', file });
    if (!session.uploadUrl) {
        throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', 'OneDrive did not open an upload session.', { ref: g.refOf(file) });
    }
    const item = (await uploadChunks(g, file, session.uploadUrl, buffer)) || await probeItem(g, file);
    return { marker: markerOf(item) };
}

/**
 * @param {object} cred
 * @param {object} [ctx]
 */
function makeApi(cred, ctx = {}) {
    void ctx;
    /** @type {GraphCtx} */
    const g = {
        cred,
        ownDrivePromise: null,
        mine: null,                   // the own drive id once learned (refOf reads it)
        workbookKnown: new Map(),     // fileId → boolean (per api instance)
        graph,
    };
    g.refOf = (file) => refusalRef(file, g.mine);
    g.call = (...a) => call(g, ...a);
    g.json = (...a) => json(g, ...a);
    g.itemPath = (file) => itemPath(g, file);
    g.probe = (file) => probe(g, file);
    return {
        provider,
        /** @param {Parameters<typeof list>[1]} [opts] */
        list: (opts) => list(g, opts),
        probe: g.probe,
        /** @param {FileRef} file @param {Parameters<typeof download>[2]} [opts] */
        download: (file, opts) => download(g, file, opts),
        /** @param {FileRef} file @param {Buffer} buffer @param {Parameters<typeof upload>[3]} [opts] */
        upload: (file, buffer, opts) => upload(g, file, buffer, opts),
        markerEquals,
        cells: makeWorkbookCells(g),
        ownDriveId: () => ownDriveId(g),
    };
}

/**
 * Cheap: a vault row or session tokens for Microsoft — no provider call.
 * @param {{ userId?: string, session?: object|null }} [opts]
 */
async function isConnected({ userId, session = null } = {}) {
    return require('../credentials').cheapStatus(userId, oauthProvider, { session });
}

module.exports = {
    provider, oauthProvider, integrationAppIds,
    isConnected,
    forCaller: makeApi,
    forLinker: makeApi,
    markerEquals,
    // exported for tests
    toFileRef, parseAddress: format.parseAddress, colLetter: format.colLetter, workbookValue: format.workbookValue,
    workbookFormat: format.workbookFormat, needsTextFormat: format.needsTextFormat, refOf: refusalRef, pathOf: format.pathOf,
    SIMPLE_UPLOAD_MAX, UPLOAD_CHUNK, ITEM_SELECT, PROBE_SELECT,
};
