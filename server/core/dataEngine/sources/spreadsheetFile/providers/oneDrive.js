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
 */

'use strict';

const { SpreadsheetSourceError, fromHttp } = require('../errors');
const { formulaShaped } = require('../cells');
const { formatOf } = require('./index');

const provider = 'onedrive';
const oauthProvider = 'microsoft';
const integrationAppIds = ['onedrive'];

const PAGE_SIZE = 50;
const ITEM_SELECT = 'id,name,size,eTag,cTag,lastModifiedDateTime,file,folder,webUrl,parentReference,remoteItem';
const PROBE_SELECT = 'id,name,size,eTag,cTag,lastModifiedDateTime,file,folder,webUrl,parentReference,deleted,@microsoft.graph.downloadUrl';
/** Graph refuses a simple PUT …/content above this; larger bodies go through an upload session. */
const SIMPLE_UPLOAD_MAX = 4 * 1024 * 1024;
/** Upload-session ranges must be multiples of 320 KiB; 10 of them per PUT. */
const UPLOAD_CHUNK = 10 * 320 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** Excel serial number formats: a d/m/y token outside a [colour] or literal. */
const DATE_FORMAT_RE = /[dmy]/i;
const TIME_FORMAT_RE = /[hs]|AM\/PM/i;

function graph() {
    return require('../../../../../integrations/msGraphClient');
}

// ─── Small helpers ──────────────────────────────────────────────────────

/** 0-based column → letter(s). */
function colLetter(col) {
    let n = Number(col) + 1;
    let s = '';
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

/** `Sheet1!C3:F20` → { sheet, first:{col,row}, last:{col,row} } (1-based rows, 0-based cols). */
function parseAddress(address) {
    const s = String(address || '');
    const bang = s.lastIndexOf('!');
    const range = bang >= 0 ? s.slice(bang + 1) : s;
    const m = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(range);
    if (!m) return null;
    const col = (l) => l.toUpperCase().split('').reduce((acc, ch) => acc * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
    const first = { col: col(m[1]), row: Number(m[2]) };
    const last = m[3] ? { col: col(m[3]), row: Number(m[4]) } : { ...first };
    return { sheet: bang >= 0 ? s.slice(0, bang).replace(/^'|'$/g, '') : null, first, last };
}

/**
 * The ref a refusal carries. Its id is the browser's own: an item outside
 * the own drive keeps its `drive|item` spelling, so a wizard mark keyed on
 * that id lands. "Outside" is `driveId !== ownDriveId` once the own drive
 * is known (every api call learns it first); before that, a `driveId` on
 * the ref is the client's composite id echoed back.
 */
function refusalRef(file, ownDriveId = null) {
    const id = file && (file.fileId || file.id) || null;
    const driveId = file && file.driveId || null;
    const foreign = !!driveId && (ownDriveId ? driveId !== ownDriveId : file.owned !== true);
    return { provider, fileId: id && foreign ? `${driveId}|${id}` : id };
}

function markerOf(item) {
    return {
        eTag: item.eTag || null,
        cTag: item.cTag || null,
        lastModifiedDateTime: item.lastModifiedDateTime || null,
        size: item.size != null ? Number(item.size) : null,
    };
}

function markerEquals(a, b) {
    return !!a && !!b && a.cTag != null && a.cTag === b.cTag;
}

/** `/drive/root:/Documents/Q3` + name → `/Documents/Q3/name`. */
function pathOf(item) {
    const pr = item.parentReference || {};
    const raw = typeof pr.path === 'string' ? pr.path : null;
    if (raw === null) return null;
    const idx = raw.indexOf(':');
    const folder = idx >= 0 ? raw.slice(idx + 1) : '';
    let decoded = folder;
    try { decoded = decodeURIComponent(folder); } catch (_) { /* keep raw */ }
    return `${decoded.replace(/\/$/, '')}/${item.name || ''}`;
}

/**
 * A driveItem → FileRef. A sharedWithMe entry is a stub whose real data is
 * under `remoteItem`; the ref then points at the remote drive + id.
 * @returns {object|null} null for anything that is neither a folder nor a spreadsheet
 */
function toFileRef(item, { ownDriveId = null, parentId = null } = {}) {
    if (!item) return null;
    const src = item.remoteItem ? { ...item.remoteItem, name: item.remoteItem.name || item.name } : item;
    if (!src.id) return null;
    const driveId = (src.parentReference && src.parentReference.driveId) || (item.remoteItem ? null : ownDriveId);
    const isFolder = !!src.folder;
    const mimeType = (src.file && src.file.mimeType) || null;
    const format = isFolder ? null : formatOf({ name: src.name, mimeType });
    if (!isFolder && !format) return null;
    return {
        provider,
        fileId: src.id,
        driveId: driveId || null,
        path: pathOf(src),
        name: src.name || '',
        mimeType,
        format,
        size: src.size != null ? Number(src.size) : null,
        modifiedAt: src.lastModifiedDateTime || null,
        etag: src.eTag || null,
        webUrl: src.webUrl || null,
        parentId: (src.parentReference && src.parentReference.id) || parentId || null,
        isFolder,
        owned: !item.remoteItem && !!driveId && driveId === ownDriveId,
    };
}

/** Read a Graph error body → { code, message } (both may be empty). */
async function graphError(res) {
    const text = await res.text().catch(() => '');
    try {
        const j = JSON.parse(text);
        return { code: (j.error && j.error.code) || null, message: (j.error && j.error.message) || text };
    } catch (_) {
        return { code: null, message: text };
    }
}

/** The value a workbook cell is written as: serials for dates, "" to clear (null = "leave as is" in Graph). */
function workbookValue(value, type) {
    if (value === null || value === undefined || value === '') return '';
    switch (type) {
        case 'number':
        case 'date':
        case 'datetime': {
            const n = Number(value);
            return Number.isFinite(n) ? n : String(value);
        }
        case 'bool':
            return value === true || value === 'true' || value === 1;
        default:
            return String(value);
    }
}

/**
 * Must this cell be typed Text before the value lands? Excel's Range.values
 * parses a string starting with = + - @ (or a tab / CR) as a formula — the
 * one rule every writer shares (cells.formulaShaped): only text-shaped
 * columns; a number column's -5 is a number.
 */
function needsTextFormat(value, type) {
    return formulaShaped(value, type);
}

/** The number format a written cell needs: dates render their serial; a formula-shaped text is pinned as Text. */
function workbookFormat(type, value) {
    if (type === 'date') return 'yyyy-mm-dd';
    if (type === 'datetime') return 'yyyy-mm-dd hh:mm';
    if (needsTextFormat(value, type)) return '@';
    return null;
}

// ─── The FileApi ────────────────────────────────────────────────────────

function makeApi(cred, ctx = {}) {
    void ctx;
    let ownDrivePromise = null;
    let mine = null;                   // the own drive id once learned (refOf reads it)
    const workbookKnown = new Map();   // fileId → boolean (per api instance)
    const refOf = (file) => refusalRef(file, mine);

    /** graphRequest with the mirror's error translation; returns the Response. */
    async function call(path, options = {}, { what = 'file', file = null, okStatuses = null } = {}) {
        let res;
        try {
            res = await graph().graphRequest(path, cred, options);
        } catch (e) {
            if (e && e.message === 'NOT_CONNECTED') throw fromHttp(provider, 401, '', what, { ref: refOf(file) });
            throw e;
        }
        const ok = okStatuses ? okStatuses.includes(res.status) : res.ok;
        if (!ok) {
            const { code, message } = await graphError(res);
            const err = fromHttp(provider, res.status, message, what, { ref: refOf(file) });
            if (code) err.graphCode = code;
            throw err;
        }
        return res;
    }

    async function json(path, options, meta) {
        const res = await call(path, options, meta);
        if (res.status === 204 || res.status === 202) return {};
        return res.json();
    }

    const jsonBody = (body) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    async function ownDriveId() {
        if (!ownDrivePromise) {
            ownDrivePromise = json('/me/drive?$select=id', {}, { what: 'drive' })
                .then((d) => { mine = d.id || null; return mine; })
                .catch((e) => { ownDrivePromise = null; throw e; });
        }
        return ownDrivePromise;
    }

    async function itemPath(file) {
        const id = file && (file.fileId || file.id);
        if (!id) throw new SpreadsheetSourceError(422, 'spreadsheet_rejected', 'A OneDrive file needs an id.');
        const driveId = (file && file.driveId) || await ownDriveId();
        return `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}`;
    }

    async function list({ view = 'mine', parentId = null, q = null, pageToken = null } = {}) {
        const mine = await ownDriveId();
        let path;
        if (pageToken) {
            // An @odata.nextLink is opaque, but it must still be a Graph URL —
            // it is fetched with the bearer.
            if (!String(pageToken).startsWith(graph().GRAPH_BASE)) {
                throw new SpreadsheetSourceError(400, 'spreadsheet_rejected', 'That page token is not a OneDrive page.');
            }
            path = pageToken;
        } else if (view === 'search') {
            const term = String(q || '').trim();
            if (!term) return { items: [], nextPageToken: null };
            path = `/me/drive/search(q='${encodeURIComponent(term.replace(/'/g, "''"))}')?$top=${PAGE_SIZE}&$select=${ITEM_SELECT}`;
        } else if (view === 'shared' && !parentId) {
            path = `/me/drive/sharedWithMe?$select=id,name,remoteItem`;
        } else if (view === 'recent') {
            path = `/me/drive/recent?$top=${PAGE_SIZE}&$select=${ITEM_SELECT}`;
        } else if (!parentId || parentId === 'root') {
            path = `/me/drive/root/children?$top=${PAGE_SIZE}&$select=${ITEM_SELECT}&$orderby=name`;
        } else {
            // A folder id may come with its drive ("<driveId>!<itemId>" is
            // OneDrive's own id shape, so a shared folder's id carries its
            // drive already; a plain id is looked up in the own drive).
            const driveId = (parentId && typeof parentId === 'object' && parentId.driveId) || mine;
            const id = parentId && typeof parentId === 'object' ? parentId.id : parentId;
            path = `/drives/${encodeURIComponent(driveId)}/items/${encodeURIComponent(id)}/children?$top=${PAGE_SIZE}&$select=${ITEM_SELECT}&$orderby=name`;
        }
        const data = await json(path, {}, { what: 'folder', file: { fileId: parentId && typeof parentId === 'object' ? parentId.id : parentId } });
        const items = (data.value || [])
            .map((it) => toFileRef(it, { ownDriveId: mine, parentId: typeof parentId === 'string' ? parentId : null }))
            .filter(Boolean);
        return { items, nextPageToken: data['@odata.nextLink'] || null };
    }

    async function probeItem(file) {
        const item = await json(`${await itemPath(file)}?$select=${PROBE_SELECT}`, {}, { what: 'file', file });
        if (!item || item.deleted) {
            throw new SpreadsheetSourceError(404, 'spreadsheet_not_found', 'OneDrive no longer has this file.', { ref: refOf(file) });
        }
        return item;
    }

    async function probe(file) {
        const mine = await ownDriveId();
        const item = await probeItem(file);
        const ref = toFileRef(item, { ownDriveId: mine });
        if (!ref) {
            throw new SpreadsheetSourceError(415, 'format_unsupported', `"${item.name}" is not a spreadsheet Bee Flow can read.`, { ref: refOf(file) });
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

    async function download(file, { maxBytes = null } = {}) {
        const p = await probe(file);
        if (maxBytes && p.size != null && p.size > maxBytes) {
            throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is ${Math.round(p.size / 1048576)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB.`, { ref: refOf(file) });
        }
        if (!p.downloadUrl) {
            throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', 'OneDrive gave no download link for this file.', { ref: refOf(file) });
        }
        // Pre-authenticated URL on a content host: a bare fetch, NO bearer.
        let res;
        try {
            res = await fetch(p.downloadUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        } catch (e) {
            throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', `OneDrive did not deliver the file (${e && e.name === 'TimeoutError' ? 'timeout' : 'network error'}).`, { ref: refOf(file) });
        }
        if (!res.ok) throw fromHttp(provider, res.status, '', 'file', { ref: refOf(file) });
        const buffer = Buffer.from(await res.arrayBuffer());
        if (maxBytes && buffer.length > maxBytes) {
            throw new SpreadsheetSourceError(413, 'spreadsheet_too_large', `"${p.name}" is larger than ${Math.round(maxBytes / 1048576)} MB.`, { ref: refOf(file) });
        }
        return { buffer, marker: p.marker };
    }

    /**
     * Replace the file's content. `ifMatch` is the marker the bytes were
     * derived from; its eTag goes out as If-Match and Graph answers 412 when
     * the file moved (→ spreadsheet_conflict). Content type is left to Graph
     * (it types by extension) — an octet-stream body never mislabels a file.
     */
    async function upload(file, buffer, { ifMatch = null, contentType = null } = {}) {
        void contentType;
        const base = await itemPath(file);
        const ifMatchHeader = ifMatch && ifMatch.eTag ? { 'If-Match': ifMatch.eTag } : {};
        if (buffer.length <= SIMPLE_UPLOAD_MAX) {
            const item = await json(`${base}/content`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream', ...ifMatchHeader },
                body: buffer,
            }, { what: 'file', file });
            return { marker: markerOf(item) };
        }
        // Above 4 MB: an upload session, then ranged PUTs to the session URL
        // (pre-authenticated — no bearer on that host either).
        const session = await json(`${base}/createUploadSession`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...ifMatchHeader },
            body: JSON.stringify({ item: { '@microsoft.graph.conflictBehavior': 'replace' } }),
        }, { what: 'file', file });
        if (!session.uploadUrl) {
            throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', 'OneDrive did not open an upload session.', { ref: refOf(file) });
        }
        let item = null;
        for (let start = 0; start < buffer.length; start += UPLOAD_CHUNK) {
            const end = Math.min(start + UPLOAD_CHUNK, buffer.length);
            const chunk = buffer.subarray(start, end);
            let res;
            try {
                res = await fetch(session.uploadUrl, {
                    method: 'PUT',
                    headers: {
                        'Content-Length': String(chunk.length),
                        'Content-Range': `bytes ${start}-${end - 1}/${buffer.length}`,
                    },
                    body: chunk,
                    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
                });
            } catch (e) {
                throw new SpreadsheetSourceError(503, 'spreadsheet_unavailable', `OneDrive dropped the upload (${e && e.name === 'TimeoutError' ? 'timeout' : 'network error'}).`, { ref: refOf(file) });
            }
            if (!res.ok) {
                const { message } = await graphError(res);
                throw fromHttp(provider, res.status, message, 'file', { ref: refOf(file) });
            }
            if (res.status === 200 || res.status === 201) item = await res.json().catch(() => null);
        }
        if (!item) item = await probeItem(file);
        return { marker: markerOf(item) };
    }

    // ── cells: the Excel workbook API ────────────────────────────────

    const wbPath = async (file) => `${await itemPath(file)}/workbook`;
    const wsPath = (wb, sheet) => `${wb}/worksheets/${encodeURIComponent(typeof sheet === 'string' ? sheet : (sheet.id || sheet.name))}`;

    /**
     * Does the workbook API answer for this file? Asked once per file per api
     * instance. ApiNotSupported / AccessDenied (consumer OneDrive) and any
     * other 4xx mean "no"; a dead credential still surfaces as an error.
     */
    async function detectWorkbook(file) {
        const format = file && (file.format || formatOf(file));
        if (format !== 'xlsx' && format !== 'xlsm') return false;
        const key = file.fileId || file.id;
        if (workbookKnown.has(key)) return workbookKnown.get(key);
        let res;
        try {
            res = await graph().graphRequest(`${await wbPath(file)}/worksheets?$select=id,name,position,visibility`, cred, {});
        } catch (e) {
            if (e && e.message === 'NOT_CONNECTED') throw fromHttp(provider, 401, '', 'file', { ref: refOf(file) });
            throw e;
        }
        let answer = false;
        if (res.ok) answer = true;
        else if (res.status >= 500 || res.status === 429) {
            const { message } = await graphError(res);
            throw fromHttp(provider, res.status, message, 'file', { ref: refOf(file) });
        } else {
            await res.text().catch(() => '');   // ApiNotSupported, AccessDenied, 404 on the workbook facet
            answer = false;
        }
        workbookKnown.set(key, answer);
        return answer;
    }

    /** Run `fn(session)` inside one persisted workbook session; always closed. */
    async function withSession(file, fn) {
        const wb = await wbPath(file);
        const opened = await json(`${wb}/createSession`, { method: 'POST', ...jsonBody({ persistChanges: true }) }, { what: 'workbook', file });
        const headers = { 'workbook-session-id': opened.id };
        try {
            return await fn({ wb, headers });
        } finally {
            await call(`${wb}/closeSession`, { method: 'POST', headers }, { what: 'workbook', file, okStatuses: [200, 204] }).catch(() => { /* best effort */ });
        }
    }

    async function listSheets(file) {
        const wb = await wbPath(file);
        const data = await json(`${wb}/worksheets?$select=id,name,position,visibility`, {}, { what: 'workbook', file });
        const out = [];
        for (const ws of (data.value || []).slice(0, 50)) {
            let rowCount = null;
            let colCount = null;
            try {
                const used = await json(`${wsPath(wb, ws)}/usedRange(valuesOnly=true)?$select=address,rowCount,columnCount`, {}, { what: 'sheet', file });
                const a = parseAddress(used.address);
                rowCount = a ? a.last.row : (used.rowCount != null ? used.rowCount : null);
                colCount = a ? a.last.col + 1 : (used.columnCount != null ? used.columnCount : null);
            } catch (_) { /* an empty sheet answers 404 for usedRange */ }
            out.push({ id: ws.id, name: ws.name, index: ws.position || 0, rowCount, colCount, hidden: ws.visibility !== undefined && ws.visibility !== 'Visible' });
        }
        return out;
    }

    async function sample(file, sheet, { headerRow = 1, rows = 500, maxCols = 100 } = {}) {
        const wb = await wbPath(file);
        const address = `A1:${colLetter(maxCols - 1)}${headerRow + rows}`;
        const data = await json(`${wsPath(wb, sheet)}/range(address='${address}')?$select=values,numberFormat,formulas`, {}, { what: `sheet '${typeof sheet === 'string' ? sheet : sheet.name}'`, file });
        const values = data.values || [];
        const formats = data.numberFormat || [];
        const formulas = data.formulas || [];
        const tally = new Map();
        const formulaCols = new Set();
        values.forEach((row, ri) => {
            if (ri < headerRow) return;
            (row || []).forEach((v, ci) => {
                if (v === '' || v === null || v === undefined) return;
                const fx = formulas[ri] && formulas[ri][ci];
                if (typeof fx === 'string' && fx.startsWith('=')) formulaCols.add(ci);
                const nf = formats[ri] && formats[ri][ci];
                if (typeof nf === 'string' && nf !== 'General' && DATE_FORMAT_RE.test(nf.replace(/\[[^\]]*\]|"[^"]*"/g, ''))) {
                    const kind = TIME_FORMAT_RE.test(nf.replace(/\[[^\]]*\]|"[^"]*"/g, '')) ? 'DATE_TIME' : 'DATE';
                    const t = tally.get(ci) || {};
                    t[kind] = (t[kind] || 0) + 1;
                    tally.set(ci, t);
                }
            });
        });
        const numberFormat = new Map();
        for (const [col, t] of tally) numberFormat.set(col, Object.entries(t).sort((a, b) => b[1] - a[1])[0][0]);
        // Trailing all-empty rows of a fixed-size range are noise.
        let last = values.length;
        while (last > 0 && (values[last - 1] || []).every((v) => v === '' || v === null)) last -= 1;
        return { rows: values.slice(0, last).map((r) => (r || []).map((v) => (v === '' ? null : v))), numberFormat, formulaCols };
    }

    /** Rows 1..(headerRow + maxRows), read from the used range so an empty sheet costs nothing. */
    async function readSheet(file, sheet, { headerRow = 1, maxRows = 10000, maxCols = 100 } = {}) {
        const wb = await wbPath(file);
        const ws = wsPath(wb, sheet);
        const what = `sheet '${typeof sheet === 'string' ? sheet : sheet.name}'`;
        let used;
        try {
            used = await json(`${ws}/usedRange(valuesOnly=true)?$select=address,rowCount,columnCount`, {}, { what, file });
        } catch (e) {
            if (e && e.status === 404 && e.code === 'spreadsheet_not_found') return { rows: [], errorCells: 0 };
            throw e;
        }
        const a = parseAddress(used.address);
        const lastRow = Math.min(a ? a.last.row : (used.rowCount || 0), headerRow + maxRows);
        const lastCol = Math.min(a ? a.last.col : (used.columnCount || 1) - 1, maxCols - 1);
        if (!lastRow) return { rows: [], errorCells: 0 };
        const data = await json(`${ws}/range(address='A1:${colLetter(lastCol)}${lastRow}')?$select=values`, {}, { what, file });
        let errorCells = 0;
        const rows = (data.values || []).map((r) => (r || []).map((v) => {
            if (v === '' || v === null || v === undefined) return null;
            if (typeof v === 'string' && /^#(N\/A|REF!|VALUE!|DIV\/0!|NAME\?|NUM!|NULL!)$/.test(v)) { errorCells += 1; return null; }
            return v;
        }));
        return { rows, errorCells };
    }

    async function readRow(file, sheet, rowNumber, { maxCols = 100 } = {}) {
        const wb = await wbPath(file);
        const n = Number(rowNumber);
        const data = await json(`${wsPath(wb, sheet)}/range(address='A${n}:${colLetter(maxCols - 1)}${n}')?$select=values`, {}, { what: 'row', file });
        return ((data.values || [])[0] || []).map((v) => (v === '' ? null : v));
    }

    /** The emulated guard for workbook writes (no If-Match there). */
    async function guard(file, ifMatch) {
        const p = await probe(file);
        if (ifMatch && !markerEquals(p.marker, ifMatch)) {
            throw new SpreadsheetSourceError(409, 'spreadsheet_conflict',
                'The file changed in OneDrive since this table was last refreshed — it is being refreshed now; try again in a moment.', { ref: refOf(file) });
        }
        return p;
    }

    /**
     * Write the given cells of one row — one PATCH per cell (a whole-row
     * PATCH would overwrite the columns the mirror does not map). A
     * formula-shaped text is typed Text in a PATCH of its own first.
     */
    async function updateCells(file, sheet, rowNumber, cells, { ifMatch = null } = {}) {
        await guard(file, ifMatch);
        const n = Number(rowNumber);
        await withSession(file, async ({ wb, headers }) => {
            for (const c of cells || []) {
                const addr = `${wsPath(wb, sheet)}/range(address='${colLetter(c.col)}${n}')`;
                const v = workbookValue(c.value, c.type);
                const patch = (body) => json(addr, {
                    method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                }, { what: 'row', file });
                if (needsTextFormat(v, c.type)) await patch({ numberFormat: [['@']] });
                await patch({ values: [[v]] });
            }
        });
        return { marker: (await probe(file)).marker };
    }

    /**
     * Append below the last used row (or below `afterRow` when the engine
     * knows the last DATA row better than usedRange does). Date columns get
     * a number format so the serial renders as a date, formula-shaped texts
     * get Text — sent as a PATCH of their own BEFORE the values.
     * @returns {{ rowNumber:number, marker:object }}
     */
    async function appendRow(file, sheet, cells, { ifMatch = null, afterRow = null } = {}) {
        await guard(file, ifMatch);
        const width = (cells || []).reduce((m, c) => Math.max(m, Number(c.col) + 1), 0);
        const rowNumber = await withSession(file, async ({ wb, headers }) => {
            const ws = wsPath(wb, sheet);
            let last = afterRow != null ? Number(afterRow) : null;
            if (last === null) {
                try {
                    const used = await json(`${ws}/usedRange(valuesOnly=true)?$select=address,rowCount`, { headers }, { what: 'sheet', file });
                    const a = parseAddress(used.address);
                    last = a ? a.last.row : (used.rowCount || 0);
                } catch (e) {
                    if (e && e.code === 'spreadsheet_not_found') last = 0; else throw e;
                }
            }
            const n = last + 1;
            const values = new Array(width).fill('');
            const numberFormat = new Array(width).fill(null);
            for (const c of cells || []) {
                values[Number(c.col)] = workbookValue(c.value, c.type);
                numberFormat[Number(c.col)] = workbookFormat(c.type, values[Number(c.col)]);
            }
            const rangeUrl = `${ws}/range(address='A${n}:${colLetter(Math.max(width, 1) - 1)}${n}')`;
            const patch = (body) => json(rangeUrl, {
                method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            }, { what: 'row', file });
            if (numberFormat.some(Boolean)) await patch({ numberFormat: [numberFormat] });
            await patch({ values: [values] });
            return n;
        });
        return { rowNumber, marker: (await probe(file)).marker };
    }

    async function deleteRow(file, sheet, rowNumber, { ifMatch = null } = {}) {
        await guard(file, ifMatch);
        const n = Number(rowNumber);
        await withSession(file, async ({ wb, headers }) => {
            const ws = wsPath(wb, sheet);
            const opts = { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ shift: 'Up' }) };
            try {
                await json(`${ws}/range(address='${n}:${n}')/delete`, opts, { what: 'row', file });
            } catch (e) {
                // Some tenants refuse a whole-row address; the widest explicit one means the same.
                if (e && e.status === 422) await json(`${ws}/range(address='A${n}:XFD${n}')/delete`, opts, { what: 'row', file });
                else throw e;
            }
        });
        return { marker: (await probe(file)).marker };
    }

    const cells = {
        available: detectWorkbook,
        detectWorkbook,
        listSheets, sample, readSheet, readRow, updateCells, appendRow, deleteRow,
    };

    return { provider, list, probe, download, upload, markerEquals, cells, ownDriveId };
}

/** Cheap: a vault row or session tokens for Microsoft — no provider call. */
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
    toFileRef, parseAddress, colLetter, workbookValue, workbookFormat, needsTextFormat, refOf: refusalRef, pathOf, SIMPLE_UPLOAD_MAX, UPLOAD_CHUNK, ITEM_SELECT, PROBE_SELECT,
};
