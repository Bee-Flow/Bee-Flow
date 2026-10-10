/**
 * One-time upload tickets for the CMS MCP server.
 *
 * WHY: an MCP client has local photos and videos, and base64 through the model
 * context is the wrong path for them (cost, size, the model never needs the
 * bytes). So `cms_request_upload` hands out a URL the client PUTs the file to
 * with curl; the file never passes through the model.
 *
 * A ticket is bound to the user, organisation, site, content type and size the
 * request named, is valid for 15 minutes and works once.
 *
 *   ticket    <id>.<secret>   id: 12 random bytes (hex, public — the tool result
 *                             and cms_upload_status use it), secret: 32 random
 *                             bytes (base64url). On the wire the id is the URL path
 *                             and the secret is the X-Upload-Ticket header, so the
 *                             secret never lands in an access log or a trace URL.
 *   storage   one config row per ticket, `cms_mcp_upload_<id>`, holding the
 *             SHA-256 of the secret. Config rows are shared by every replica, so
 *             a ticket issued by one pod is honoured by the next; burning goes
 *             through configStore.mutateConfig (a Postgres advisory lock per
 *             key), which is what makes "works once" hold across replicas.
 *
 * The store is injected so the lifecycle is testable without a database.
 */

'use strict';

const crypto = require('crypto');

const KEY_PREFIX = 'cms_mcp_upload_';
const TTL_MS = 15 * 60 * 1000;
// A finished record stays readable for cms_upload_status for a while, then goes.
const RETAIN_MS = 24 * 60 * 60 * 1000;
const ID_BYTES = 12;
const SECRET_BYTES = 32;
// Tickets a user may hold open (unused and unexpired) at once.
const MAX_OPEN_PER_USER = 20;
const TICKET_RE = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function defaultStore() {
    const configStore = require('../../stores/configStore');
    return {
        get: (key) => configStore.getConfigFresh(key),
        set: (key, value) => configStore.setConfig(key, value),
        mutate: (key, fn) => configStore.mutateConfig(key, fn),
        remove: (key) => configStore.deleteConfig(key),
        listKeys: (prefix) => configStore.listKeysWithPrefix(prefix),
    };
}

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && typeof v.secretHash === 'string';

/**
 * @param {{ store?: ReturnType<typeof defaultStore>, now?: () => number }} [deps]
 */
function createUploadTickets({ store = null, now = Date.now } = {}) {
    const kv = store || defaultStore();

    const keyOf = (id) => `${KEY_PREFIX}${id}`;

    /** Split a presented ticket into its id and secret, or null when malformed. */
    function parse(ticket) {
        const m = TICKET_RE.exec(String(ticket || ''));
        return m ? { id: m[1], secret: m[2] } : null;
    }

    /** Drop records that are long past use. Best-effort, bounded, never throws. */
    async function prune() {
        try {
            const keys = (await kv.listKeys(KEY_PREFIX)).slice(0, 200);
            for (const key of keys) {
                const rec = await kv.get(key);
                if (!isRecord(rec) || now() - Date.parse(rec.createdAt) > RETAIN_MS) await kv.remove(key);
            }
        } catch (_) { /* housekeeping only */ }
    }

    /** How many unused, unexpired tickets this user holds. Bounded scan. */
    async function countOpen(userId) {
        const keys = (await kv.listKeys(KEY_PREFIX)).slice(0, 1000);
        let open = 0;
        for (const key of keys) {
            const rec = await kv.get(key);
            if (isRecord(rec) && rec.userId === userId && !rec.used && Date.parse(rec.expiresAt) > now()) open++;
        }
        return open;
    }

    /**
     * Mint a ticket.
     * @throws {Error} with `code: 'too_many_open_tickets'` when the user already holds the maximum
     * @param {{ userId: string, orgId: string|null, tokenId?: string|null, legacy?: boolean, siteId: string, contentType: string,
     *           maxSize: number, filename: string, key: string }} binding
     * @returns {Promise<{ ticket: string, ticketId: string, secret: string, expiresAt: string }>}
     */
    async function issue(binding) {
        if (await countOpen(binding.userId) >= MAX_OPEN_PER_USER) {
            throw Object.assign(new Error(`You already hold ${MAX_OPEN_PER_USER} unused upload URLs. Use or wait out some of them first.`), { code: 'too_many_open_tickets' });
        }
        const id = crypto.randomBytes(ID_BYTES).toString('hex');
        const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
        const created = now();
        const expiresAt = new Date(created + TTL_MS).toISOString();
        await kv.set(keyOf(id), {
            secretHash: sha256(secret),
            userId: binding.userId,
            orgId: binding.orgId || null,
            // The token the ticket was issued under (null for a legacy one), so the
            // PUT can ask again whether that token is still good.
            tokenId: binding.tokenId || null,
            legacy: binding.legacy === true,
            siteId: binding.siteId,
            contentType: binding.contentType,
            maxSize: binding.maxSize,
            filename: binding.filename,
            key: binding.key,
            createdAt: new Date(created).toISOString(),
            expiresAt,
            used: false,
            state: 'pending',
        });
        void prune();
        return { ticket: `${id}.${secret}`, ticketId: id, secret, expiresAt };
    }

    /**
     * Look a presented ticket up WITHOUT consuming it.
     * @returns {Promise<{ ok: true, record: object, id: string }
     *   | { ok: false, reason: 'malformed'|'unknown'|'expired'|'used' }>}
     */
    async function peek(ticket) {
        const parsed = parse(ticket);
        if (!parsed) return { ok: false, reason: 'malformed' };
        const record = await kv.get(keyOf(parsed.id));
        if (!isRecord(record)) return { ok: false, reason: 'unknown' };
        const given = Buffer.from(sha256(parsed.secret), 'hex'); // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- hash of the presented ticket, not a secret
        const stored = Buffer.from(record.secretHash, 'hex'); // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- stored hash, not a secret
        if (given.length !== stored.length || !crypto.timingSafeEqual(given, stored)) {
            return { ok: false, reason: 'unknown' };
        }
        if (Date.parse(record.expiresAt) <= now()) return { ok: false, reason: 'expired' };
        if (record.used) return { ok: false, reason: 'used' };
        return { ok: true, record, id: parsed.id };
    }

    /**
     * Burn a ticket: flip `used` atomically. Exactly one caller wins when two
     * PUTs race; the loser gets `used`. Done BEFORE any byte is stored.
     * @returns {Promise<{ ok: true, record: object } | { ok: false, reason: string }>}
     */
    async function burn(ticket) {
        const seen = await peek(ticket);
        if (!seen.ok) return seen;
        let outcome = { ok: false, reason: 'unknown' };
        await kv.mutate(keyOf(seen.id), (current) => {
            // The mutator may be retried; it only decides and never has side effects.
            if (!isRecord(current)) { outcome = { ok: false, reason: 'unknown' }; return current; }
            if (current.used) { outcome = { ok: false, reason: 'used' }; return current; }
            if (Date.parse(current.expiresAt) <= now()) { outcome = { ok: false, reason: 'expired' }; return current; }
            const next = { ...current, used: true, state: 'uploading', usedAt: new Date(now()).toISOString() };
            outcome = { ok: true, record: next, id: seen.id };
            return next;
        });
        return outcome;
    }

    /** Record how an upload that burned its ticket ended. */
    async function finish(id, patch) {
        await kv.mutate(keyOf(id), (current) => (isRecord(current) ? { ...current, ...patch } : current));
    }

    /**
     * What cms_upload_status reports. Only the user the ticket was issued to
     * sees it; any other id reads as unknown.
     */
    async function status(id, userId) {
        if (!/^[a-f0-9]{24}$/.test(String(id || ''))) return null; // nosemgrep: ajinabraham.njsscan.dos.regex_dos.regex_dos -- anchored fixed-length class, linear
        const record = await kv.get(keyOf(id));
        if (!isRecord(record) || record.userId !== userId) return null;
        const expired = !record.used && Date.parse(record.expiresAt) <= now();
        return {
            ticketId: id,
            state: expired ? 'expired' : record.state,
            used: !!record.used,
            expiresAt: record.expiresAt,
            siteId: record.siteId,
            contentType: record.contentType,
            filename: record.filename,
            ...(record.asset ? { asset: record.asset } : {}),
            ...(record.error ? { error: record.error } : {}),
        };
    }

    return { issue, peek, burn, finish, status, parse, prune };
}

module.exports = { createUploadTickets, TTL_MS, KEY_PREFIX, MAX_OPEN_PER_USER };
