/**
 * The member side of the organisation MCP library: the servers a person may
 * use that need a key, and their own key for each (Settings → Connections).
 *
 * A member only ever sees servers of their own organisation that they are
 * entitled to (the same capability check the runtime makes), and only ever
 * writes their OWN connection. The key is tried against the server before it
 * is stored, and stored bound to the server's origin (customMcpClient refuses
 * a key bound elsewhere).
 */

const { HttpError } = require('../../http/errors');
const { loadRunGate, isLibraryRow } = require('./gate');
const def = require('./definition');
const { authOfRow, libraryDefinition, sharedGrantFor, listOrgGrants, providerOf, capIdOf } = require('./service');

const deps = require('./deps');

const store = () => deps.store();
const connStore = () => deps.connStore();
const userStore = () => deps.userStore();
const entitlements = () => deps.entitlements();
const mcpClient = () => deps.mcpClient();

async function memberContext(req) {
    const userId = req.session.user.id;
    const user = await userStore().getUser(userId);
    const orgId = user && user.organizationId;
    if (!orgId) return { userId, orgId: null, effective: new Set() };
    let effective = new Set();
    try {
        const snap = await entitlements().resolveEntitlements({ userId, orgId, session: req.session, req });
        effective = new Set((snap.effective && snap.effective.integration) || []);
    } catch (_) { /* nothing is usable when the resolver is down */ }
    return { userId, orgId, effective };
}

/** Running library servers of the member's org that they may use and that take a key. */
async function usableKeyedRows(ctx) {
    if (!ctx.orgId) return [];
    const gate = await loadRunGate();
    const rows = await store().listActiveForOrg(ctx.orgId);
    return (rows || []).filter(r => isLibraryRow(r)
        && gate.isRunnable(r)
        && ctx.effective.has(capIdOf(r.id))
        && authOfRow(r).authStyle !== 'none');
}

async function listForMember(req) {
    const ctx = await memberContext(req);
    const rows = await usableKeyedRows(ctx);
    if (rows.length === 0) return { servers: [] };
    const grants = await listOrgGrants(ctx.orgId);
    const cs = connStore();
    const { getCatalogEntry } = require('./catalog');
    const servers = [];
    for (const row of rows) {
        const d = libraryDefinition(row);
        const auth = authOfRow(row);
        const shared = sharedGrantFor(grants, row.id);
        const own = await cs.getDefaultConnection(ctx.userId, providerOf(row.id)).catch(() => null);
        // The admin who lent the org its key holds that key as a connection
        // of their own; it is the organisation's key, not "theirs".
        const personal = own && own.status === 'active' && (!shared || own.id !== shared.connection_id);
        const entry = d.meta && d.meta.catalogId ? getCatalogEntry(d.meta.catalogId) : null;
        const cred = entry && entry.auth && entry.auth.credential;
        let host = null;
        try { host = new URL(d.mcp.url).hostname; } catch (_) { /* unknown */ }
        servers.push({
            id: row.id,
            name: row.name,
            description: row.description || '',
            catalogId: entry ? entry.id : null,
            host,
            credential: {
                label: auth.credential ? auth.credential.label : 'Key',
                help: cred ? cred.help || null : null,
                helpUrl: cred ? cred.helpUrl || null : null,
            },
            sharedKey: !!shared,
            connected: !!personal,
        });
    }
    return { servers };
}

async function loadMemberRow(ctx, id) {
    const rows = await usableKeyedRows(ctx);
    const row = rows.find(r => r.id === id);
    // Not yours, not running, not entitled, or no key: all look the same.
    if (!row) throw new HttpError(404, 'not_found', 'Not found');
    return row;
}

async function saveOwnCredential(req, id, value) {
    def.checkCredentialValue(value);
    const ctx = await memberContext(req);
    const row = await loadMemberRow(ctx, id);
    const auth = authOfRow(row);
    const secretObject = def.secretObjectFor(auth, value);
    if (!secretObject) throw new HttpError(400, 'credential_required', 'Enter your key.');
    const url = libraryDefinition(row).mcp.url;
    await def.discover({ url, auth, secretObject });
    // "My key" is personal. When the caller is the admin who lent the org its
    // shared key, their default connection IS that shared key: updating it in
    // place would quietly replace the whole organisation's key. Write a
    // connection of their own instead; the lend grant keeps pointing at the
    // shared one, and their own (now default) one wins for their requests.
    const shared = sharedGrantFor(await listOrgGrants(ctx.orgId), row.id);
    const cs = connStore();
    const provider = providerOf(row.id);
    const mine = ((await cs.listConnectionsForUser(ctx.userId, provider)) || [])
        .filter(c => !shared || c.id !== shared.connection_id);
    const secretMeta = { boundOrigin: new URL(url).origin, fields: [auth.credential.key] };
    if (mine.length > 0) {
        await cs.updateConnectionSecret(mine[0].id, secretObject, secretMeta);
        if (!mine[0].isDefault) await cs.setDefault(mine[0].id);
    } else {
        await cs.createConnection({
            ownerUserId: ctx.userId, orgId: row.orgId, provider, label: row.name, kind: 'mcp',
            secretObject, secretMeta, makeDefault: true, mirror: false,
        });
    }
    await mcpClient().closeIntegration(row.id);
    return { connected: true };
}

async function deleteOwnCredential(req, id) {
    const ctx = await memberContext(req);
    const row = await loadMemberRow(ctx, id);
    const cs = connStore();
    // The organisation's shared key is a connection of the admin who added
    // it. Removing "my key" must not quietly take the whole org's key with it.
    const shared = sharedGrantFor(await listOrgGrants(ctx.orgId), row.id);
    const mine = (await cs.listConnectionsForUser(ctx.userId, providerOf(row.id))) || [];
    const removable = mine.filter(c => !shared || c.id !== shared.connection_id);
    if (mine.length > 0 && removable.length === 0) {
        throw new HttpError(409, 'shared_key', 'This is the key your organisation shares. Change it in the MCP library.');
    }
    for (const c of removable) await cs.deleteConnection(c.id);
    await mcpClient().closeIntegration(row.id);
    return { connected: false };
}

module.exports = { listForMember, saveOwnCredential, deleteOwnCredential };
