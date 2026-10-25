// @typecheck
/**
 * Agent CRUD - Create, Read, Update, Delete for agents + publish/org filtering
 */

const { randomUUID } = require('crypto');
const { run, getOne, withTransaction } = require('../../db');
const { initDB } = require('./initSchema');
const managedParts = require('../managedPartsDefault');
const { getAgentToolsWithParams } = require('./agentTools');
const log = require('../../telemetry/log');
const { _notifySync } = require('./agentSync');
const { isSplitActive, projectRuntime, projectDraft } = require('./agentRows');
const { getAgents, _loadAgentRow, getAgent } = require('./agentReads');
const { getForRuntime, getAgentViews } = require('./agentRuntimeView');
// The rest of the agent store lives beside this file and is re-exported below
// under the names it always had.
const { getPublishedAgents, setAgentPublished, getPublishedAgentsForUser, getAllAgents, getSystemAgents, ensurePlaceholderAgent } = require('./agentPublishing');
const { getAgentCategories, createAgentCategory, countAgentsInCategory, getAgentCategory, findAgentCategoryByName, updateAgentCategory, reassignAgentsCategory, deleteAgentCategory } = require('./agentCategories');
const { scrubSkillFromAllAgents, transferAgentOwner } = require('./agentOrgMaintenance');
const { listProjectAgents, countProjectAgents, setAgentProject, clearProjectFromAgents } = require('./agentProjects');

/**
 * @param {object} [opts]
 * @param {object|null} [opts.persona] The structured role (A1c). Absent ⇒ the
 *   column stays NULL, which reads back as free mode over `systemPrompt` — the
 *   same thing every pre-A1c agent does, so a caller that knows nothing about
 *   personas creates exactly what it always created. New trailing argument on
 *   purpose: the positional list here is already thirteen long, and the last
 *   time one was appended (`categoryId`) a caller that stopped short silently
 *   wiped it (see updateAgent).
 * @param {boolean} [threadsEnabled]
 * @param {boolean} [copyEnabled]
 * @param {boolean} [workspaceEnabled]
 */
async function createAgent(name, description, systemPrompt, ownerId, model = null, starterPrompts = [], threadsEnabled = true, copyEnabled = true, workspaceEnabled = false, config = {}, organizationId = null, sharedGroups = [], categoryId = null, opts = {}) {
    await initDB();
    const id = randomUUID();
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
    } catch (e) { log.error('[AgentCrud] Initial version snapshot failed:', /** @type {Error} */ (e).message); }
    _notifySync(organizationId, id);
    return result;
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
 * @param {boolean} [threadsEnabled]
 * @param {boolean} [copyEnabled]
 * @param {boolean} [workspaceEnabled]
 * @param {boolean} [embedEnabled]
 * @param {string} id
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
            } catch (e) { log.error('[AgentCrud] Version snapshot failed:', /** @type {Error} */ (e).message); }
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
 * An EXPLICIT version point of the current draft state, separate from the
 * autosave snapshot that updateAgent above already writes itself.
 *
 * Two things are deliberately fixed here:
 *
 *   The RAW row is snapshotted, not the presentation of getAgent(). In that
 *   presentation `persona` is a PROJECTION that drops away entirely on a read error
 *   (_withPersona then omits the key) — and a restore of such a snapshot reads that as
 *   "no persona" and writes the column empty. The raw row carries the column
 *   as it is, so a restore restores it as it was.
 *
 *   `changeSummary` is always supplied, so that createVersion does not need to run its
 *   _autoSummary query to invent a sentence that the caller already knows.
 *
 * If the agent does not exist, `null` comes back — not an empty snapshot, because
 * "nothing to restore" and "a snapshot of nothing" are not the same.
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
        log.warn(`[AgentCrud] managed lookup for ${agent.id} failed: ${/** @type {Error} */ (err).message}`);
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

/**
 * @param {string} id
 */
async function deleteAgent(id, ownerId, opts = {}) {
    await initDB();
    await assertAgentDeletable(id, opts);
    // Grab org_id before deleting so we can notify sync
    const agent = await getOne('SELECT organization_id FROM agents WHERE id = $1', [id]);
    const { rowCount } = await run('DELETE FROM agents WHERE id = $1 AND owner_id = $2', [id, ownerId]);
    if (rowCount > 0) await dropAutomationBindings(id);
    if (rowCount > 0 && agent?.organization_id) _notifySync(agent.organization_id, id, 'deleted');
    return rowCount > 0;
}

/**
 * An agent that is gone can no longer be called by anything, so the grants that
 * named it (automation_agent_bindings, automation/agentBinding.js) go with it.
 * `agent_id` there is a soft reference, not a foreign key, so nothing cascades.
 * Best effort and probe-first: the table belongs to the automation store, which
 * may not have booted yet, and a failed sweep must never fail the delete (the
 * runtime ignores a binding whose agent is gone either way).
 * @param {string} agentId
 */
async function dropAutomationBindings(agentId) {
    try {
        const probe = await getOne(`SELECT to_regclass('public.automation_agent_bindings') AS t`);
        if (!probe || !probe.t) return;
        await run('DELETE FROM automation_agent_bindings WHERE agent_id = $1', [agentId]);
    } catch (e) {
        log.warn(`[AgentCrud] could not drop the automation bindings of deleted agent ${agentId}: ${/** @type {Error} */ (e).message}`);
    }
}

/**
 * @param {string} id
 */
async function forceDeleteAgent(id, opts = {}) {
    await initDB();
    await assertAgentDeletable(id, opts);
    await run('DELETE FROM agent_tools WHERE agent_id = $1', [id]);
    await run('DELETE FROM agent_conversations WHERE agent_id = $1', [id]);
    const { rowCount } = await run('DELETE FROM agents WHERE id = $1', [id]);
    if (rowCount > 0) await dropAutomationBindings(id);
    return rowCount > 0;
}

// ============ Agent Categories CRUD ============

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
