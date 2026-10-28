// @typecheck
const { run, getOne, getAll } = require('../../db');
const { initDB } = require('./schema');
const log = require('../../telemetry/log');
const { syncSeatQuantity } = require('./seatSyncPort');
const { isMissingTable } = require('../../utils/isMissingTable');
const { bestEffort } = require('../../utils/bestEffort');
const { storeError } = require('../lib/storeError');

/**
 * Who inherits a departing owner's SHARED datatables: the organisation's oldest
 * remaining org_admin.
 *
 * Deterministic on purpose. "An admin" would hand a colleague's HR table to
 * whichever row Postgres happened to return first, and the ops line naming the
 * new owner would then be different on a replay — which is the opposite of an
 * audit trail. The account being deleted is excluded explicitly: its row is
 * only removed at the end of deleteUser, and the org-teardown path calls
 * deleteUser in a loop, so one of those rows is exactly the wrong answer.
 *
 * Returns null when no admin is left. The caller must NOT then delete the table
 * — it is the organisation's record, not the leaver's.
 */
async function oldestOrgAdmin(organizationId, excludeUserId) {
    if (!organizationId) return null;
    // A failed lookup throws: "no heir" would leave the table naming the leaver for good.
    const row = await getOne(
        `SELECT id FROM users
          WHERE "organizationId" = $1 AND "orgRole" = 'org_admin' AND id <> $2
          ORDER BY "createdAt" ASC NULLS LAST, id ASC
          LIMIT 1`,
        [organizationId, excludeUserId],
    );
    return row?.id || null;
}

/**
 * Art. 17 for "Find repeating work": the user's rows in suggestion_scan_cache
 * and automation_suggestion_feedback, through each store's purgeForUser (which
 * also catches legacy org-scoped rows by user_id). One failing store does not
 * stop the other; `onFail` (deleteUser) receives each failure that is not a
 * missing table. `stores` is the test seam.
 * @param {string} userId
 * @param {{ stores?: Array<{ purgeForUser: (id: string) => Promise<number> }>, onFail?: (e: unknown) => void }} [opts]
 */
async function eraseSuggestionTraces(userId, { stores, onFail } = {}) {
    const list = stores || [require('../suggestionScanCache'), require('../suggestionFeedbackStore')];
    let erased = 0;
    for (const store of list) {
        try { erased += (await store.purgeForUser(userId)) || 0; } catch (e) {
            if (onFail && !isMissingTable(e)) onFail(e);
            else log.warn('[UserStore] Suggestion erasure failed:', e.message);
        }
    }
    return erased;
}

/**
 * The stages `userId` runs or owns, optionally only those of one organisation.
 *
 * An install whose stage table was never created has no stage, and asking
 * the stage store would create its schema from an account write, so the
 * table's existence is checked first.
 *
 * @param {string} userId
 * @param {{ organizationId?: string|null }} [opts]
 * @returns {Promise<Array<{ projectId: string, solutionId: string, stage: string, organizationId: string }>>}
 */
async function stagesRunBy(userId, opts = {}) {
    if (!userId) return [];
    const table = await getOne(`SELECT to_regclass('solution_stages') IS NOT NULL AS present`);
    if (!table?.present) return [];
    const stages = await require('../solutionStageStore').runAsStagesFor(userId);
    if (!Object.prototype.hasOwnProperty.call(opts, 'organizationId')) return stages;
    return stages.filter((st) => (st.organizationId || '') === (opts.organizationId || ''));
}

/** 409 stage_run_as, naming the stages (ids only). */
function stageRunAsError(stages) {
    const { storeError } = require('../lib/managedParts');
    return storeError(409, 'stage_run_as',
        'This account runs a Solution stage. An org admin can detach or remove the stages first.',
        { stages: stages.map((st) => ({ solutionId: st.solutionId, stage: st.stage, projectId: st.projectId })) });
}

/**
 * Refuse with 409 stage_run_as when `userId` runs or owns a stage (of
 * `organizationId`, when given).
 * @param {string} userId
 * @param {{ organizationId?: string|null }} [opts]
 */
async function assertNotStageRunAs(userId, opts = {}) {
    const stages = await stagesRunBy(userId, opts);
    if (stages.length > 0) throw stageRunAsError(stages);
}

/**
 * CMS MCP upload tickets are config rows `cms_mcp_upload_<id>` holding plain
 * JSON that names the user. They are few and short-lived, so no timer sweeps
 * them; a user deletion just removes the ones that name that user. The prefix
 * mirrors cms/mcp/uploadTickets.js KEY_PREFIX (stores/ may not require a feature).
 *
 * @param {string} userId
 * @param {{ listKeysWithPrefix: Function, getConfigFresh: Function, deleteConfig: Function }} [configStore]
 * @returns {Promise<number>} rows removed
 */
async function eraseCmsUploadTickets(userId, configStore = require('../configStore')) {
    let removed = 0;
    for (const key of await configStore.listKeysWithPrefix('cms_mcp_upload_')) {
        const ticket = await configStore.getConfigFresh(key);
        if (ticket && typeof ticket === 'object' && ticket.userId === userId) {
            await configStore.deleteConfig(key);
            removed++;
        }
    }
    return removed;
}

/**
 * Collects the erasure steps of one deleteUser call that failed. A missing
 * table is not a failure (an install without that feature has nothing to
 * erase); anything else is logged with the step name and the user id only
 * (a driver message can quote row values) and makes the erasure incomplete.
 * @param {string} userId
 */
function erasureSteps(userId) {
    /** @type {string[]} */
    const failed = [];
    /** @param {string} name @param {unknown} e */
    const fail = (name, e) => {
        failed.push(name);
        const code = /** @type {{ code?: unknown, name?: unknown }} */ (e)?.code ?? /** @type {any} */ (e)?.name ?? 'unknown';
        log.error(`[UserStore] erasure step '${name}' failed for user '${userId}' (${code})`);
    };
    /** @param {string} name @param {() => Promise<unknown>} fn */
    const step = async (name, fn) => {
        try { await fn(); } catch (e) { if (!isMissingTable(e)) fail(name, e); }
    };
    return { failed, fail, step };
}

/**
 * Erase an account and everything that names it.
 *
 * The users row goes LAST: when a step fails, the row stays and the call
 * rejects with 500 erasure_incomplete (details.failed names the steps), so the
 * same delete can simply be retried. Every step is idempotent. The plain
 * DELETEs are not one transaction on purpose: an install without one of the
 * optional tables would abort the whole transaction on the first missing one.
 *
 * @param {string} userId
 * @returns {Promise<boolean>} false when there is no such account
 */
async function deleteUser(userId) {
    await initDB();
    // Before anything is dropped: an account that runs a Solution stage stays.
    await assertNotStageRunAs(userId);
    const { notebooks: notebookPort, teardown: projectTeardown } = require('./erasurePorts').resolveErasurePorts();
    // Capture the org now so we can sync Stripe seat quantity afterwards.
    // NULL orgId users (consumer accounts) skip the sync.
    const owner = await getOne('SELECT id, "organizationId" FROM users WHERE id = $1', [userId]);
    if (!owner) return false;
    const orgIdForSeatSync = owner.organizationId || null;
    const { failed, fail, step } = erasureSteps(userId);

    log.info(`[UserStore] Erasing the data of user '${userId}'...`);
    try {
        const configStore = require('../configStore');

        // Learning Center: revoke public certificate verify pages BEFORE
        // dropping the records — the reverse-lookup index rows are keyed by
        // token hash and would otherwise keep a deleted user's name publicly
        // resolvable at /verify/<token> forever.
        try {
            const certBlob = await configStore.getConfig(`learning_certificate_user_${userId}`);
            for (const record of Object.values(certBlob || {})) {
                if (record?.verifyTokenHash) {
                    await configStore.deleteConfig(`learning_cert_lookup_${record.verifyTokenHash}`);
                }
            }
        } catch (e) { fail('certificate lookups', e); }

        const configKeys = [
            `fireflies_api_key_user_${userId}`, `youtrack_url_user_${userId}`, `youtrack_token_user_${userId}`,
            `signrequest_subdomain_user_${userId}`, `signrequest_token_user_${userId}`,
            `gamma_api_key_user_${userId}`, `gads_developer_token_user_${userId}`, `gads_manager_id_user_${userId}`,
            `gads_customer_id_user_${userId}`, `enabled_apps_user_${userId}`,
            // Learning Center (progress blob, exercise ledger, certificates,
            // intro-tour flags) — contains the user's name on cert records.
            `learning_progress_user_${userId}`, `learning_exercises_user_${userId}`,
            `learning_certificate_user_${userId}`, `learning_intro_migrated_user_${userId}`,
            `has_seen_intro_tour_user_${userId}`,
            // Legacy MCP server token and its revocation marker.
            `mcp_server_token_user_${userId}`, `mcp_server_token_user_${userId}_revoked`,
        ];
        for (const key of configKeys) await configStore.deleteConfig(key);
    } catch (e) { fail('config keys', e); }

    // Named MCP tokens. No FK to users, so they go explicitly.
    await step('mcp_tokens', () => run('DELETE FROM mcp_tokens WHERE user_id = $1', [userId]));
    await step('cms upload tickets', () => eraseCmsUploadTickets(userId));

    // Notebooks. These were missed entirely: deleting a user left their
    // notebooks, sources, version snapshots, uploaded file blobs, derived
    // embeddings and encrypted in-notebook chat history all in place. For a
    // GDPR product an account deletion has to actually erase the documents.
    //
    // Runs through the cascade (not a bare DELETE) because the bytes live
    // outside Postgres — object storage and the vector index — and only the
    // cascade knows where. A storage failure does not stop the other steps, but
    // it leaves the erasure incomplete; the port lookup (top of deleteUser) is
    // outside the step: unregistered refuses.
    await step('notebooks', async () => {
        const { notebooks } = await notebookPort.deleteAllForUser(userId);
        if (notebooks) log.info(`[UserStore] Erased ${notebooks} notebook(s) for '${userId}'`);
    });
    await step('notebook_conversations', () => run('DELETE FROM notebook_conversations WHERE user_id = $1', [userId]));

    await step('user_memories', () => run('DELETE FROM user_memories WHERE user_id = $1', [userId]));
    // The tokenization vault is a store of this user's raw PII by definition,
    // so it has to go with them. Counters go too — unlike an in-life "clear
    // vault", there is no surviving message left to hold a stale token.
    await step('pii_vault_entries', () => run('DELETE FROM pii_vault_entries WHERE user_id = $1', [userId]));
    await step('pii_vault_counters', () => run('DELETE FROM pii_vault_counters WHERE user_id = $1', [userId]));
    await step('agent_conversations', () => run('DELETE FROM agent_conversations WHERE user_id = $1', [userId]));
    await step('direct_conversations', () => run('DELETE FROM direct_conversations WHERE user_id = $1', [userId]));
    await step('execution_history', () => run('DELETE FROM execution_history WHERE user_id = $1', [userId]));
    // Two tables that record what a person did and were never in this cascade.
    //
    // `message_feedback` holds their rating, their free-text comment and — on
    // rows written by the web client — `conversation_snapshot`, which is the
    // verbatim text of the conversation they rated. `ai_usage_log` holds a row
    // per turn: the model, the token counts and the cost, keyed to them.
    //
    // Neither is aggregate and neither is anonymous, so on a product that
    // advertises erasure both have to go with the account. Their absence is
    // exactly the kind of gap that only shows up when somebody exercises an
    // Art. 17 request and the answer turns out to be untrue.
    await step('message_feedback', () => run('DELETE FROM message_feedback WHERE user_id = $1', [userId]));
    await step('ai_usage_log', () => run('DELETE FROM ai_usage_log WHERE user_id = $1', [userId]));
    // Their "Don't count my chat turns" choice (chat signals, Art. 21).
    await step('chat_signal_objections', () => run('DELETE FROM chat_signal_objections WHERE user_id = $1', [userId]));
    // "Find repeating work": scans derived from this person's own mail, files
    // and ledger, and their feedback on them.
    await eraseSuggestionTraces(userId, { onFail: (e) => fail('suggestion traces', e) });
    // OAuth refresh tokens for long-running automations. If we leave these
    // behind, the encrypted secret is still in the DB after user delete,
    // and a future user with the same id (rare but possible) could inherit
    // it. App passwords live on the users row itself and are dropped by
    // the DELETE FROM users above.
    await step('automation_credentials', () => run('DELETE FROM automation_credentials WHERE user_id = $1', [userId]));
    // Cached integration answers. Fetched with THIS person's credentials and
    // about the things they could see, so they go with the account for the same
    // reason automation_credentials and the PII vault do — and an id reused later
    // must never inherit somebody else's mail.
    //
    // Through the store rather than a DELETE here: purgeForUser also drops the
    // memoised per-org row/byte counters, which otherwise keep claiming the org
    // still stores what was just erased, and the one Art. 17 guarantee that
    // cache makes stops being an untested SQL string in a cascade.
    await step('integration cache', () => require('../integrationCacheStore').purgeForUser(userId));
    // Named integration connections + lends, for the same reason. Two extra
    // hazards beyond id-reuse: the encrypted API keys of a departed employee
    // would otherwise sit in the vault indefinitely, and any org-wide lend they
    // made keeps RESOLVING for every colleague — their credentials would go on
    // running other people's automations after the account is gone. Grants they
    // received must go too, else a re-created id silently re-inherits them.
    // Grants ON the deleted user's own connections cascade via the FK.
    await step('connection_grants', () => run(
        `DELETE FROM connection_grants
         WHERE grantor_user_id = $1 OR (grantee_type = 'user' AND grantee_id = $1)`,
        [userId]
    ));
    await step('integration_connections', () => run('DELETE FROM integration_connections WHERE owner_user_id = $1', [userId]));
    // Voiceprints are biometric data (GDPR Art. 9). They must go with the
    // account, unconditionally — there is no legitimate reason to keep a
    // speaker template for a user who no longer exists.
    await step('voiceprints', () => run('DELETE FROM voiceprints WHERE user_id = $1', [userId]));
    // Projects: delete the user's owned projects the way the project delete
    // route does (colleagues' co-edits folded back, soft references detached,
    // files base removed; stores/user/projectErasure.js), and remove any
    // shares that target this user directly.
    const owned = await require('./projectErasure').eraseOwnedProjects(userId, { teardown: projectTeardown });
    if (owned.deleted || owned.kept || owned.failed) log.info(`[UserStore] Owned projects of '${userId}': ${JSON.stringify(owned)}`);
    if (owned.failed) failed.push('owned projects');
    await step('project_shares', () => run(`DELETE FROM project_shares WHERE shared_with_type = 'user' AND shared_with_id = $1`, [userId]));
    // What they wrote and marked in colleagues' projects: team chat messages and
    // comments blanked as if by their own hand, their id out of the co-editing
    // log, their seen marks and AI feedback gone (stores/user/projectErasure.js).
    // Their OWN projects went with them above.
    const traces = await require('./projectErasure').eraseProjectTraces(userId);
    for (const [name, outcome] of Object.entries(traces)) if (outcome?.failed === true) failed.push(`project ${name}`);
    // Agents owned by this user. Without this they become orphans with a
    // non-existent owner; a future user re-created with the same id would inherit
    // them as ghost agents in the library. Mirror the org-delete
    // cascade: drop each agent's conversations first, then the agents.
    await step('agents', async () => {
        const ownedAgents = await getAll('SELECT id FROM agents WHERE owner_id = $1', [userId]);
        for (const agent of ownedAgents) await run('DELETE FROM agent_conversations WHERE agent_id = $1', [agent.id]);
        await run('DELETE FROM agents WHERE owner_id = $1', [userId]);
    });

    // Datatables. Two different things wear the same shape here, so they get
    // different answers:
    //
    //   - a table nobody else could reach (never published, no grants) is this
    //     person's, and goes with the account ROWS INCLUDED — which is why it
    //     runs through dropDatatable and not a metadata DELETE;
    //   - a published or granted table is the ORGANISATION's record under its
    //     own lawful basis. Erasing a colleague's data because an employee left
    //     is not erasure, it is data loss, so it is TRANSFERRED instead.
    //
    // Either way the leaver stops being the owner. owner_user_id and the grant
    // rows are resolved BY ID, so left alone a user re-created with the same id
    // comes back as owner of a colleague's HR table — the same mechanism as the
    // agents cascade above.
    await step('datatables', async () => {
        const datatableStore = require('../datatableStore');
        const removedGrants = await datatableStore.purgeGrantsForUser(userId);
        if (removedGrants) log.info(`[UserStore] Removed ${removedGrants} datatable grant(s) for '${userId}'`);

        const owned = await datatableStore.listOwnedBy(userId);
        const heirs = new Map();   // organizationId → heir id | null, resolved once per org
        for (const t of owned) {
            if (!t.isPublished && !t.grantCount) {
                const dropped = await require('../datatableDbStore').dropDatatable(t.id, t.scope);
                log.info(`[UserStore] Private datatable '${t.key}' (${t.id}) ${dropped ? 'deleted with' : 'NOT deleted with'} account '${userId}'`);
                continue;
            }
            if (!heirs.has(t.organizationId)) {
                heirs.set(t.organizationId, await oldestOrgAdmin(t.organizationId, userId));
            }
            const heir = heirs.get(t.organizationId);
            if (!heir) {
                // Nothing safe to do: it is the org's record, so deleting it is
                // wrong, and there is nobody to hand it to. Say so loudly — it
                // still names a user id that no longer exists.
                log.error(`[UserStore] Shared datatable '${t.key}' (${t.id}) has no org_admin to inherit it; it still names deleted owner '${userId}'`);
                continue;
            }
            await datatableStore.transferOwner(t.id, t.scope, heir);
            log.info(`[UserStore] Transferred datatable '${t.key}' (${t.id}) from '${userId}' to org_admin '${heir}'`);
        }

        // The account's PERSONAL tenancy, once its tables are gone: a Postgres
        // schema of its own plus one `datatable_models` row keyed on the user
        // id. Dropping the tables leaves both behind, and the row is itself an
        // identifier of a person who asked to be erased. Nothing else can reach
        // this scope, so nothing else would ever clean it up.
        const datatableDbStore = require('../datatableDbStore');
        const personalKey = datatableDbStore.scopeKey({ kind: 'user', id: userId });
        const hasPersonalModel = await getOne(
            `SELECT 1 AS present FROM datatable_models WHERE scope_kind = 'user' AND scope_id = $1`, [userId]);
        if (hasPersonalModel) {
            // Rows first, metadata second — the same order deleteOrganization
            // uses, and for the same reason: a crash in between must leave
            // findable metadata pointing at a schema that is gone, never rows
            // that nothing describes.
            await datatableDbStore.reset(personalKey, personalKey);
            await run(`DELETE FROM datatable_models WHERE scope_kind = 'user' AND scope_id = $1`, [userId]);
            datatableDbStore.invalidate(personalKey);
            log.info(`[UserStore] Dropped the personal datatable schema for '${userId}'`);
        }
    });

    await step('notifications', async () => {
        const notificationStore = require('../notificationStore');
        if (notificationStore.deleteUserNotifications) await notificationStore.deleteUserNotifications(userId);
    });

    if (failed.length) {
        throw storeError(500, 'erasure_incomplete',
            'The account could not be fully erased. It is kept so the delete can be retried.', { failed });
    }
    await run('DELETE FROM users WHERE id = $1', [userId]);
    log.info(`[UserStore] Cleanup complete for user '${userId}'`);
    // Per-seat plans rebill on user count change. Fire-and-forget — Stripe
    // outages don't block the delete; the webhook reconciles afterwards.
    if (orgIdForSeatSync) {
        Promise.resolve().then(async () => {
            try {
                await syncSeatQuantity(orgIdForSeatSync);
            } catch (err) { bestEffort('users/delete:seatSync', err); }
        });
    }
    return true;
}

module.exports = { eraseSuggestionTraces, stagesRunBy, assertNotStageRunAs, eraseCmsUploadTickets, deleteUser };
