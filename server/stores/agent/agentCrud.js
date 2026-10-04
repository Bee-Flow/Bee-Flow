// @typecheck
/**
 * Agent CRUD - Create, Read, Update, Delete for agents + publish/org filtering
 */

const { v4: uuidv4 } = require('uuid');
const { run, getOne, getAll, withTransaction } = require('../../db');
const { initDB } = require('./initSchema');
const managedParts = require('../lib/managedParts');
const { getAgentTools, getAgentToolsWithParams, getAgentToolsBatch, getAgentToolsWithParamsBatch } = require('./agentTools');
const { buildUpdate } = require('../lib/sqlBuilder');
const log = require('../../telemetry/log');

// ── GitHub Sync hook (fire-and-forget) ───────────────────────────
async function _notifySync(orgId, agentId, action = 'pending') {
    if (!orgId) return;
    try {
        const syncStore = require('../githubSyncStore');
        const config = await syncStore.getOrgSyncConfig(orgId);
        if (!config) return; // Sync not configured for this org
        if (action === 'deleted') {
            await syncStore.markDeleted(orgId, 'agent', agentId);
        } else {
            await syncStore.markPending(orgId, 'agent', agentId);
        }
        // When auto-sync is enabled, push the change to GitHub (debounced).
        if (config.autoSync === true) {
            require('../../services/githubSyncService').autoSyncResource(orgId, 'agent', agentId, action);
        }
    } catch (e) { /* non-fatal — sync tracking failure should never break agent ops */ }
}

// The two published blobs never leave the store as-is: every read hands out
// ONE config / ONE system_prompt (the concept, or the published projection —
// see projectRuntime), so no API payload doubles in size and no client can
// pick the wrong one by accident. The scalar published_* columns
// (published_version / published_rev / published_at) DO pass through: they
// are what "Saved · v8" and "n unpublished changes" are computed from.
function _stripPublishedBlobs(row) {
    if (!row) return row;
    const { published_config, published_system_prompt, ...rest } = row;
    return rest;
}

// Does the runtime serve this row's published_* columns instead of its
// concept? Three conditions, all load-bearing:
//   - owner_id='system' agents (support singleton, system agents) have no
//     publish button and always follow live — PUT /api/support/agent must keep
//     reaching users.
//   - published_version > 0: an agent that was never published follows live
//     (new agents, and every existing agent until the A2 backfill runs).
//   - published_config IS NOT NULL: belt-and-braces against a half-written
//     row; a NULL blob can never be served as "the published config".
function isSplitActive(row) {
    if (!row) return false;
    if (row.owner_id === 'system' || row.owner_id === 'swarm') return false;
    if (!(Number(row.published_version) > 0)) return false;
    return row.published_config !== null && row.published_config !== undefined;
}

// Raw row → raw row whose config/system_prompt are what the RUNTIME must use,
// plus `runtimeSource: 'published' | 'live'` so a consumer (and a test) can
// tell which one it got. Applied BEFORE parseConfig.
function projectRuntime(row) {
    if (!row) return row;
    if (!isSplitActive(row)) return { ..._stripPublishedBlobs(row), runtimeSource: 'live' };
    return {
        ..._stripPublishedBlobs(row),
        config: row.published_config,
        // A published row always carries its prompt (publish copies both), but
        // never serve NULL for a prompt that was '' at publish time.
        system_prompt: row.published_system_prompt ?? row.system_prompt,
        runtimeSource: 'published',
    };
}

// Same shape as projectRuntime, but the CONCEPT on purpose — the testchat
// (A4) runs what you are making, not what is published. Marked `'draft'` and
// never `'live'`: 'live' means "there is nothing published to differ from",
// and a screen that says "you are testing your concept" has to be able to tell
// those two apart. The published blobs are stripped here exactly as everywhere
// else, so asking for the draft never doubles the payload.
function projectDraft(row) {
    if (!row) return row;
    return { ..._stripPublishedBlobs(row), runtimeSource: 'draft' };
}

// `persona` is an EDITOR artefact and leaves the store only where an editor
// asks for it (getAgent, getAgentViews().draft). parseConfig — which every
// list read and the runtime projection go through — strips the raw column, so
// a persona can never ride along by accident on a payload built from
// `SELECT *`: not the published library, not `GET /agents/:id` for someone who
// may only chat with the agent, not `getForRuntime`. Stripping here rather
// than deleting at each call site means a NEW reader inherits the narrow
// answer instead of the wide one.
function _stripPersona(row) {
    if (!row || !('persona' in row)) return row;
    const { persona, ...rest } = row;
    return rest;
}

function parseConfig(agent) {
    agent = _stripPersona(_stripPublishedBlobs(agent));
    const config = agent.config ? (typeof agent.config === 'string' ? JSON.parse(agent.config) : agent.config) : {};
    // Legacy agents stored their picture inside config.avatar instead of the
    // dedicated column. Fall through on read so the UI keeps showing them
    // until a one-shot backfill migrates the values into the column.
    const avatar = agent.avatar || config.avatar || null;
    return {
        ...agent,
        avatar,
        config,
        shared_groups: (() => { try { return JSON.parse(agent.shared_groups || '[]'); } catch (_) { return []; } })()
    };
}

// Convert a list of { componentId, params } (from getAgentToolsWithParams or its
// batch variant) into the tool_params shape the API exposes:
//   { [componentId]: { [paramName]: { value, fixed: true } } }
function buildToolParamsFromList(toolsWithParams) {
    const tool_params = {};
    for (const t of toolsWithParams) {
        if (t.params) {
            tool_params[t.componentId] = {};
            for (const [paramName, value] of Object.entries(t.params)) {
                tool_params[t.componentId][paramName] = { value, fixed: true };
            }
        }
    }
    return tool_params;
}

async function buildToolParams(agentId) {
    const toolsWithParams = await getAgentToolsWithParams(agentId);
    return buildToolParamsFromList(toolsWithParams);
}

/**
 * @param {object} [opts]
 * @param {object|null} [opts.persona] The structured role (A1c). Absent ⇒ the
 *   column stays NULL, which reads back as free mode over `systemPrompt` — the
 *   same thing every pre-A1c agent does, so a caller that knows nothing about
 *   personas creates exactly what it always created. New trailing argument on
 *   purpose: the positional list here is already thirteen long, and the last
 *   time one was appended (`categoryId`) a caller that stopped short silently
 *   wiped it (see updateAgent).
 */
async function createAgent(name, description, systemPrompt, ownerId, model = null, starterPrompts = [], threadsEnabled = true, copyEnabled = true, workspaceEnabled = false, config = {}, organizationId = null, sharedGroups = [], categoryId = null, opts = {}) {
    await initDB();
    const id = uuidv4();
    const persona = opts && opts.persona !== undefined ? opts.persona : null;
    const personaJson = persona === null || persona === undefined ? null : JSON.stringify(persona);
    await run(`INSERT INTO agents (id, name, description, system_prompt, model, starter_prompts, threads_enabled, copy_enabled, workspace_enabled, config, organization_id, shared_groups, category_id, owner_id, persona, created_at, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,NOW(),NOW())`,
        [id, name, description || '', systemPrompt || '', model, JSON.stringify(starterPrompts), !!threadsEnabled, !!copyEnabled, !!workspaceEnabled, JSON.stringify(config || {}), organizationId || null, JSON.stringify(sharedGroups || []), categoryId || null, ownerId, personaJson]);
    const result = { id, name, description, system_prompt: systemPrompt, model, starter_prompts: starterPrompts, threads_enabled: threadsEnabled, copy_enabled: copyEnabled, workspace_enabled: workspaceEnabled, config, organization_id: organizationId, shared_groups: sharedGroups, category_id: categoryId, owner_id: ownerId, persona, rev: 1 };
    try {
        const created = await getOne('SELECT * FROM agents WHERE id = $1', [id]);
        if (created) {
            const versionStore = require('../versionStore');
            await versionStore.createVersion(id, 'agent', created, ownerId, 'Initial version');
        }
    } catch (e) { log.error('[AgentCrud] Initial version snapshot failed:', e.message); }
    _notifySync(organizationId, id);
    return result;
}

async function getAgents(ownerId) {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE owner_id = $1 OR owner_id = 'system' ORDER BY updated_at DESC", [ownerId]);
    const toolsByAgent = await getAgentToolsBatch(agents.map(a => a.id));
    return agents.map(agent => ({ ...parseConfig(agent), tools: toolsByAgent.get(agent.id) || [] }));
}

// One load, three queries (row + component tools + their fixed params) —
// every agent-by-id read goes through this so a caller that needs BOTH views
// (GET /agents/:id) does not pay for the row twice, and both views are
// guaranteed to describe the SAME snapshot.
async function _loadAgentRow(id) {
    await initDB();
    const row = await getOne('SELECT * FROM agents WHERE id = $1', [id]);
    if (!row) return null;
    const tools = await getAgentTools(id);
    const tool_params = await buildToolParams(id);
    return { row, tools, tool_params };
}

/**
 * The CONCEPT view of one agent — what the editor edits and what every write
 * path reads before it writes. Carries `persona` (the structured role); the
 * runtime views deliberately do not. See `_stripPersona` and `personaOf`.
 */
async function getAgent(id) {
    const loaded = await _loadAgentRow(id);
    if (!loaded) return null;
    return {
        ..._withPersona(parseConfig(loaded.row), loaded.row),
        tools: loaded.tools,
        tool_params: loaded.tool_params,
    };
}

/**
 * Attach the projected persona — and, when the projection is unavailable,
 * attach NOTHING.
 *
 * Lazy + guarded because a read of the agents table must not become the thing
 * that takes a chat turn down over a role field. The key is OMITTED rather
 * than set to null on failure, and that is the whole point of the helper: a
 * client re-syncs from this payload and sends it back, so a `persona: null`
 * born from a failed read would come back as an explicit "clear the column"
 * and delete a role nobody touched. A missing key means "preserve" all the way
 * down to the SET list.
 */
function _withPersona(base, row) {
    try {
        return { ...base, persona: require('../../core/agentRuntime/personaPrompt').personaOf(row) };
    } catch (e) {
        log.warn(`[AgentCrud] persona projection unavailable for agent ${row?.id}:`, e.message);
        return base;
    }
}

/**
 * Clamp `config.tools` on the way OUT to the runtime.
 *
 * The write side (validateAgentConfigReferences) normalises too, but a row can
 * reach the runtime without ever passing it: written before this rule existed,
 * restored from a version snapshot, patched by the MCP builder, or copied. So
 * the runtime never trusts what is in the column — it re-clamps per read.
 *
 * Two properties this must not lose:
 *   - an agent WITHOUT a tools map is untouched, and pays nothing: the guard
 *     below returns before the tool registry is ever loaded;
 *   - it never throws. normaliseToolsConfig is written not to, and the try
 *     here is the second line of defence — a store read that threw would take
 *     the whole chat turn down over a config field.
 *
 * `lentProviders` decides whether `actAs:'owner'` survives. Resolving it costs
 * nothing while connection lending is off (the default): the probe returns
 * null without touching the database, and null means "could not check", which
 * downgrades to `viewer`.
 */
async function _clampRuntimeTools(agent) {
    if (!agent || !agent.config || typeof agent.config !== 'object') return agent;
    if (!agent.config.tools || typeof agent.config.tools !== 'object') return agent;
    try {
        const policy = require('../../core/agentRuntime/toolPolicy');
        const lentProviders = await policy.resolveLentProviders({
            agentId: agent.id, ownerId: agent.owner_id,
        });
        const { tools, warnings } = policy.normaliseToolsConfig(agent.config, {
            agentId: agent.id, ownerId: agent.owner_id, lentProviders,
        });
        if (!tools) return agent;
        if (warnings.length > 0) {
            log.warn(`[AgentCrud] Clamped tool grants for agent ${agent.id}: ${warnings.join('; ')}`);
        }
        // A map whose entries were junk clamps to a map of REFUSALS —
        // `{app: {actions: []}}`, one per unreadable entry — and handing that
        // to the runtime is deliberate: it is the narrowest true statement
        // about the row. It used to clamp to `{}` instead, by DROPPING those
        // entries, and that was the one clamp here that made a grant bigger:
        // a missing entry means "every action of this app" to every reader in
        // toolPolicy.js, so `{gmail: "nope"}` came back as the whole of Gmail.
        // Do not "fix" this back into dropping; a refusal has to survive, or
        // it is not a refusal.
        //
        // The cost is named rather than hidden: a map that holds nothing but
        // refusals now answers `hasCuratedGrants` with true, so an agent whose
        // ONLY tools map is junk enters the confirmation regime instead of
        // staying invisible. That is the fail-closed side of the same coin —
        // it holds a send back rather than granting one — and the warnings
        // above say exactly which entry caused it.
        return { ...agent, config: { ...agent.config, tools } };
    } catch (e) {
        // Unreachable policy module ⇒ serve the map AS STORED, loudly.
        //
        // Dropping it would look like the cautious move and is the opposite:
        // a missing map means "every action of every enabled app", so deleting
        // it here would hand the agent back the actions its owner unticked.
        // Keeping it can only ever narrow — and the two things a clamp exists
        // to stop are both re-derived downstream anyway: `confirmForTool`
        // forces `ask` on a send whatever the stored value says, and a lent
        // identity is re-checked per call at dispatch.
        log.warn(`[AgentCrud] Tool-grant normalisation unavailable for agent ${agent.id} — serving the stored grants unclamped:`, e.message);
        return agent;
    }
}

/**
 * The agent as the RUNTIME must see it: the published config/system_prompt
 * when the agent has been published at least once (and is not a system
 * agent), otherwise the live concept. Same shape as getAgent plus
 * `runtimeSource: 'published' | 'live'` — or, with `useDraft: true` (the
 * testchat, A4), unconditionally `'draft'`. That third value is what
 * `testChat.testChatConfigInfo` reads, and it is the ONLY one that path can
 * see: `projectDraft` stamps it without looking at anything else.
 *
 * Every consumer that runs an agent (agent chat, non-streaming chat, support
 * responder, embed, ai_step, app AI block, GET /agents/:id for non-editors)
 * loads through this; getAgent is for the editor and for access decisions
 * (owner_id / is_published / shared_groups are never split).
 *
 * The component tool grants (agent_tools table) are not part of the split:
 * they are read live here exactly as in getAgent.
 */
async function getForRuntime(id, { useDraft = false } = {}) {
    const loaded = await _loadAgentRow(id);
    if (!loaded) return null;
    const projected = useDraft === true ? projectDraft(loaded.row) : projectRuntime(loaded.row);
    const agent = { ...parseConfig(projected), tools: loaded.tools, tool_params: loaded.tool_params };
    return _clampRuntimeTools(agent);
}

/**
 * Both views of one agent from ONE load: `draft` (the concept, what the
 * editor edits) and `runtime` (what getForRuntime would serve). GET
 * /agents/:id needs both — the access decision and `unpublishedChanges` come
 * from the concept row, the body from the projection — and calling getAgent
 * plus getForRuntime would run the same three queries twice on the hottest
 * agent endpoint (and could straddle a save).
 *
 * `tools` / `tool_params` are shared by both views (the component grants are
 * not part of the split); treat them as read-only.
 *
 * @returns {Promise<{draft:object, runtime:object}|null>}
 */
async function getAgentViews(id) {
    const loaded = await _loadAgentRow(id);
    if (!loaded) return null;
    const { row, tools, tool_params } = loaded;
    return {
        // The draft is the EDITOR's copy and stays verbatim — the picker has
        // to be able to show what is stored, including a value the runtime
        // will clamp. The runtime view is clamped exactly as getForRuntime
        // would, so "what will actually run" is never a second opinion.
        //
        // `persona` rides on the DRAFT only. It describes the concept prompt,
        // and a published agent's runtime prompt is a different string — so
        // pairing the two would be a claim nobody checked. A reader that wants
        // "the role behind what is live" gets nothing rather than a guess.
        draft: { ..._withPersona(parseConfig(row), row), tools, tool_params },
        runtime: await _clampRuntimeTools({ ...parseConfig(projectRuntime(row)), tools, tool_params }),
    };
}

/**
 * Copy the concept into the published columns and bump published_version.
 *
 * ONE statement, guarded on `rev`: the concept we read is the concept we
 * publish, or the call reports a conflict and the route retries — a save that
 * lands between the read and the copy can never half-publish. `rev` itself is
 * NOT bumped (publishing does not change the concept), so an open editor
 * keeps its CAS token. `published_rev := rev` is what "n unpublished changes"
 * (rev > published_rev) is computed from afterwards.
 *
 * owner_id='system' agents are refused here as well as in the route (the
 * WHERE clause), so no caller can put a support singleton into split mode.
 *
 * @param {string} id
 * @param {object} [opts]
 * @param {number|null} [opts.expectedRev] CAS token; null = publish whatever is there now.
 * @param {object|null} [opts.config] The (validated) config to publish; defaults to the stored concept.
 * @param {any} [opts.client] A transaction client ({ query }); the deploy commit passes its own.
 * @param {{ deploymentId?: string }|null} [opts.managedWrite] The deploy's capability, needed on a managed agent.
 * @returns {Promise<{ok:true,row:object,publishedVersion:number,publishedRev:number,publishedAt:string}
 *                  |{ok:false,conflict:true,currentRev:number}
 *                  |{ok:false,notFound:true}
 *                  |{ok:false,systemAgent:true}>}
 */
async function publishAgentVersion(id, opts = {}) {
    await initDB();
    const { expectedRev = null, config = null, client = null, managedWrite = null } = opts || {};
    // On the deploy's client the publish moves inside the commit transaction.
    const exec = client ? (sql, params) => client.query(sql, params) : run;
    const readOne = client ? async (sql, params) => (await client.query(sql, params)).rows[0] || null : getOne;
    const existing = await readOne('SELECT * FROM agents WHERE id = $1', [id]);
    if (!existing) return { ok: false, notFound: true };
    if (existing.owner_id === 'system' || existing.owner_id === 'swarm') return { ok: false, systemAgent: true };
    // A managed agent's live copy moves only with a deploy (design 5.3).
    await managedParts.assertManagedWrite({
        kind: 'agent', projectId: existing.project_id, changedKeys: ['publishedVersion'], managedWrite, client,
    });
    const rev = expectedRev != null ? expectedRev : (Number(existing.rev) || 1);
    const cfg = config && typeof config === 'object'
        ? config
        : (existing.config ? (typeof existing.config === 'string' ? JSON.parse(existing.config) : existing.config) : {});
    const { rows, rowCount } = await exec(`UPDATE agents
        SET published_config = $1::jsonb,
            published_system_prompt = system_prompt,
            published_version = published_version + 1,
            published_rev = rev,
            published_at = NOW(),
            updated_at = NOW()
        WHERE id = $2 AND rev = $3 AND owner_id NOT IN ('system', 'swarm')
        RETURNING *`, [JSON.stringify(cfg || {}), id, rev]);
    if (rowCount > 0 && rows && rows[0]) {
        const row = rows[0];
        _notifySync(row.organization_id, id);
        return {
            ok: true,
            row,
            publishedVersion: Number(row.published_version) || 0,
            publishedRev: Number(row.published_rev) || rev,
            publishedAt: row.published_at,
        };
    }
    const cur = await readOne('SELECT rev FROM agents WHERE id = $1', [id]);
    return { ok: false, conflict: true, currentRev: Number(cur?.rev) || rev };
}

/**
 * The stored `shared_groups` value, in the exact form the column expects.
 *
 * `agents.shared_groups` is TEXT holding JSON, but a row that came back through
 * a JSONB-typed driver path (or an older install) can hand us an array. Writing
 * that array straight back would let the driver re-serialise it in a shape the
 * JSON.parse readers in getPublishedAgentsForUser choke on, so normalise here.
 */
function _existingSharedGroupsJson(existing) {
    const stored = existing ? existing.shared_groups : undefined;
    if (stored === undefined || stored === null || stored === '') return '[]';
    return typeof stored === 'string' ? stored : JSON.stringify(stored);
}

// updateAgent's arguments → the columns they write, for the managed-part diff
// (stores/lib/managedParts.changedKeysOf): the route sends every field, so
// only a value that differs from the locked row counts as a change.
const AGENT_UPDATE_COLUMNS = Object.freeze({
    name: 'name', description: 'description', systemPrompt: 'system_prompt', model: 'model',
    starterPrompts: 'starter_prompts', avatar: 'avatar', threadsEnabled: 'threads_enabled',
    copyEnabled: 'copy_enabled', workspaceEnabled: 'workspace_enabled', config: 'config',
    embedEnabled: 'embed_enabled', organizationId: 'organization_id', sharedGroups: 'shared_groups',
    categoryId: 'category_id', persona: 'persona',
});

/**
 * Update an agent. Optimistic-concurrency aware.
 *
 * `organizationId`, `sharedGroups` and `categoryId` are PRESERVED when the
 * argument is `undefined` and only cleared when it is explicitly null/[].
 *
 * @param {object} [opts]
 * @param {number|null} [opts.expectedRev] When set, the write is a compare-and-swap
 *   on the `rev` column: if the row's current rev != expectedRev the UPDATE matches
 *   zero rows and the caller gets `{ ok:false, conflict:true, currentRev }` instead of
 *   silently clobbering. Callers that must always win (version restore, support tools)
 *   pass null → last-write-wins, same as before.
 * @param {object|null} [opts.persona] The structured role (A1c). Follows the
 *   SAME undefined-means-preserve rule as the three optional columns above,
 *   and for the same reason: the `persona` clause is only added to the SET list
 *   when a caller actually supplied one, so `routes/versions.js` and every
 *   other short caller leave the column alone instead of erasing a role they
 *   never heard of. Explicit `null` clears it — which is not data loss, it is
 *   the row falling back to free mode over its own `system_prompt`.
 * @param {{ deploymentId?: string }|null} [opts.managedWrite] A deploy's capability. On an
 *   agent filed into a Solution stage, only sharing, `embed_enabled` and the
 *   category may change without it (409 managed_part otherwise).
 * @returns {Promise<{ok:true, rev:number}|{ok:false, conflict:true, currentRev:number}|{ok:false, notFound:true}>}
 */
async function updateAgent(id, name, description, systemPrompt, ownerId, model = null, starterPrompts = [], avatar = null, threadsEnabled = true, copyEnabled = true, workspaceEnabled = false, config = {}, embedEnabled = false, organizationId = undefined, sharedGroups = undefined, categoryId = undefined, opts = {}) {
    await initDB();
    const { expectedRev = null, persona = undefined } = opts || {};

    // Fetch the current row up front — needed both for the pre-update version
    // snapshot and to compute the new rev / conflict payload without a second
    // round trip.
    const existing = await getOne('SELECT * FROM agents WHERE id = $1', [id]);

    // `undefined` means "the caller did not supply this", NOT "clear it".
    //
    // The three optional columns below are written unconditionally by the single
    // SET list, so collapsing `undefined` to null/'[]' silently WIPED them for
    // any caller that stops short in the positional argument list. routes/versions.js
    // (version restore) passes exactly 15 arguments and never reaches categoryId,
    // so restoring any agent version detached it from its org category — the
    // route returns {success:true} and nothing reports the loss.
    //
    // Same undefined-means-preserve rule setAgentPublished already applies to
    // sharedGroups, and stores/knowledgeBases.updateKB to its own optionals.
    // `existing` is the row read above, so preserving costs no extra round trip.
    const orgId = organizationId !== undefined
        ? (organizationId || null)
        : (existing ? (existing.organization_id ?? null) : null);
    const sharedGroupsJson = sharedGroups !== undefined
        ? JSON.stringify(sharedGroups || [])
        : _existingSharedGroupsJson(existing);
    const catId = categoryId !== undefined
        ? (categoryId || null)
        : (existing ? (existing.category_id ?? null) : null);

    // Compare-and-swap on `rev` only when the caller supplies a token. `rev` is
    // always bumped so the token stays authoritative against every writer.
    const params = [name, description || '', systemPrompt || '', model, JSON.stringify(starterPrompts), avatar, !!threadsEnabled, !!copyEnabled, !!workspaceEnabled, JSON.stringify(config || {}), !!embedEnabled, orgId, sharedGroupsJson, catId, id, ownerId];
    let revGuard = '';
    if (expectedRev != null) { params.push(expectedRev); revGuard = ' AND rev = $17'; }
    // `persona` is appended LAST — after the CAS token — so the fourteen
    // positional params, the id, the owner and the rev guard keep the exact
    // placeholder numbers every other reader of this statement expects. Its
    // clause exists only when the caller supplied one (see the opts docblock).
    let personaSet = '';
    if (persona !== undefined) {
        params.push(persona === null ? null : JSON.stringify(persona));
        personaSet = `, persona = $${params.length}::jsonb`;
    }
    const updateSql = `UPDATE agents SET name=$1, description=$2, system_prompt=$3, model=$4, starter_prompts=$5, avatar=$6, threads_enabled=$7, copy_enabled=$8, workspace_enabled=$9, config=$10, embed_enabled=$11, organization_id=$12, shared_groups=$13, category_id=$14${personaSet}, rev = rev + 1, updated_at=NOW()
        WHERE id=$15 AND owner_id=$16${revGuard}`;
    // A managed agent (filed into a Solution stage) is locked, diffed and
    // guarded in one transaction; every other agent writes as it always did.
    const { rowCount } = existing?.project_id && await managedParts.managedInfo(existing.project_id)
        ? await withTransaction(async (client) => {
            const locked = (await client.query('SELECT * FROM agents WHERE id = $1 FOR UPDATE', [id])).rows[0];
            if (!locked) return { rowCount: 0 };
            await managedParts.assertManagedWrite({
                kind: 'agent', projectId: locked.project_id, client,
                changedKeys: managedParts.changedKeysOf(locked, {
                    name, description: description || '', systemPrompt: systemPrompt || '', model,
                    starterPrompts, avatar, threadsEnabled: !!threadsEnabled, copyEnabled: !!copyEnabled,
                    workspaceEnabled: !!workspaceEnabled, config: config || {}, embedEnabled: !!embedEnabled,
                    organizationId: orgId, sharedGroups: sharedGroupsJson, categoryId: catId, persona,
                }, AGENT_UPDATE_COLUMNS),
                managedWrite: opts?.managedWrite || null,
            });
            return client.query(updateSql, params);
        })
        : await run(updateSql, params);

    if (rowCount > 0) {
        // Snapshot the PRE-update state for version history — only AFTER a
        // confirmed write, so a rejected (stale/conflicting) save never pollutes
        // the history.
        if (existing) {
            try {
                const versionStore = require('../versionStore');
                await versionStore.createVersion(id, 'agent', existing, ownerId);
            } catch (e) { log.error('[AgentCrud] Version snapshot failed:', e.message); }
        }
        _notifySync(orgId, id);
        return { ok: true, rev: (Number(existing?.rev) || 1) + 1 };
    }

    // Zero rows updated. With a CAS token, distinguish a stale-rev conflict
    // (row exists + same owner) from a genuine not-found / not-owner.
    if (expectedRev != null) {
        const row = await getOne('SELECT rev, owner_id FROM agents WHERE id = $1', [id]);
        if (row && row.owner_id === ownerId) {
            return { ok: false, conflict: true, currentRev: Number(row.rev) || 1 };
        }
    }
    return { ok: false, notFound: true };
}

/**
 * Een EXPLICIET versiepunt van de huidige conceptstaat, los van de
 * autosave-snapshot die updateAgent hierboven zelf al schrijft.
 *
 * Twee dingen liggen hier bewust vast:
 *
 *   Er wordt de RAUWE rij gesnapshot, niet de weergave van getAgent(). In die
 *   weergave is `persona` een PROJECTIE die bij een leesfout helemaal wegvalt
 *   (_withPersona laat de sleutel dan weg) — en een restore van zo'n snapshot
 *   leest dat als "geen persona" en schrijft de kolom leeg. De rauwe rij draagt
 *   de kolom zoals hij is, dus een restore herstelt hem zoals hij was.
 *
 *   `changeSummary` wordt altijd meegegeven, zodat createVersion niet zijn
 *   _autoSummary-query hoeft te doen om een zin te verzinnen die de aanroeper
 *   al weet.
 *
 * Bestaat de agent niet, dan komt er `null` terug — geen lege snapshot, want
 * "niets te herstellen" en "een snapshot van niets" zijn niet hetzelfde.
 *
 * @param {string} id
 * @param {string|null} [userId]
 * @param {object} [opts]
 * @param {'autosave'|'published'|'pre_refine'} [opts.kind]
 * @param {string} [opts.changeSummary]
 */
async function snapshotAgent(id, userId = null, { kind = 'pre_refine', changeSummary = 'Before AI refine' } = {}) {
    const loaded = await _loadAgentRow(id);
    if (!loaded) return null;
    const versionStore = require('../versionStore');
    return versionStore.createVersion(id, 'agent', loaded.row, userId, changeSummary, { kind });
}

/**
 * Refuses a change to a managed agent's tool grants (design 5.2: `tools` is not
 * on ALLOWED.agent) before agentTools.setAgentTools / updateAgentToolParams
 * write. Diff-based, like updateAgent: the builder sends the full list on every
 * save, so an unchanged list (same component ids, same fixed params) passes.
 * An agent without a project reads nothing.
 *
 * @param {{ id: string, project_id?: string|null }} agent the row the caller just loaded
 * @param {Array<{ componentId: string, params?: object|null }>|((current: Array<{ componentId: string, params: object|null }>) => Array<{ componentId: string, params?: object|null }>)} next
 *   the list as it would be stored, or a function of the stored list that returns it
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 */
async function assertAgentToolsWrite(agent, next, { managedWrite = null } = {}) {
    const projectId = agent && agent.project_id;
    if (!projectId || !(await managedParts.managedInfo(projectId))) return;
    const current = await getAgentToolsWithParams(agent.id);
    const asMap = (list) => Object.fromEntries((list || []).map((t) => [t.componentId, t.params || null]));
    const wanted = typeof next === 'function' ? next(current) : next;
    if (managedParts.changedKeysOf({ tools: asMap(current) }, { tools: asMap(wanted) }).length === 0) return;
    await managedParts.assertManagedWrite({ kind: 'agent', projectId, changedKeys: ['tools'], managedWrite });
}

/**
 * What an agent GET adds as `managed` (design 5.3): null, or the stage that
 * manages it. A failed lookup answers null and is logged; a GET never fails on it.
 *
 * @param {{ id: string, project_id?: string|null }|null} agent
 */
async function managedPayloadOfAgent(agent) {
    if (!agent || !agent.project_id) return null;
    try {
        return await require('../solutionStageStore').managedPayloadFor({ projectId: agent.project_id, kind: 'agent', entityId: agent.id });
    } catch (err) {
        log.warn(`[AgentCrud] managed lookup for ${agent.id} failed: ${err.message}`);
        return null;
    }
}

/**
 * A managed agent (a Solution stage's) is retired by a deploy, never deleted.
 *
 * @param {string} id
 * @param {{ managedWrite?: { deploymentId?: string }|null }} [opts]
 */
async function assertAgentDeletable(id, { managedWrite = null } = {}) {
    const row = await getOne('SELECT project_id FROM agents WHERE id = $1', [id]);
    if (row?.project_id) {
        await managedParts.assertManagedWrite({ kind: 'agent', projectId: row.project_id, changedKeys: ['delete'], managedWrite });
    }
}

async function deleteAgent(id, ownerId, opts = {}) {
    await initDB();
    await assertAgentDeletable(id, opts);
    // Grab org_id before deleting so we can notify sync
    const agent = await getOne('SELECT organization_id FROM agents WHERE id = $1', [id]);
    const { rowCount } = await run('DELETE FROM agents WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    if (rowCount > 0 && agent?.organization_id) _notifySync(agent.organization_id, id, 'deleted');
    return rowCount > 0;
}

async function forceDeleteAgent(id, opts = {}) {
    await initDB();
    await assertAgentDeletable(id, opts);
    await run('DELETE FROM agent_tools WHERE agent_id = $1', [id]);
    await run('DELETE FROM agent_conversations WHERE agent_id = $1', [id]);
    const { rowCount } = await run('DELETE FROM agents WHERE id = $1', [id]);
    return rowCount > 0;
}

async function getPublishedAgents() {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE is_published = TRUE AND owner_id NOT IN ('system', 'swarm') ORDER BY name ASC");
    const twpByAgent = await getAgentToolsWithParamsBatch(agents.map(a => a.id));
    // The library is what users chat with → the runtime projection.
    return agents.map(agent => {
        const twp = twpByAgent.get(agent.id) || [];
        return { ...parseConfig(projectRuntime(agent)), tools: twp.map(t => t.componentId), tool_params: buildToolParamsFromList(twp) };
    });
}

async function setAgentPublished(id, isPublished, ownerId, sharedGroups = undefined) {
    await initDB();
    // When sharedGroups is undefined, preserve the existing DB value — do NOT
    // overwrite with []. Previously a toggle-publish with no sharedGroups in the
    // request body silently wiped any group restrictions.
    let rowCount;
    if (sharedGroups === undefined) {
        ({ rowCount } = await run(
            'UPDATE agents SET is_published = $1, rev = rev + 1, updated_at = NOW() WHERE id = $2 AND owner_id = $3',
            [!!isPublished, id, ownerId]
        ));
    } else {
        ({ rowCount } = await run(
            'UPDATE agents SET is_published = $1, shared_groups = $2, rev = rev + 1, updated_at = NOW() WHERE id = $3 AND owner_id = $4',
            [!!isPublished, JSON.stringify(sharedGroups || []), id, ownerId]
        ));
    }
    return rowCount > 0;
}

async function getPublishedAgentsForUser(userGroups = [], userOrgId = null, resolvedOrgIds = null) {
    await initDB();
    // Defensive: exclude orphaned agents whose owner no longer exists (e.g. left
    // behind by a pre-fix user deletion) so they can't surface as ghost agents in
    // a re-created user's library (BFSF-181).
    const allPublished = await getAll("SELECT a.* FROM agents a WHERE a.is_published = TRUE AND a.owner_id NOT IN ('system', 'swarm') AND EXISTS (SELECT 1 FROM users u WHERE u.id = a.owner_id) ORDER BY a.name ASC");

    // Use pre-resolved org IDs if provided (from resolveUserOrgIds), otherwise build from params
    let userOrgIds;
    if (resolvedOrgIds instanceof Set) {
        userOrgIds = resolvedOrgIds;
    } else {
        // Pre-load group→org mapping
        const groupsData = await getAll('SELECT id, "organizationId" FROM groups');
        const groupOrgMap = {};
        for (const g of groupsData) { groupOrgMap[g.id] = g.organizationId || null; }

        userOrgIds = new Set();
        if (userOrgId) userOrgIds.add(userOrgId);
        for (const gid of userGroups) { const orgId = groupOrgMap[gid]; if (orgId) userOrgIds.add(orgId); }
    }
    const hasOrgMembership = userOrgIds.size > 0;

    const filtered = allPublished.filter(agent => {
        if (hasOrgMembership) {
            // Strict isolation: org users ONLY see agents belonging to their org(s)
            if (!agent.organization_id) return false;
            if (!userOrgIds.has(agent.organization_id)) return false;
        } else {
            // Users without any org only see global (non-org) agents
            if (agent.organization_id) return false;
        }
        let sharedGroups = [];
        try { sharedGroups = JSON.parse(agent.shared_groups || '[]'); } catch (_) { }
        // If agent has group restrictions, user must be in at least one shared group
        if (sharedGroups.length > 0) return sharedGroups.some(sg => userGroups.includes(sg));
        return true;
    });

    const twpByAgent = await getAgentToolsWithParamsBatch(filtered.map(a => a.id));
    // Same projection as getPublishedAgents: the library serves what runs.
    return filtered.map(agent => {
        const twp = twpByAgent.get(agent.id) || [];
        return { ...parseConfig(projectRuntime(agent)), tools: twp.map(t => t.componentId), tool_params: buildToolParamsFromList(twp) };
    });
}

async function getAllAgents() {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE owner_id NOT IN ('system', 'swarm') ORDER BY updated_at DESC");
    const toolsByAgent = await getAgentToolsBatch(agents.map(a => a.id));
    return agents.map(agent => ({ ...parseConfig(agent), tools: toolsByAgent.get(agent.id) || [] }));
}

async function getSystemAgents() {
    await initDB();
    const agents = await getAll("SELECT * FROM agents WHERE owner_id = 'system' ORDER BY name ASC");
    const toolsByAgent = await getAgentToolsBatch(agents.map(a => a.id));
    return agents.map(agent => ({ ...parseConfig(agent), tools: toolsByAgent.get(agent.id) || [] }));
}

async function ensurePlaceholderAgent(id, name, description) {
    await initDB();
    const existing = await getOne('SELECT id FROM agents WHERE id = $1', [id]);
    if (!existing) {
        await run(`INSERT INTO agents (id, name, description, system_prompt, model, owner_id, is_published, created_at, updated_at)
            VALUES ($1,$2,$3,'','virtual','swarm',TRUE,NOW(),NOW())`, [id, name, description || 'Swarm Virtual Agent']);
    }
}

// ============ Agent Categories CRUD ============

async function getAgentCategories(orgId) {
    await initDB();
    if (orgId) {
        return getAll('SELECT * FROM agent_categories WHERE organization_id = $1 ORDER BY name ASC', [orgId]);
    }
    return getAll('SELECT * FROM agent_categories ORDER BY name ASC');
}

async function createAgentCategory(orgId, name, icon, color) {
    await initDB();
    const id = uuidv4();
    await run('INSERT INTO agent_categories (id, organization_id, name, icon, color) VALUES ($1,$2,$3,$4,$5)',
        [id, orgId || null, name, icon || '📁', color || '#6366f1']);
    return { id, organization_id: orgId, name, icon: icon || '📁', color: color || '#6366f1' };
}

// BFSF-272: full category management. The DELETE route has preferred this
// helper since 2026-03 (`typeof agentStore.countAgentsInCategory === 'function'`)
// but it never existed — every delete paid a full getAllAgents() scan.
async function countAgentsInCategory(id) {
    await initDB();
    const row = await getOne('SELECT COUNT(*)::int AS n FROM agents WHERE category_id = $1', [id]);
    return row?.n || 0;
}

async function getAgentCategory(id) {
    await initDB();
    return getOne('SELECT * FROM agent_categories WHERE id = $1', [id]);
}

// Case-insensitive duplicate lookup inside one org (NULL org = global bucket).
async function findAgentCategoryByName(orgId, name) {
    await initDB();
    return getOne(
        'SELECT * FROM agent_categories WHERE organization_id IS NOT DISTINCT FROM $1 AND LOWER(name) = LOWER($2)',
        [orgId || null, String(name || '').trim()]
    );
}

const CATEGORY_COLUMNS = {
    name: { col: 'name', transform: (v) => String(v).trim() },
    icon: 'icon',
    color: 'color',
};

/**
 * @param id
 * @param {{ name?: string, icon?: string, color?: string }} [opts]
 */
async function updateAgentCategory(id, { name, icon, color } = {}) {
    await initDB();
    const built = buildUpdate({
        table: 'agent_categories',
        updates: { name, icon, color },
        columnMap: CATEGORY_COLUMNS,
        where: [{ col: 'id', value: id }],
    });
    if (!built) return getAgentCategory(id);
    const { rowCount } = await run(built.sql, built.params);
    return rowCount > 0 ? getAgentCategory(id) : null;
}

// Move every agent in `fromId` to `toId` (null = uncategorise). Bumps `rev`
// so open editors reconcile via the existing 409 flow instead of silently
// clobbering (same precedent as transferAgentOwner).
async function reassignAgentsCategory(fromId, toId = null) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE agents SET category_id = $2, rev = rev + 1, updated_at = NOW() WHERE category_id = $1',
        [fromId, toId]
    );
    return rowCount;
}

// `orgId` (when provided) scopes the delete to that org — BFSF-272: the old
// unscoped delete let any manage_agents holder remove another org's category
// by id. Pass undefined only for super-admin callers.
async function deleteAgentCategory(id, orgId = undefined) {
    await initDB();
    // Unset category_id on agents that use this category
    await run('UPDATE agents SET category_id = NULL WHERE category_id = $1', [id]);
    const { rowCount } = orgId === undefined
        ? await run('DELETE FROM agent_categories WHERE id = $1', [id])
        : await run('DELETE FROM agent_categories WHERE id = $1 AND organization_id IS NOT DISTINCT FROM $2', [id, orgId || null]);
    return rowCount > 0;
}

const SCRUB_COLUMNS = {
    config: { col: 'config', transform: (v) => JSON.stringify(v) },
    publishedConfig: { col: 'published_config', cast: 'jsonb', transform: (v) => JSON.stringify(v) },
};

// Remove a skill id from every agent's config.attachedSkillIds — in the
// concept AND in published_config. The runtime reads the published copy once
// an agent is in split mode, so scrubbing only the concept would leave the
// deleted skill referenced by exactly the config that runs.
// Called when a skill is deleted so dangling references don't linger in agent configs.
async function scrubSkillFromAllAgents(orgId, skillId) {
    await initDB();
    if (!skillId) return 0;
    const query = orgId
        ? "SELECT id, config, published_config FROM agents WHERE organization_id = $1 AND (config::text LIKE $2 OR published_config::text LIKE $2)"
        : "SELECT id, config, published_config FROM agents WHERE config::text LIKE $1 OR published_config::text LIKE $1";
    const params = orgId ? [orgId, `%${skillId}%`] : [`%${skillId}%`];
    const rows = await getAll(query, params);
    let scrubbed = 0;
    const without = (raw) => {
        let cfg;
        try { cfg = typeof raw === 'string' ? JSON.parse(raw) : (raw || {}); } catch (_) { cfg = {}; }
        const ids = Array.isArray(cfg.attachedSkillIds) ? cfg.attachedSkillIds : null;
        if (!ids || !ids.includes(skillId)) return null;
        return { ...cfg, attachedSkillIds: ids.filter(x => x !== skillId) };
    };
    for (const row of rows) {
        const cfg = without(row.config);
        const pub = row.published_config == null ? null : without(row.published_config);
        if (!cfg && !pub) continue;
        // The published copy is patched in place, not re-published: a skill
        // deletion is a hotfix of what runs, not a new version of the agent.
        const built = buildUpdate({
            table: 'agents',
            updates: { config: cfg ?? undefined, publishedConfig: pub ?? undefined },
            columnMap: SCRUB_COLUMNS,
            extraSet: ['rev = rev + 1', 'updated_at = NOW()'],
            where: [{ col: 'id', value: row.id }],
        });
        if (!built) continue;
        await run(built.sql, built.params);
        scrubbed++;
    }
    return scrubbed;
}

/**
 * Reassign an agent's owner. Returns true on success, false if the agent
 * doesn't exist or the new owner isn't in the agent's org (caller is
 * responsible for that check too; we double-check here as a safety net).
 *
 * @param {string} agentId
 * @param {string} newOwnerId
 * @param {string} expectedOrgId  agent.organization_id (refuses if mismatch)
 */
async function transferAgentOwner(agentId, newOwnerId, expectedOrgId) {
    await initDB();
    const agent = await getOne('SELECT organization_id, project_id FROM agents WHERE id = $1', [agentId]);
    if (!agent) return false;
    // A managed agent runs as the stage's run-as user: ownership is never
    // handed over on a stage, not even by a deploy (no capability is passed).
    if (agent.project_id) {
        await managedParts.assertManagedWrite({ kind: 'agent', projectId: agent.project_id, changedKeys: ['ownerId'] });
    }
    if (expectedOrgId && agent.organization_id && agent.organization_id !== expectedOrgId) {
        return false;
    }
    const { rowCount } = await run(
        'UPDATE agents SET owner_id = $1, rev = rev + 1, updated_at = NOW() WHERE id = $2',
        [newOwnerId, agentId]
    );
    if (rowCount > 0 && agent.organization_id) _notifySync(agent.organization_id, agentId);
    return rowCount > 0;
}

// ── Solution membership (O1) ────────────────────────────────────────────────
//
// `agents.project_id` is a SOFT reference (stores/agent/initSchema.js): filing
// an agent into a project must never mean a project delete can destroy it. The
// three hooks below are what projects/membership.js registers, in the shape
// studioAppStore.setAppProject already proves — an owner-matched UPDATE that
// reports whether it matched, plus a detacher the project delete runs.

/**
 * The agents filed into one project.
 *
 * A DELIBERATELY NARROWER projection than getAgents(): the project's Content
 * tab needs a name, a description and an owner. `config` carries the agent's
 * tool grants, its knowledge-base ids and its attached skills, and
 * `system_prompt` is its instructions — handing either to every project member
 * because they may see the agent's NAME would be a disclosure the project role
 * never granted. Whoever opens the agent still goes through the agents routes,
 * which apply their own checks.
 */
async function listProjectAgents(projectId) {
    await initDB();
    if (!projectId) return [];
    const rows = await getAll(
        `SELECT id, name, description, avatar, owner_id, project_id, updated_at
           FROM agents WHERE project_id = $1 ORDER BY updated_at DESC`,
        [projectId],
    );
    return (rows || []).map(r => ({
        id: r.id,
        name: r.name,
        description: r.description || '',
        avatar: r.avatar || null,
        // ONE spelling, on purpose: this projection is new, so there is no
        // legacy caller to keep happy, and two names for one fact is two names
        // that can disagree about who owns the row.
        ownerId: r.owner_id,
        projectId: r.project_id || null,
        updatedAt: r.updated_at,
    }));
}

/**
 * How many agents each of these projects holds — ONE query for the whole
 * list, keyed by project id.
 *
 * The overview draws a card per Solution and every card carries a tally. Doing
 * that with the listing above would be one round-trip per project per kind, and
 * would read whole rows to throw all but their number away. A project that
 * appears in no row is genuinely EMPTY, which is why the caller distinguishes a
 * missing key (0) from a failed read (the whole call rejects) rather than
 * folding both into a zero.
 */
async function countProjectAgents(projectIds) {
    await initDB();
    const ids = (Array.isArray(projectIds) ? projectIds : []).filter(id => typeof id === 'string' && id);
    if (!ids.length) return new Map();
    const rows = await getAll(
        `SELECT project_id, COUNT(*)::int AS n FROM agents
          WHERE project_id = ANY($1) GROUP BY project_id`,
        [ids],
    );
    return new Map((rows || []).map(r => [r.project_id, Number(r.n) || 0]));
}

/**
 * File an agent into a project, or take it out (`projectId = null`).
 *
 * Owner-only, matched in the WHERE clause rather than checked first: filing an
 * agent into a project exposes it to every member without it being published to
 * the organisation, and that is the owner's call. The route checks the caller's
 * role on the TARGET project separately.
 *
 * `rev` is deliberately NOT bumped. `rev` is the editor's optimistic-concurrency
 * token over the agent's CONCEPT (name, prompt, config); filing the same agent
 * into a project changes none of that, and bumping it here would make an open
 * editor's next save collide with a change it cannot see.
 */
async function setAgentProject(agentId, userId, projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE agents SET project_id = $1, updated_at = NOW() WHERE id = $2 AND owner_id = $3',
        [projectId || null, agentId, userId],
    );
    return rowCount > 0;
}

/**
 * Detach every agent from a deleted project.
 *
 * Soft reference, so nothing clears it automatically — and deleting a project
 * must never destroy the agents its members built inside it.
 */
async function clearProjectFromAgents(projectId) {
    await initDB();
    const { rowCount } = await run(
        'UPDATE agents SET project_id = NULL WHERE project_id = $1',
        [projectId],
    );
    return rowCount;
}

module.exports = {
    createAgent, getAgents, getAgent, updateAgent, deleteAgent, forceDeleteAgent,
    snapshotAgent, assertAgentToolsWrite, managedPayloadOfAgent,
    getForRuntime, getAgentViews, publishAgentVersion, projectRuntime, projectDraft, isSplitActive,
    getPublishedAgents, setAgentPublished, getPublishedAgentsForUser,
    getAllAgents, getSystemAgents, ensurePlaceholderAgent,
    getAgentCategories, createAgentCategory, deleteAgentCategory,
    countAgentsInCategory, getAgentCategory, findAgentCategoryByName,
    updateAgentCategory, reassignAgentsCategory,
    scrubSkillFromAllAgents,
    transferAgentOwner,
    listProjectAgents, countProjectAgents, setAgentProject, clearProjectFromAgents,
};
