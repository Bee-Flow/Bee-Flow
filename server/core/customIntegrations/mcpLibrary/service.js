/**
 * The organisation MCP library: what an org admin sees and does in
 * Settings → Organisation → MCP library.
 *
 * Two kinds of server appear there:
 *
 *   - ORG servers: remote MCP servers this org installed itself. Each is an
 *     org_custom_integrations row (kind 'mcp_remote', meta.source
 *     'mcp_library') and inherits that runtime's guarantees: org isolation at
 *     call time, the SSRF-pinned transport, credentials encrypted per org and
 *     bound to the endpoint's origin, the capability backstop. Capability id
 *     'custom:<uuid>'.
 *   - SERVER servers: the ones the server administrator installed for every
 *     organisation (core/mcpManager.js; may run locally). An org admin cannot
 *     install or change those, only decide whether their organisation uses
 *     them. Capability id 'mcp:<serverId>'.
 *
 * Who in the org may use a server: "everyone" puts the capability in
 * org_enabled_integrations, "groups" in the chosen groups'
 * granted_capabilities (entitlements: effective = (org ∪ groups) ∩ ceiling).
 *
 * Credentials, for a server that needs a key:
 *   'shared'   the installing admin's key is lent to the whole org;
 *   'personal' every member adds their own (Settings → Connections), the
 *              admin's key only proves the connection works.
 *
 * Every mutation writes an access-audit row: names, ids, counts — never a
 * key, never tool arguments.
 */

const { HttpError } = require('../../http/errors');
const log = require('../../../telemetry/log');
const { publicCatalog } = require('./catalog');
const { getPolicy, checkUrl, allowsCustomUrls } = require('./policy');
const { isLibraryRow, runningDefinition } = require('./gate');
const def = require('./definition');

const deps = require('./deps');

const store = () => deps.store();
const connStore = () => deps.connStore();
const userStore = () => deps.userStore();
const mcpStore = () => deps.mcpStore();
const entitlements = () => deps.entitlements();
const mcpClient = () => deps.mcpClient();

const capIdOf = (integrationId) => `custom:${integrationId}`;
const providerOf = (integrationId) => `custom:${integrationId}`;

/**
 * The library's own copy of a row's definition. Every library change goes
 * through saveDefinition (then activate, for a running row), so the working
 * `definition` is always the newest: equal to the activated snapshot for a
 * running server, and ahead of it for a switched-off one whose tools were
 * changed. What RUNS is still the activated snapshot (gate.runningDefinition).
 */
function libraryDefinition(row) {
    if (row && row.definition && row.definition.mcp) return row.definition;
    return runningDefinition(row) || {};
}

const POLICY_REFUSAL = {
    policy_off: 'Your server administrator has switched off installing MCP servers for organisations.',
    not_official: 'Only the official servers in the library can be installed on this server.',
    host_not_allowed: 'That host is not on the list your server administrator allows.',
    not_https: 'Only https addresses are allowed.',
    invalid_url: 'That is not a valid https address.',
};

function assertPolicyAllows(policy, url) {
    const verdict = checkUrl(policy, url);
    if (!verdict.allowed) throw new HttpError(403, `policy_${verdict.reason}`, POLICY_REFUSAL[verdict.reason] || 'Not allowed.');
    return verdict;
}

async function audit(verb, integrationId, actorUserId, orgId, oldValues, newValues) {
    try {
        await userStore().logAccessAudit(`mcp_library.${verb}`, 'custom_integration', integrationId, actorUserId || null, oldValues || null, newValues || null, orgId);
    } catch (e) {
        log.warn('[MCPLibrary] audit failed:', e.message);
    }
}

async function invalidate(orgId) {
    try { entitlements().registry.invalidateCustomIntegrationCache(orgId); } catch (_) { /* best effort */ }
    try { await entitlements().invalidateForOrg(orgId); } catch (_) { /* best effort */ }
}

async function orgGroups(orgId) {
    const all = await userStore().getAllGroups();
    return (all || []).filter(g => g && g.organizationId === orgId);
}

function readAccess(capId, orgList, groups) {
    const groupIds = groups
        .filter(g => Array.isArray(g.granted_capabilities) && g.granted_capabilities.includes(capId))
        .map(g => g.id);
    if (orgList.includes(capId)) return { mode: 'everyone', groupIds };
    return { mode: groupIds.length ? 'groups' : 'nobody', groupIds };
}

/**
 * Who may use `capId`: everyone in the org, or only `groupIds` (groups of
 * THIS org; anything else is refused, not skipped). Writes the org list and
 * every org group that changes.
 */
/** Refuse an access choice naming no group, or a group outside this org. */
function checkAccess(groups, access) {
    const mode = access && access.mode === 'groups' ? 'groups' : 'everyone';
    const chosen = new Set(mode === 'groups' ? (access.groupIds || []) : []);
    if (mode === 'groups') {
        if (chosen.size === 0) throw new HttpError(400, 'groups_required', 'Pick at least one group, or give everyone access.');
        const known = new Set(groups.map(g => g.id));
        for (const id of chosen) {
            if (!known.has(id)) throw new HttpError(400, 'unknown_group', 'One of the groups is not part of your organisation.');
        }
    }
    return { mode, chosen };
}

async function applyAccess(orgId, capId, access) {
    const us = userStore();
    const groups = await orgGroups(orgId);
    const { mode, chosen } = checkAccess(groups, access);

    const orgList = await us.getOrgEnabledIntegrations(orgId);
    const hasOrg = orgList.includes(capId);
    if (mode === 'everyone' && !hasOrg) await us.setOrgEnabledIntegrations(orgId, [...orgList, capId]);
    if (mode === 'groups' && hasOrg) await us.setOrgEnabledIntegrations(orgId, orgList.filter(x => x !== capId));

    for (const g of groups) {
        const current = Array.isArray(g.granted_capabilities) ? g.granted_capabilities : [];
        const has = current.includes(capId);
        const want = chosen.has(g.id);
        if (has === want) continue;
        await us.updateGroup(g.id, { grantedCapabilities: want ? [...current, capId] : current.filter(x => x !== capId) });
    }
    return { mode, groupIds: [...chosen] };
}

/** Remove `capId` from the org list and every org group (uninstall). */
async function revokeAccess(orgId, capId) {
    const us = userStore();
    const orgList = await us.getOrgEnabledIntegrations(orgId);
    if (orgList.includes(capId)) await us.setOrgEnabledIntegrations(orgId, orgList.filter(x => x !== capId));
    for (const g of await orgGroups(orgId)) {
        const current = Array.isArray(g.granted_capabilities) ? g.granted_capabilities : [];
        if (current.includes(capId)) await us.updateGroup(g.id, { grantedCapabilities: current.filter(x => x !== capId) });
    }
}

/** The org-wide lend grant of a server's shared key, if there is one. */
function sharedGrantFor(grants, integrationId) {
    const provider = providerOf(integrationId);
    return (grants || []).find(g => g.provider === provider && g.grantee_type === 'org' && !g.revoked_at) || null;
}

async function listOrgGrants(orgId) {
    try { return await connStore().listGrants({ orgId }); } catch (_) { return []; }
}

/** The decrypted shared key (lent connection), else the admin's own, else none. */
async function resolveAdminSecret(row, actorUserId, auth) {
    if (auth.authStyle === 'none') return null;
    const cs = connStore();
    const grant = sharedGrantFor(await listOrgGrants(row.orgId), row.id);
    let connId = grant ? grant.connection_id : null;
    if (!connId) {
        const own = await cs.getDefaultConnection(actorUserId, providerOf(row.id));
        connId = own ? own.id : null;
    }
    if (!connId) return null;
    const full = await cs.getConnectionWithSecret(connId);
    return (full && full.secret && typeof full.secret === 'object') ? full.secret : null;
}

/** Store (or replace) `userId`'s own key for a server, bound to its origin. */
async function upsertOwnConnection({ row, userId, auth, url, value, label }) {
    const cs = connStore();
    const provider = providerOf(row.id);
    const secretObject = { [auth.credential.key]: value };
    const secretMeta = { boundOrigin: new URL(url).origin, fields: [auth.credential.key] };
    const own = await cs.getDefaultConnection(userId, provider);
    if (own) {
        await cs.updateConnectionSecret(own.id, secretObject, secretMeta);
        return own.id;
    }
    const created = await cs.createConnection({
        ownerUserId: userId, orgId: row.orgId, provider, label: label || row.name, kind: 'mcp',
        secretObject, secretMeta, makeDefault: true, mirror: false,
    });
    return created.id;
}

function authOfRow(row) {
    const mcp = libraryDefinition(row).mcp || {};
    if (mcp.authStyle === 'none' || !mcp.valueTemplate) return { authStyle: 'none', credential: null };
    const cred = Array.isArray(mcp.credentials) && mcp.credentials[0] ? mcp.credentials[0] : null;
    return {
        authStyle: mcp.authStyle,
        header: mcp.header,
        valueTemplate: mcp.valueTemplate,
        credential: cred ? { key: cred.key, label: cred.label } : null,
    };
}

// ── Shapes ───────────────────────────────────────────────────────────

function shapeInstalled(row, { orgList, groups, grants, policy }) {
    const d = libraryDefinition(row);
    const mcp = d.mcp || {};
    const meta = d.meta || {};
    const allow = Array.isArray(mcp.toolAllowList) ? new Set(mcp.toolAllowList) : null;
    const discovered = Array.isArray(mcp.discoveredTools) ? mcp.discoveredTools : [];
    const tools = discovered.map(t => ({ ...t, enabled: allow ? allow.has(t.name) : true }));
    let host = null;
    try { host = new URL(mcp.url).hostname; } catch (_) { /* shown as unknown */ }
    const auth = authOfRow(row);
    const verdict = checkUrl(policy, mcp.url);
    const capId = capIdOf(row.id);
    return {
        id: row.id,
        name: row.name,
        description: row.description || '',
        catalogId: meta.catalogId || null,
        docsUrl: meta.docsUrl || null,
        url: mcp.url || null,
        host,
        official: !!verdict.official,
        status: row.status,
        // Installed under an older, wider policy: kept, but not running.
        blockedByPolicy: !verdict.allowed,
        blockedReason: verdict.allowed ? null : verdict.reason,
        authStyle: auth.authStyle,
        credential: auth.credential,
        // Shared = the org-wide lend grant exists; that grant, not the
        // informational lend_mode column, is what the credential resolver reads.
        credentialMode: auth.authStyle === 'none' ? 'none' : (sharedGrantFor(grants, row.id) ? 'shared' : 'personal'),
        tools,
        enabledToolCount: tools.filter(t => t.enabled).length,
        access: readAccess(capId, orgList, groups),
        installedAt: row.activatedAt || row.createdAt,
        installedBy: row.activatedBy || row.createdBy,
    };
}

async function listServerWide(orgId, orgList, groups) {
    let servers = [];
    try { servers = (await mcpStore().listServers()) || []; } catch (_) { return []; }
    servers = servers.filter(s => s && s.enabled !== false);
    if (servers.length === 0) return [];
    let available = new Set();
    try {
        const snap = await entitlements().resolveEntitlements({ userId: null, orgId });
        available = new Set((snap.orgAvailable && snap.orgAvailable.integration) || []);
    } catch (_) { /* nothing is available when the resolver is down */ }
    return servers.map(s => {
        const capId = `mcp:${s.id}`;
        const tools = Array.isArray(s.tools_cache) ? s.tools_cache : [];
        return {
            id: s.id,
            capId,
            name: s.name || s.id,
            description: s.description || '',
            icon: s.icon || null,
            category: s.category || null,
            runsOn: s.transport === 'http' ? 'remote' : 'server',
            status: s.status || 'unknown',
            tools: tools.slice(0, 100).map(t => ({ name: t.name, description: String(t.description || '').slice(0, 300) })),
            toolCount: tools.length,
            credentials: (Array.isArray(s.required_credentials) ? s.required_credentials : []).map(c => c.label || c.key),
            available: available.has(capId),
            access: readAccess(capId, orgList, groups),
        };
    });
}

// ── Reads ────────────────────────────────────────────────────────────

async function libraryRows(orgId) {
    const rows = await store().listForOrg(orgId);
    return (rows || []).filter(r => isLibraryRow(r));
}

async function getLibrary({ orgId, isServerAdmin = false }) {
    const [policy, rows, orgList, groups, grants] = await Promise.all([
        getPolicy(), libraryRows(orgId), userStore().getOrgEnabledIntegrations(orgId), orgGroups(orgId), listOrgGrants(orgId),
    ]);
    const installed = rows.map(r => shapeInstalled(r, { orgList, groups, grants, policy }));
    const catalog = publicCatalog().map(e => ({
        ...e,
        allowed: e.selfHosted ? allowsCustomUrls(policy) : policy.remote !== 'off',
        installedIds: installed.filter(i => i.catalogId === e.id).map(i => i.id),
    }));
    return {
        policy: {
            remote: policy.remote,
            allowsCustomUrls: allowsCustomUrls(policy),
            allowedHosts: policy.remote === 'allowlist' ? policy.allowedHosts : [],
        },
        isServerAdmin: !!isServerAdmin,
        catalog,
        installed,
        serverWide: await listServerWide(orgId, orgList, groups),
        groups: groups.map(g => ({ id: g.id, name: g.name })),
    };
}

// ── Probe ────────────────────────────────────────────────────────────

/** Check an endpoint before installing: connect, list tools, store nothing. */
async function probe({ catalogId, url, auth, credential }) {
    def.checkCredentialValue(credential);
    const target = def.resolveTarget({ catalogId, url, auth });
    assertPolicyAllows(await getPolicy(), target.url);
    const secretObject = def.secretObjectFor(target.auth, credential);
    const { tools, warnings } = await def.discover({ url: target.url, auth: target.auth, secretObject });
    return { url: target.url, tools: def.slimTools(tools), warnings: warnings || [] };
}

// ── Install ──────────────────────────────────────────────────────────

/**
 * Install in one go: check the policy, connect and list tools with the
 * admin's key, then create, store the key, activate, lend and grant. A
 * failure after the row exists removes everything it made, so a failed
 * install leaves nothing half-done behind.
 */
async function install({ orgId, actorUserId, input }) {
    const { catalogId = null, url = null, auth = null, credential = null, credentialMode = 'shared', tools = null, access } = input;
    def.checkCredentialValue(credential);
    const target = def.resolveTarget({ catalogId, url, auth });
    const policy = await getPolicy();
    const verdict = assertPolicyAllows(policy, target.url);

    const needsKey = target.auth.authStyle !== 'none';
    const mode = needsKey ? (credentialMode === 'personal' ? 'personal' : 'shared') : 'none';
    const secretObject = def.secretObjectFor(target.auth, credential);
    if (mode === 'shared' && !secretObject) {
        throw new HttpError(400, 'credential_required', 'Add the key the whole organisation will use.');
    }

    // Checked before anything is created or connected: a group outside the
    // org must not cost a remote session, a row and a rollback to refuse.
    checkAccess(await orgGroups(orgId), access);

    const discovered = await def.discover({ url: target.url, auth: target.auth, secretObject });
    const advertised = discovered.tools || [];
    if (advertised.length === 0) throw new HttpError(422, 'no_tools', 'The server offers no tools.');
    const names = new Set(advertised.map(t => t.name));
    const chosen = Array.isArray(tools) ? [...new Set(tools)] : [...names];
    for (const n of chosen) {
        if (!names.has(n)) throw new HttpError(400, 'unknown_tool', `The server does not offer a tool called "${n}".`);
    }
    if (chosen.length === 0) throw new HttpError(400, 'no_tools_selected', 'Switch on at least one tool.');

    const name = (input.name && String(input.name).trim()) || (target.entry ? target.entry.name : new URL(target.url).hostname);
    const description = (input.description && String(input.description).trim()) || (target.entry ? target.entry.description : null);

    const s = store();
    const row = await s.createIntegration({ orgId, name, kind: 'mcp_remote', createdBy: actorUserId, description });
    try {
        const definition = def.buildDefinition({
            url: target.url, auth: target.auth, entry: target.entry,
            discoveredTools: advertised, toolAllowList: chosen,
        });
        const { validateCustomIntegration } = require('../validateCustomIntegration');
        const validation = validateCustomIntegration(definition, { kind: 'mcp_remote', strict: true, slug: row.slug, librarySource: true });
        if (!validation.ok) {
            log.warn('[MCPLibrary] generated definition failed validation:', validation.errors.map(e => e.code).join(','));
            throw new HttpError(422, 'invalid_server', 'This server cannot be installed safely.');
        }
        await s.saveDefinition(row.id, definition, actorUserId, { lastValidation: validation });

        let connectionId = null;
        if (secretObject) {
            connectionId = await upsertOwnConnection({ row, userId: actorUserId, auth: target.auth, url: target.url, value: credential.trim(), label: name });
        }

        const { buildMcpToolsCache } = require('../mcpToolsCache');
        const filtered = mcpClient().normalizeAndFilterTools(advertised, chosen).tools;
        const activated = await s.activate(row.id, {
            definition,
            toolsCache: buildMcpToolsCache(filtered, row.slug),
            allowWrites: false,
            lendMode: mode === 'shared' ? 'org' : 'byo',
            userId: actorUserId,
        });

        if (mode === 'shared' && connectionId) {
            await connStore().shareConnection({ connectionId, grantorUserId: actorUserId, granteeType: 'org', granteeId: null });
        }
        const appliedAccess = await applyAccess(orgId, capIdOf(row.id), access);
        await invalidate(orgId);
        await audit('install', row.id, actorUserId, orgId, null, {
            name, catalogId: target.entry ? target.entry.id : null, host: new URL(target.url).hostname,
            official: !!verdict.official, credentialMode: mode, toolCount: chosen.length,
            access: appliedAccess.mode, groupCount: appliedAccess.groupIds.length,
        });
        const [orgList, groups, grants] = await Promise.all([
            userStore().getOrgEnabledIntegrations(orgId), orgGroups(orgId), listOrgGrants(orgId),
        ]);
        return shapeInstalled(activated, { orgList, groups, grants, policy });
    } catch (err) {
        await removeEverything(orgId, row).catch(e => log.warn('[MCPLibrary] install rollback failed:', e.message));
        throw err;
    }
}

// ── Change ───────────────────────────────────────────────────────────

/**
 * Re-read the tools with the server's key and freeze `definition` with a
 * fresh tools cache. The allow-list decides which tools agents get; a tool
 * the server stopped offering simply drops out.
 */
async function reactivate(row, definition, actorUserId) {
    // Every definition the library freezes is validated as strictly as the
    // one it installed, whatever path produced it.
    const { validateCustomIntegration } = require('../validateCustomIntegration');
    const validation = validateCustomIntegration(definition, { kind: 'mcp_remote', strict: true, slug: row.slug, librarySource: true });
    if (!validation.ok) {
        log.warn('[MCPLibrary] definition failed validation on re-activation:', validation.errors.map(e => e.code).join(','));
        throw new HttpError(422, 'invalid_server', 'This server cannot be switched on safely. Remove it and add it again.');
    }
    const auth = authOfRow({ ...row, definition });
    const secretObject = await resolveAdminSecret(row, actorUserId, auth);
    const shared = !!sharedGrantFor(await listOrgGrants(row.orgId), row.id);
    const allow = Array.isArray(definition.mcp.toolAllowList) ? definition.mcp.toolAllowList : null;
    const { tools } = await def.discover({ url: definition.mcp.url, auth, secretObject, toolAllowList: allow });
    if (!tools || tools.length === 0) throw new HttpError(422, 'no_tools', 'None of the switched-on tools is offered by the server any more.');
    const { buildMcpToolsCache } = require('../mcpToolsCache');
    await store().saveDefinition(row.id, definition, actorUserId);
    const updated = await store().activate(row.id, {
        definition, toolsCache: buildMcpToolsCache(tools, row.slug), allowWrites: false,
        lendMode: shared ? 'org' : 'byo', userId: actorUserId,
    });
    await mcpClient().closeIntegration(row.id);
    return updated;
}

async function update({ orgId, row, actorUserId, patch }) {
    const policy = await getPolicy();
    let current = row;
    const changes = {};

    if (Array.isArray(patch.tools)) {
        const d = libraryDefinition(row);
        const known = new Set((d.mcp.discoveredTools || []).map(t => t.name));
        const chosen = [...new Set(patch.tools)];
        for (const n of chosen) {
            if (!known.has(n)) throw new HttpError(400, 'unknown_tool', `The server does not offer a tool called "${n}".`);
        }
        if (chosen.length === 0) throw new HttpError(400, 'no_tools_selected', 'Switch on at least one tool, or turn the server off.');
        const next = { ...d, mcp: { ...d.mcp, toolAllowList: chosen } };
        if (current.status === 'active') {
            assertPolicyAllows(policy, next.mcp.url);
            current = await reactivate(current, next, actorUserId);
        } else {
            current = await store().saveDefinition(row.id, next, actorUserId) || current;
            // A disabled row keeps running nothing; the saved draft is what
            // turning it back on activates.
        }
        changes.toolCount = chosen.length;
    }

    if (patch.enabled === false && current.status === 'active') {
        await store().deactivate(row.id);
        await mcpClient().closeIntegration(row.id);
        current = await store().getById(row.id);
        changes.enabled = false;
    } else if (patch.enabled === true && current.status !== 'active') {
        const d = libraryDefinition(current);
        assertPolicyAllows(policy, d.mcp.url);
        current = await reactivate(current, d, actorUserId);
        changes.enabled = true;
    }

    // Shared → personal: stop lending the key. Members' own keys take over;
    // the stored shared key stays with the admin who added it (as their own).
    // Personal → shared needs a key, so it goes through setSharedCredential.
    if (patch.credentialMode === 'personal') {
        const grant = sharedGrantFor(await listOrgGrants(orgId), row.id);
        if (grant) {
            await connStore().revokeGrant(grant.id);
            await mcpClient().closeIntegration(row.id);
            changes.credentialMode = 'personal';
        }
    }

    if (patch.access) {
        const applied = await applyAccess(orgId, capIdOf(row.id), patch.access);
        changes.access = applied.mode;
        changes.groupCount = applied.groupIds.length;
    }

    await invalidate(orgId);
    await audit('update', row.id, actorUserId, orgId, { status: row.status }, { status: current.status, ...changes });
    const [orgList, groups, grants] = await Promise.all([
        userStore().getOrgEnabledIntegrations(orgId), orgGroups(orgId), listOrgGrants(orgId),
    ]);
    return shapeInstalled(current, { orgList, groups, grants, policy });
}

/**
 * Ask the server again which tools it has. Known tools keep their on/off
 * state; tools that are new since the last look stay OFF until an admin
 * switches them on, so a server cannot hand agents a new capability on its own.
 */
async function refresh({ orgId, row, actorUserId }) {
    const policy = await getPolicy();
    const d = libraryDefinition(row);
    assertPolicyAllows(policy, d.mcp.url);
    const auth = authOfRow(row);
    const secretObject = await resolveAdminSecret(row, actorUserId, auth);
    const { tools } = await def.discover({ url: d.mcp.url, auth, secretObject });
    const before = new Set((d.mcp.discoveredTools || []).map(t => t.name));
    const advertised = new Set((tools || []).map(t => t.name));
    const allow = (Array.isArray(d.mcp.toolAllowList) ? d.mcp.toolAllowList : []).filter(n => advertised.has(n));
    const next = { ...d, mcp: { ...d.mcp, discoveredTools: def.slimTools(tools), toolAllowList: allow } };
    const newTools = [...advertised].filter(n => !before.has(n));
    let updated;
    if (row.status === 'active' && allow.length > 0) {
        updated = await reactivate(row, next, actorUserId);
    } else {
        updated = await store().saveDefinition(row.id, next, actorUserId) || row;
        // Every switched-on tool is gone: running on would offer agents tools
        // the server no longer has.
        if (row.status === 'active') {
            await store().deactivate(row.id);
            await mcpClient().closeIntegration(row.id);
            updated = await store().getById(row.id) || updated;
        }
    }
    await invalidate(orgId);
    await audit('refresh', row.id, actorUserId, orgId, { toolCount: before.size }, { toolCount: advertised.size, newToolCount: newTools.length });
    const [orgList, groups, grants] = await Promise.all([
        userStore().getOrgEnabledIntegrations(orgId), orgGroups(orgId), listOrgGrants(orgId),
    ]);
    return { server: shapeInstalled(updated, { orgList, groups, grants, policy }), newTools };
}

/**
 * Replace the organisation's shared key. The new key is tried against the
 * server first; a key the server refuses is not stored. Every pooled session
 * is closed so nothing keeps talking with the old key.
 */
async function setSharedCredential({ orgId, row, actorUserId, value }) {
    def.checkCredentialValue(value);
    const auth = authOfRow(row);
    if (auth.authStyle === 'none' || !auth.credential) throw new HttpError(409, 'no_credential', 'This server does not use a key.');
    const secretObject = def.secretObjectFor(auth, value);
    if (!secretObject) throw new HttpError(400, 'credential_required', 'Enter the new key.');
    const d = libraryDefinition(row);
    // Same rule as every other path that connects out: a server the policy
    // no longer allows is not contacted, not even to try a key.
    assertPolicyAllows(await getPolicy(), d.mcp.url);
    await def.discover({ url: d.mcp.url, auth, secretObject });

    const cs = connStore();
    const grant = sharedGrantFor(await listOrgGrants(orgId), row.id);
    if (grant) {
        await cs.updateConnectionSecret(grant.connection_id, secretObject, { boundOrigin: new URL(d.mcp.url).origin, fields: [auth.credential.key] });
    } else {
        const connectionId = await upsertOwnConnection({ row, userId: actorUserId, auth, url: d.mcp.url, value: secretObject[auth.credential.key] });
        await cs.shareConnection({ connectionId, grantorUserId: actorUserId, granteeType: 'org', granteeId: null });
    }
    await mcpClient().closeIntegration(row.id);
    await invalidate(orgId);
    await audit('credential_set', row.id, actorUserId, orgId, null, { fields: [auth.credential.key], shared: true });
    return { ok: true };
}

// ── Remove ───────────────────────────────────────────────────────────

/** Deactivate, close sessions, revoke access, delete every key, delete the row. */
async function removeEverything(orgId, row) {
    const s = store();
    await s.deactivate(row.id);
    await mcpClient().closeIntegration(row.id);
    await revokeAccess(orgId, capIdOf(row.id));
    await connStore().deleteConnectionsForProvider({ provider: providerOf(row.id), orgId: row.orgId });
    await s.deleteIntegration(row.id);
    await invalidate(orgId);
}

async function uninstall({ orgId, row, actorUserId }) {
    await removeEverything(orgId, row);
    const d = libraryDefinition(row);
    let host = null;
    try { host = new URL(d.mcp.url).hostname; } catch (_) { /* unknown */ }
    await audit('uninstall', row.id, actorUserId, orgId, { name: row.name, host, status: row.status }, null);
    return { removed: true };
}

// ── Server-wide servers ──────────────────────────────────────────────

/**
 * Whether everyone in this organisation uses a server the server
 * administrator installed. Only servers inside the org's access (its plan or
 * licence, and the server admin's access menu) can be switched on.
 */
async function setServerWideAccess({ orgId, serverId, actorUserId, access }) {
    const server = await mcpStore().getServer(serverId).catch(() => null);
    if (!server || server.enabled === false) throw new HttpError(404, 'server_not_found', 'That server is not installed on this server.');
    const capId = `mcp:${serverId}`;
    const turningOn = access && access.mode !== 'nobody';
    if (turningOn) {
        const snap = await entitlements().resolveEntitlements({ userId: null, orgId });
        const available = new Set((snap.orgAvailable && snap.orgAvailable.integration) || []);
        if (!available.has(capId)) {
            throw new HttpError(403, 'not_available', 'Your organisation\'s plan does not include this server. Ask your server administrator.');
        }
    }
    let applied;
    if (turningOn) {
        applied = await applyAccess(orgId, capId, access);
    } else {
        await revokeAccess(orgId, capId);
        applied = { mode: 'nobody', groupIds: [] };
    }
    await invalidate(orgId);
    try {
        await userStore().logAccessAudit('mcp_library.server_wide_access', 'mcp_server', serverId, actorUserId || null, null, { access: applied.mode, groupCount: applied.groupIds.length }, orgId);
    } catch (e) { log.warn('[MCPLibrary] audit failed:', e.message); }
    return applied;
}

/** The library row `id` of `orgId`, or null (also for another org's or a builder row). */
async function loadOrgRow(orgId, id) {
    const s = store();
    const row = await s.getById(id).catch(() => null);
    if (!row || row.orgId !== s.resolveOrgId(orgId) || !isLibraryRow(row)) return null;
    return row;
}

module.exports = {
    getLibrary,
    probe,
    install,
    update,
    refresh,
    setSharedCredential,
    uninstall,
    setServerWideAccess,
    loadOrgRow,
    // shared with ./members.js and tests
    authOfRow,
    libraryDefinition,
    upsertOwnConnection,
    sharedGrantFor,
    listOrgGrants,
    readAccess,
    shapeInstalled,
    applyAccess,
    checkAccess,
    revokeAccess,
    capIdOf,
    providerOf,
    POLICY_REFUSAL,
};
