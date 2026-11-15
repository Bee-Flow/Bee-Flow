/**
 * Windmill inventory: which Windmill flows listen to this Nextcloud.
 *
 * `POST /hooks/windmill-inventory`, called by the Bee Flow server (an org
 * admin opened the Windmill import), answers which Windmill flows have a
 * `webhook_listeners` row on this Nextcloud and on which events. The Bee Flow
 * server cannot list those rows itself without receiving what they hold, so
 * the connector reads them here and sends on a summary built from an
 * allow-list (`inventoryItems`):
 *
 *   { generation, workspace, path, kind, events: { <event class>: <Bee Flow event id> | null }, hasEventFilter }
 *
 * Never sent: the row's uri (a standalone Windmill puts its webhook token in
 * the query string), its host, headers, authData, the eventFilter itself (it
 * names paths and users) or the userIdFilter. Rows are only read, never
 * changed: Windmill registers its rows again by itself (the Flow ExApp every
 * 30 seconds, a standalone Windmill when it reconciles), so a trigger is
 * switched off in Windmill.
 *
 * How a row is recognised, with string operations only:
 *   - Flow ExApp (generation `flow_exapp`): appId `flow`, or a relative uri
 *     under `/api/w/` (the ExApp gets its rows through AppAPI), shaped
 *     `/api/w/<workspace>/jobs/run/f/<flow path>`;
 *   - standalone Windmill (generation `standalone`): an absolute uri whose
 *     path holds `/api/w/<workspace>/jobs/run/<f|p>/<path>`.
 * Our own rows (`isOurRow`) are never in the answer.
 *
 * Authentication is the server's tenant-key HMAC (ncProxy.verifyHmac), the
 * same as `/hooks/studio-menus`: verify first, bill only a failure (401 under
 * the budget, 429 over it). Without a chosen server there is no tenant key,
 * so every call is refused and nothing is read (connector-no-default-server).
 * A verified call is always answered 200: `{ ok: true, items }`, or
 * `{ ok: false, error }` when Nextcloud would not list its rows.
 */

const express = require('express');
const { verifyHmac } = require('./ncProxy');
const { listAllRows, isOurRow, EVENT_BY_CLASS } = require('./webhookListeners');
const rateLimit = require('./rateLimit');
const log = require('./log');
const { errMessage } = require('./errors');

const INVENTORY_HOOK_PATH = '/hooks/windmill-inventory';
const inventorySigLimiter = rateLimit.penalise('windmill-inventory-sig', { limit: 60, windowMs: 60_000 });

const MAX_ITEMS = 500;
const MAX_SEGMENT = 255;
const MAX_PATH = 512;
const MAX_CLASS = 200;

/** @typedef {import('./webhookListeners').WebhookRow} WebhookRow */
/**
 * @typedef {{ generation: 'flow_exapp' | 'standalone', workspace: string, path: string, kind: 'flow' | 'script',
 *   events: Record<string, string | null>, hasEventFilter: boolean }} InventoryItem
 */

/**
 * One path segment as text: decoded, without control characters or a slash.
 * @param {string} raw
 * @returns {string | null}
 */
function segment(raw) {
    let text = raw;
    try { text = decodeURIComponent(raw); } catch { return null; }
    if (!text || text.length > MAX_SEGMENT || text.includes('/')) return null;
    for (const ch of text) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 0x20 || code === 0x7f) return null;
    }
    return text;
}

/**
 * The Windmill run address in a path, or null:
 * `.../api/w/<workspace>/jobs/run/<f|p>/<path...>`.
 * @param {string} pathname  a uri path, without query string
 * @returns {{ workspace: string, kind: 'flow' | 'script', path: string } | null}
 */
function windmillTarget(pathname) {
    const at = pathname.indexOf('/api/w/');
    if (at === -1) return null;
    const parts = pathname.slice(at + '/api/w/'.length).split('/');
    if (parts.length < 5 || parts[1] !== 'jobs') return null;
    if (parts[2] !== 'run' && parts[2] !== 'run_wait_result') return null;
    const kind = parts[3] === 'f' ? 'flow' : parts[3] === 'p' ? 'script' : null;
    if (!kind) return null;
    const workspace = segment(parts[0]);
    const pieces = parts.slice(4).map(segment);
    if (!workspace || !pieces.length || pieces.some((p) => p === null)) return null;
    const path = pieces.join('/');
    return path.length > MAX_PATH ? null : { workspace, kind, path };
}

/**
 * Which Windmill generation registered a row, and where it runs, or null for a
 * row that is not Windmill's.
 * @param {WebhookRow} row
 * @returns {{ generation: 'flow_exapp' | 'standalone', workspace: string, kind: 'flow' | 'script', path: string } | null}
 */
function classifyRow(row) {
    if (!row || typeof row.uri !== 'string' || typeof row.event !== 'string') return null;
    if (isOurRow(row)) return null;
    const uri = row.uri;
    if (uri.startsWith('/')) {
        const q = uri.indexOf('?');
        const target = windmillTarget(q === -1 ? uri : uri.slice(0, q));
        if (!target || !uri.startsWith('/api/w/')) return null;
        return { generation: 'flow_exapp', ...target };
    }
    let pathname;
    try { pathname = new URL(uri).pathname; } catch { return null; }
    const target = windmillTarget(pathname);
    if (!target) return null;
    // An ExApp row the Nextcloud stored with its own proxy address.
    return { generation: row.appId === 'flow' ? 'flow_exapp' : 'standalone', ...target };
}

/**
 * The answer's items, from an explicit allow-list: one item per Windmill flow
 * or script (its rows are grouped), each event class with the Bee Flow event
 * the connector delivers for it (null for a class it does not register), and
 * only whether a row carries an eventFilter.
 * @param {WebhookRow[]} rows
 * @returns {InventoryItem[]}
 */
function inventoryItems(rows) {
    /** @type {Map<string, InventoryItem>} */
    const byFlow = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const found = classifyRow(row);
        if (!found) continue;
        const cls = String(row.event);
        if (cls.length > MAX_CLASS) continue;
        const key = `${found.generation}\n${found.workspace}\n${found.kind}\n${found.path}`;
        let item = byFlow.get(key);
        if (!item) {
            if (byFlow.size >= MAX_ITEMS) break;
            item = { generation: found.generation, workspace: found.workspace, path: found.path, kind: found.kind, events: {}, hasEventFilter: false };
            byFlow.set(key, item);
        }
        const name = cls.startsWith('\\') ? cls.slice(1) : cls;
        item.events[name] = Object.hasOwn(EVENT_BY_CLASS, name) ? EVENT_BY_CLASS[name] : null;
        if (hasFilter(row.eventFilter)) item.hasEventFilter = true;
    }
    return [...byFlow.values()];
}

/** @param {unknown} filter */
function hasFilter(filter) {
    if (!filter) return false;
    if (Array.isArray(filter)) return filter.length > 0;
    return typeof filter === 'object' && Object.keys(filter).length > 0;
}

/**
 * @param {import('express').Express} app
 */
function mountInventoryHook(app) {
    app.post(INVENTORY_HOOK_PATH, express.raw({ type: () => true, limit: '16kb' }), async (req, res) => {
        if (!verifyHmac(req)) {
            const verdict = inventorySigLimiter.fail();
            if (!verdict.allowed) {
                res.set('Retry-After', String(Math.ceil(inventorySigLimiter.windowMs / 1000)));
                return res.status(429).json({ error: 'Too many invalid signatures' });
            }
            return res.status(401).json({ error: 'Missing or invalid X-Beeflow-Sig' });
        }
        inventorySigLimiter.succeed();
        try {
            const rows = await listAllRows({ warmupRetry: false });
            const items = inventoryItems(rows);
            log.info(`[WindmillInventory] ${items.length} Windmill flow(s) found in ${rows.length} webhook row(s)`);
            return res.json({ ok: true, items });
        } catch (err) {
            const status = err instanceof Error && 'status' in err ? Number(err.status) : 0;
            log.warn(`[WindmillInventory] could not list the webhook rows: ${errMessage(err)}`);
            return res.json({ ok: false, error: status === 404 ? 'webhook_listeners_disabled' : 'list_failed' });
        }
    });
}

module.exports = {
    mountInventoryHook,
    INVENTORY_HOOK_PATH,
    // exported for tests
    inventoryItems,
    classifyRow,
    windmillTarget,
};
