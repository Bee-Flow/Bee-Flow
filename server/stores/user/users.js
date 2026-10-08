// @typecheck
// Users — CRUD, avatar/directory reads, the account-deletion cascade, and the
// atomic seat-cap creation path.

const { run, getOne, getAll, getClient } = require('../../db');
const { initDB } = require('./schema');
const { dynamicUpdate, parseJSON } = require('./shared');
const { getEffectiveLimits } = require('./subscriptions');
const log = require('../../telemetry/log');

/**
 * Strip markup from the three free-text name fields on a user row.
 *
 * Lives here rather than in each route because every writer converges on
 * createUser/updateUser: public signup, the admin panel, Google/Microsoft/
 * Nextcloud OAuth, and the Azure + Nextcloud directory syncs. A pentest stored
 * `<img src=x onerror=...>` in an organisation's tagline; the same request's
 * displayName was still landing verbatim after the org fields had been fixed,
 * which is what a single choke point prevents.
 *
 * Lazily required: utils/htmlSanitizer pulls in JSDOM, and this module is loaded
 * during boot before that cost is worth paying. Falls back to a plain tag strip
 * if it cannot be loaded, so a write is never blocked on the sanitiser.
 *
 * @param {object} src        the incoming user data / update payload
 * @param {{onlyPresent?: boolean}} opts  skip keys the caller did not supply
 */
function sanitizeUserNames(src, { onlyPresent = false } = {}) {
    const fields = ['displayName', 'firstName', 'lastName'];
    let clean;
    try {
        clean = require('../../utils/htmlSanitizer').sanitizePlainText;
    } catch (_) {
        clean = (v) => (typeof v === 'string' ? v.replace(/<[^>]*>/g, '').trim() : v);
    }
    const out = {};
    for (const f of fields) {
        if (onlyPresent && !Object.prototype.hasOwnProperty.call(src || {}, f)) continue;
        out[f] = clean(src?.[f], { maxLen: 200 });
    }
    return out;
}

/**
 * Does this write install a genuinely NEW login credential?
 *
 * Same argument as sanitizeUserNames above: every writer converges on
 * createUser / createUserWithSeatCheck / updateUser, so the decision belongs
 * here and not spread over seven routes where the eighth one forgets it. The
 * answer drives `password_changed_at`, which a person reads on their security
 * screen as "your password was last changed on …".
 *
 * A non-empty passwordHash is a new password. Two kinds of write look like one
 * and are not:
 *   - `passwordHash: ''` — Azure/SSO provisioning creates an account with no
 *     password at all. An empty string is not a credential, so it never counts.
 *   - the built-in admin row being MATERIALISED (auth/login/finalizeLogin.js,
 *     auth/mfaRoutes.js): those copy the ALREADY EXISTING hash out of the
 *     config into the users table. Nothing changed for the account holder, and
 *     stamping there would claim a months-old password was changed today. Those
 *     two call sites say so with `credentialUnchanged: true`.
 *
 * OPAQUE accounts carry their credential in `opaqueRecord` rather than a bcrypt
 * hash, so auth/opaqueRoutes.js opts in explicitly by passing
 * `passwordChangedAt` itself — see the note there for why only the account
 * registration does that and the SSO encryption PIN does not.
 */
function isNewCredential(data) {
    if (!data || data.credentialUnchanged === true) return false;
    return typeof data.passwordHash === 'string' && data.passwordHash.length > 0;
}

// ── Users ─────────────────────────────
async function getAllUsers() {
    await initDB();
    // Excludes avatar (base64 blob, up to 200 KB per user) from list queries —
    // callers that need the avatar should use getUser(id) or getAllUserAvatars().
    //
    // Excludes envelope-encryption material too — "masterWrappedDEK",
    // "wrappedDEK", "kekSalt", "recoverySalt", "recoveryWrappedDEK". This list is
    // served straight to the client by GET /auth/users (adminRoutes.js), so every
    // holder of org_admin / admin_security / manage_users used to receive every
    // visible user's wrapped DEKs AND their KDF salts — the complete input set for
    // an offline attack on a member's password, with no server involved. The keys
    // are wrapped rather than plaintext, so this was a weakening of the
    // zero-knowledge model rather than a key leak, but on this product that is
    // still not something to hand out with a user list.
    //
    // Nothing needs them from here: the only readers are auth/encryption.js and
    // auth/opaqueRoutes.js, and both resolve a single user via getUser(id).
    // If a future caller genuinely needs them in bulk, add getAllUsersWithKeys()
    // and leave this one safe by default — do not widen this SELECT.
    //
    // mfa_enabled and last_seen_at ARE here: the admin user list is exactly the
    // screen that has to show who still has no second factor and who has stopped
    // showing up, and both are facts about the account rather than material an
    // attacker can use. password_changed_at is deliberately NOT here — the only
    // consumer is a person's own security screen, which reads it from
    // /auth/user, and one org_admin does not need a per-colleague password-age
    // report to do their job.
    const rows = await getAll(`
        SELECT id, username, "displayName", "firstName", "lastName", email, phone,
               "avatarType", role, groups, "orgRole", "organizationId",
               "ssoEncryptionSetup", "passwordResetRequired",
               "dekUnwrapFailures", "dekLockoutUntil", "kdfMode", "createdAt",
               status, "activeIconPackId", "azureUserId", "azureTenantId",
               "nc_uid", "provider", "auto_provisioned",
               mfa_enabled, last_seen_at
        FROM users
    `);
    // The raw columns stay on the row (nc_uid/provider/auto_provisioned already
    // travel that way), with camelCase aliases alongside so clients can read
    // these two like every other field. Additive on purpose: the web and mobile
    // clients ignore what they do not know, and renaming would break them.
    return rows.map(u => ({
        ...u,
        groups: parseJSON(u.groups, []),
        mfaEnabled: !!u.mfa_enabled,
        lastSeenAt: u.last_seen_at || null,
    }));
}

// Lightweight list that *does* include the avatar blob. Use only when callers
// need to render avatars for many users (e.g. the usage / monitoring page).
async function getAllUserAvatars() {
    await initDB();
    return getAll(`SELECT id, username, "displayName", "avatarType", avatar FROM users`);
}

/**
 * Avatar/display info for a specific set of user ids — one indexed query
 * instead of the full-table scan above. Used by the monitoring endpoints,
 * which only ever need the handful of users appearing in the current page.
 */
async function getUserAvatarsByIds(ids) {
    const list = Array.from(new Set(ids || [])).filter(Boolean);
    if (list.length === 0) return [];
    await initDB();
    return getAll(`SELECT id, username, "displayName", "avatarType", avatar FROM users WHERE id = ANY($1)`, [list]);
}


/**
 * The people in one organisation, for a person picker inside a Studio app.
 *
 * DO NOT WIDEN THIS SELECT — the same rule as getAllUsers, and here it binds
 * harder. Every other directory read on this server is gated behind an admin
 * permission (manage_users / org_admin / admin_compliance). This one is reached
 * by anyone who can OPEN a published app, so it returns the least a picker can
 * work with: who they are and what to call them.
 *
 * No e-mail. A picker needs a label, not an address, and e-mail here would turn
 * one published app into an address-book export for the whole organisation.
 * Two colleagues with the same display name are told apart by `username`, which
 * is not a way to reach anybody.
 *
 * No avatar. The column is a base64 blob up to ~200 KB; a 200-person org would
 * be tens of megabytes on a control that shows twenty rows. Callers render a
 * monogram, and `avatarType` says whether a real photo exists for a future
 * batched lookup (getUserAvatarsByIds) over the ids actually on screen.
 *
 * Inactive accounts are left out: assigning work to someone who has left is a
 * bug you find out about weeks later.
 */
async function getOrgMembersForDirectory(organizationId, limit = 500) {
    if (!organizationId) return [];
    await initDB();
    const capped = Math.max(1, Math.min(1000, Number(limit) || 500));
    return getAll(`
        SELECT id, "displayName", username, "avatarType"
        FROM users
        WHERE "organizationId" = $1
          AND COALESCE(status, 'active') = 'active'
        ORDER BY COALESCE(NULLIF("displayName", ''), username) ASC
        LIMIT $2
    `, [organizationId, capped]);
}

async function getUser(userId) {
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!u) return null;
    return {
        ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword),
        masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK),
        recoveryWrappedDEK: parseJSON(u.recoveryWrappedDEK, u.recoveryWrappedDEK),
        dekUnwrapFailures: u.dekUnwrapFailures || 0, ssoEncryptionSetup: u.ssoEncryptionSetup || 0,
        recoveryUnwrapFailures: u.recoveryUnwrapFailures || 0,
        passwordResetRequired: u.passwordResetRequired || 0
    };
}

async function getUserByEmail(email) {
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!u) return null;
    return {
        ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword),
        masterWrappedDEK: parseJSON(u.masterWrappedDEK, u.masterWrappedDEK), wrappedDEK: parseJSON(u.wrappedDEK, u.wrappedDEK),
        recoveryWrappedDEK: parseJSON(u.recoveryWrappedDEK, u.recoveryWrappedDEK),
        dekUnwrapFailures: u.dekUnwrapFailures || 0, ssoEncryptionSetup: u.ssoEncryptionSetup || 0,
        recoveryUnwrapFailures: u.recoveryUnwrapFailures || 0,
        passwordResetRequired: u.passwordResetRequired || 0
    };
}

// Look up a user by the SHA-256 hash of a password-reset token. Returns the
// raw row (callers check password_reset_expires_at). No JSON parsing needed.
async function getUserByPasswordResetToken(tokenHash) {
    if (!tokenHash) return null;
    await initDB();
    return getOne('SELECT * FROM users WHERE password_reset_token_hash = $1', [tokenHash]);
}

// Look up a user by the SHA-256 hash of an email-verification token. Returns
// the raw row (callers check email_verification_expires_at). The raw token
// only ever lives in the emailed verification link.
async function getUserByEmailVerificationToken(tokenHash) {
    if (!tokenHash) return null;
    await initDB();
    return getOne('SELECT * FROM users WHERE email_verification_token_hash = $1', [tokenHash]);
}

async function createUser(userData) {
    await initDB();
    const { id, username, passwordHash, email, phone, avatar, avatarType, role, groups, orgRole, organizationId, ncUid, provider, autoProvisioned } = userData;
    // Names are stripped of markup HERE, at the one point every path goes
    // through — public signup, the admin panel, all three OAuth providers, the
    // Nextcloud and Azure directory syncs. Fixing the routes one at a time left
    // signup's displayName still storing `<img src=x onerror=...>` after the
    // organisation fields on the very same request were already clean.
    // A display name is not markup on any code path, so this loses nothing.
    const { displayName, firstName, lastName } = sanitizeUserNames(userData);
    const existing = await getOne('SELECT id FROM users WHERE id = $1', [id]);
    if (existing) return false;
    try {
        const mwDek = userData.masterWrappedDEK ? (typeof userData.masterWrappedDEK === 'string' ? userData.masterWrappedDEK : JSON.stringify(userData.masterWrappedDEK)) : null;
        const wDek = userData.wrappedDEK ? (typeof userData.wrappedDEK === 'string' ? userData.wrappedDEK : JSON.stringify(userData.wrappedDEK)) : null;
        await run(`INSERT INTO users (id, username, "displayName", "firstName", "lastName", email, phone, avatar, "avatarType", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt", status, "azureUserId", "nc_uid", "provider", "auto_provisioned", password_changed_at, "azureTenantId")
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
            [id, username, displayName || username, firstName || null, lastName || null, email || null, phone || null,
                avatar || null, avatarType || null, passwordHash, role || 'user',
                JSON.stringify(groups || []), mwDek, wDek, orgRole || '', organizationId || '',
                new Date().toISOString().split('T')[0], userData.status || 'active', userData.azureUserId || null,
                ncUid || null, provider || null, autoProvisioned ? true : false,
                // An account created WITH a password has its password set right
                // now; one provisioned without one (SSO) keeps NULL = unknown.
                // "createdAt" cannot stand in for this — it is a date-only TEXT
                // column and it never moves when the password later changes.
                isNewCredential(userData) ? new Date() : null, userData.azureTenantId || null]);
        return true;
    } catch (e) { log.error(e); return false; }
}

/**
 * The id of the org member with this address, or null.
 *
 * Deliberately NARROW, and deliberately org-pinned. `getUserByEmail` above is a
 * platform-wide lookup — right for signing in, wrong for anything that answers a
 * question on behalf of one tenant: it will happily confirm that an address
 * belongs to somebody in another organisation. The DSR discovery scan asks
 * exactly that question, so it asks it here instead.
 *
 * It returns an id and nothing else on purpose. The caller wants to know "is
 * this person one of ours"; handing back the whole row would put wrapped DEKs
 * and reset-token hashes into a compliance report's reach for no reason.
 */
async function findOrgMemberIdByEmail(organizationId, email) {
    if (!organizationId || !email) return null;
    await initDB();
    const u = await getOne(
        'SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND "organizationId" = $2',
        [email, organizationId],
    );
    return u?.id || null;
}

async function getUserByNcUid(organizationId, ncUid) {
    if (!organizationId || !ncUid) return null;
    await initDB();
    const u = await getOne('SELECT * FROM users WHERE "organizationId" = $1 AND "nc_uid" = $2', [organizationId, ncUid]);
    if (!u) return null;
    // Match the shape produced by getUser/getUserByEmail — JSON columns are
    // parsed so callers can rely on `groups` being an array. Without this
    // ncUserGroupSync's group-diff comparisons silently rewrite every sync.
    return { ...u, groups: parseJSON(u.groups, []), appPassword: parseJSON(u.appPassword, u.appPassword) };
}

/**
 * Who inherits a departing owner's SHARED datatables: the organisation's oldest
 * remaining org_admin.
 *
 * Deterministic on purpose. "An admin" would hand a colleague's HR table to
 * whichever row Postgres happened to return first, and the ops line naming the
 * new owner would then be different on a replay — which is the opposite of an
 * audit trail. The account being deleted is excluded explicitly; the DELETE has
 * already run by the time this is called, but the org-teardown path calls
 * deleteUser in a loop and one of those rows is exactly the wrong answer.
 *
 * Returns null when no admin is left. The caller must NOT then delete the table
 * — it is the organisation's record, not the leaver's.
 */
async function oldestOrgAdmin(organizationId, excludeUserId) {
    if (!organizationId) return null;
    try {
        const row = await getOne(
            `SELECT id FROM users
              WHERE "organizationId" = $1 AND "orgRole" = 'org_admin' AND id <> $2
              ORDER BY "createdAt" ASC NULLS LAST, id ASC
              LIMIT 1`,
            [organizationId, excludeUserId],
        );
        return row?.id || null;
    } catch (e) {
        log.warn('[UserStore] could not resolve an org_admin heir:', e.message);
        return null;
    }
}

/**
 * Art. 17 for "Find repeating work": the user's rows in suggestion_scan_cache
 * and automation_suggestion_feedback, through each store's purgeForUser (which
 * also catches legacy org-scoped rows by user_id). Best-effort per store, like
 * the rest of deleteUser. `stores` is the test seam.
 * @param {string} userId
 * @param {{ stores?: Array<{ purgeForUser: (id: string) => Promise<number> }> }} [opts]
 */
async function eraseSuggestionTraces(userId, { stores } = {}) {
    const list = stores || [require('../suggestionScanCache'), require('../suggestionFeedbackStore')];
    let erased = 0;
    for (const store of list) {
        try { erased += (await store.purgeForUser(userId)) || 0; } catch (e) {
            log.warn('[UserStore] Suggestion erasure failed:', e.message);
        }
    }
    return erased;
}

// ── Solution stages: the run-as wall (design 3.1, 3.4) ─────────────
//
// A Solution's UAT and PRD stages run as one account (`run_as_user_id`, in
// v1 the Solution owner), which owns every part deployed there: cross-owner
// edges refuse at run time. Deleting that account would drop the stage
// tables with it (the private-table rule below), and moving it out of the
// organisation strands every part. So both are refused (409 stage_run_as)
// while the account runs or owns a stage; an org admin can detach or remove
// the stages first.

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

async function deleteUser(userId) {
    await initDB();
    // Before anything is dropped: an account that runs a Solution stage stays.
    await assertNotStageRunAs(userId);
    // Capture the org before DELETE so we can sync Stripe seat quantity
    // afterwards. NULL orgId users (consumer accounts) skip the sync.
    let orgIdForSeatSync = null;
    try {
        const owner = await getOne('SELECT "organizationId" FROM users WHERE id = $1', [userId]);
        orgIdForSeatSync = owner?.organizationId || null;
    } catch (_) { /* best-effort */ }
    const { rowCount } = await run('DELETE FROM users WHERE id = $1', [userId]);
    if (rowCount === 0) return false;

    log.info(`[UserStore] Cleaning up data for deleted user '${userId}'...`);
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
        } catch (e) { log.error('[UserStore] Failed to revoke cert lookups:', e.message); }

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
        ];
        for (const key of configKeys) await configStore.deleteConfig(key);
    } catch (e) { log.error('[UserStore] Failed to clean user config keys:', e.message); }

    // Notebooks. These were missed entirely: deleting a user left their
    // notebooks, sources, version snapshots, uploaded file blobs, derived
    // embeddings and encrypted in-notebook chat history all in place. For a
    // GDPR product an account deletion has to actually erase the documents.
    //
    // Runs through the cascade (not a bare DELETE) because the bytes live
    // outside Postgres — object storage and the vector index — and only the
    // cascade knows where. Best-effort: a storage failure must not stop the
    // rest of the account teardown.
    try {
        const { deleteAllNotebooksForUser } = require('../../core/kb/notebookCascade');
        const { notebooks } = await deleteAllNotebooksForUser(userId);
        if (notebooks) log.info(`[UserStore] Erased ${notebooks} notebook(s) for '${userId}'`);
    } catch (e) { log.error('[UserStore] Notebook erasure failed:', e.message); }
    try { await run('DELETE FROM notebook_conversations WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }

    try { await run('DELETE FROM user_memories WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    // The tokenization vault is a store of this user's raw PII by definition,
    // so it has to go with them. Counters go too — unlike an in-life "clear
    // vault", there is no surviving message left to hold a stale token.
    try { await run('DELETE FROM pii_vault_entries WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM pii_vault_counters WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM agent_conversations WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM direct_conversations WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM execution_history WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
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
    try { await run('DELETE FROM message_feedback WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM ai_usage_log WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    // Their "Don't count my chat turns" choice (chat signals, Art. 21).
    try { await run('DELETE FROM chat_signal_objections WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    // "Find repeating work": scans derived from this person's own mail, files
    // and ledger, and their feedback on them.
    await eraseSuggestionTraces(userId);
    // OAuth refresh tokens for long-running automations. If we leave these
    // behind, the encrypted secret is still in the DB after user delete,
    // and a future user with the same id (rare but possible) could inherit
    // it. App passwords live on the users row itself and are dropped by
    // the DELETE FROM users above.
    try { await run('DELETE FROM automation_credentials WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    // Cached integration answers. Fetched with THIS person's credentials and
    // about the things they could see, so they go with the account for the same
    // reason automation_credentials and the PII vault do — and an id reused later
    // must never inherit somebody else's mail.
    //
    // Through the store rather than a DELETE here: purgeForUser also drops the
    // memoised per-org row/byte counters, which otherwise keep claiming the org
    // still stores what was just erased, and the one Art. 17 guarantee that
    // cache makes stops being an untested SQL string in a cascade.
    try { await require('../integrationCacheStore').purgeForUser(userId); } catch (e) { /* table may not exist */ }
    // Named integration connections + lends, for the same reason. Two extra
    // hazards beyond id-reuse: the encrypted API keys of a departed employee
    // would otherwise sit in the vault indefinitely, and any org-wide lend they
    // made keeps RESOLVING for every colleague — their credentials would go on
    // running other people's automations after the account is gone. Grants they
    // received must go too, else a re-created id silently re-inherits them.
    // Grants ON the deleted user's own connections cascade via the FK.
    try {
        await run(
            `DELETE FROM connection_grants
             WHERE grantor_user_id = $1 OR (grantee_type = 'user' AND grantee_id = $1)`,
            [userId]
        );
    } catch (e) { /* table may not exist */ }
    try { await run('DELETE FROM integration_connections WHERE owner_user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    // Voiceprints are biometric data (GDPR Art. 9). They must go with the
    // account, unconditionally — there is no legitimate reason to keep a
    // speaker template for a user who no longer exists.
    try { await run('DELETE FROM voiceprints WHERE user_id = $1', [userId]); } catch (e) { /* table may not exist */ }
    // Projects: delete the user's owned projects the way the project delete
    // route does (colleagues' co-edits folded back, soft references detached,
    // files base removed; stores/user/projectErasure.js), and remove any
    // shares that target this user directly.
    const owned = await require('./projectErasure').eraseOwnedProjects(userId);
    if (owned.deleted || owned.kept || owned.failed) log.info(`[UserStore] Owned projects of '${userId}': ${JSON.stringify(owned)}`);
    try { await run(`DELETE FROM project_shares WHERE shared_with_type = 'user' AND shared_with_id = $1`, [userId]); } catch (e) { /* table may not exist */ }
    // What they wrote and marked in colleagues' projects: team chat messages and
    // comments blanked as if by their own hand, their id out of the co-editing
    // log, their seen marks and AI feedback gone (stores/user/projectErasure.js).
    // Their OWN projects went with them above.
    await require('./projectErasure').eraseProjectTraces(userId);
    // Agents owned by this user. Without this they become orphans with a
    // non-existent owner; a future user re-created with the same id would inherit
    // them as ghost agents in the library (BFSF-181). Mirror the org-delete
    // cascade: drop each agent's conversations first, then the agents.
    try {
        const ownedAgents = await getAll('SELECT id FROM agents WHERE owner_id = $1', [userId]);
        for (const agent of ownedAgents) { try { await run('DELETE FROM agent_conversations WHERE agent_id = $1', [agent.id]); } catch (_) { } }
        await run('DELETE FROM agents WHERE owner_id = $1', [userId]);
    } catch (e) { /* table may not exist */ }

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
    // agents cascade above (BFSF-181).
    try {
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
    } catch (e) { log.error('[UserStore] datatable erasure failed:', e.message); }

    try {
        const notificationStore = require('../notificationStore');
        if (notificationStore.deleteUserNotifications) await notificationStore.deleteUserNotifications(userId);
    } catch (e) { /* PG store may not be initialized */ }

    log.info(`[UserStore] Cleanup complete for user '${userId}'`);
    // Per-seat plans rebill on user count change. Fire-and-forget — Stripe
    // outages don't block the delete; the webhook reconciles afterwards.
    if (orgIdForSeatSync) {
        Promise.resolve().then(async () => {
            try {
                const { syncSeatQuantityForOrg } = require('../../services/stripeService');
                await syncSeatQuantityForOrg(orgIdForSeatSync);
            } catch (_) { /* best-effort */ }
        });
    }
    return true;
}

async function updateUser(userId, updates) {
    await initDB();
    const existing = await getOne('SELECT * FROM users WHERE id = $1', [userId]);
    if (!existing) return false;

    // Every path that moves a member out of (or between) organisations ends
    // here: an account that runs a stage of its organisation stays put.
    if (updates.organizationId !== undefined && (updates.organizationId || '') !== (existing.organizationId || '')) {
        await assertNotStageRunAs(userId, { organizationId: existing.organizationId || '' });
    }

    // Same choke point as createUser — see the note there. Only the name
    // fields, and only when the caller actually supplied them, so a partial
    // update (a token write, a DEK rewrap) is untouched.
    updates = { ...updates, ...sanitizeUserNames(updates, { onlyPresent: true }) };

    // Every path that writes a new password hash also dates it, at the one point
    // they all pass through: the admin edit form, the admin reset, self-service
    // change-password, and the e-mailed reset link. A caller that knows better
    // (OPAQUE registration, where the credential is not a bcrypt hash) supplies
    // `passwordChangedAt` itself and is left alone.
    if (isNewCredential(updates) && updates.passwordChangedAt === undefined) {
        updates = { ...updates, passwordChangedAt: new Date() };
    }

    const serializeDek = (val) => {
        if (val === null) return null;
        if (val === undefined) return undefined;
        return typeof val === 'string' ? val : JSON.stringify(val);
    };

    // Build update map: jsKey → dbCol
    const updateMap = {};
    const colMap = {
        username: 'username', displayName: 'displayName', firstName: 'firstName', lastName: 'lastName',
        email: 'email', phone: 'phone', avatar: 'avatar', avatarType: 'avatarType',
        passwordHash: 'passwordHash', role: 'role', orgRole: 'orgRole', organizationId: 'organizationId',
        kekSalt: 'kekSalt', recoverySalt: 'recoverySalt', ssoEncryptionSetup: 'ssoEncryptionSetup',
        passwordResetRequired: 'passwordResetRequired', dekUnwrapFailures: 'dekUnwrapFailures',
        dekLockoutUntil: 'dekLockoutUntil',
        recoveryUnwrapFailures: 'recoveryUnwrapFailures', recoveryLockoutUntil: 'recoveryLockoutUntil',
        orgWrappedDEK: 'orgWrappedDEK',
        opaqueRecord: 'opaqueRecord', kdfMode: 'kdfMode',
        status: 'status', activeIconPackId: 'activeIconPackId', azureUserId: 'azureUserId', azureTenantId: 'azureTenantId',
        ncUid: 'nc_uid', provider: 'provider', autoProvisioned: 'auto_provisioned',
        // MFA (TOTP) + self-service password reset
        mfaEnabled: 'mfa_enabled', mfaSecret: 'mfa_secret', mfaEnrolledAt: 'mfa_enrolled_at',
        mfaRecoveryCodes: 'mfa_recovery_codes', mfaRecoveryCodesGeneratedAt: 'mfa_recovery_codes_generated_at',
        passwordResetTokenHash: 'password_reset_token_hash', passwordResetExpiresAt: 'password_reset_expires_at',
        // Email verification + locale
        emailVerificationTokenHash: 'email_verification_token_hash', emailVerificationExpiresAt: 'email_verification_expires_at',
        emailVerifiedAt: 'email_verified_at', preferredLocale: 'preferred_locale',
        // Account activity + credential age. Both need an entry here or
        // dynamicUpdate drops the key without a word — the exact way
        // recoveryUnwrapFailures stayed dead code for a year (see the note in
        // schema.js). lastSeenAt is normally written by touchLastSeen below,
        // not through here; the mapping exists so a caller that does reach for
        // updateUser gets a write instead of silence.
        lastSeenAt: 'last_seen_at', passwordChangedAt: 'password_changed_at',
    };

    for (const jsKey of Object.keys(colMap)) {
        if (updates[jsKey] !== undefined) updateMap[jsKey] = updates[jsKey];
    }

    // Special serialization
    if (updates.groups !== undefined) updateMap.groups = JSON.stringify(updates.groups);
    if (updates.wrappedDEK !== undefined) updateMap.wrappedDEK = serializeDek(updates.wrappedDEK);
    if (updates.masterWrappedDEK !== undefined) updateMap.masterWrappedDEK = serializeDek(updates.masterWrappedDEK);
    if (updates.recoveryWrappedDEK !== undefined) updateMap.recoveryWrappedDEK = serializeDek(updates.recoveryWrappedDEK);

    try {
        const fullColMap = { ...colMap, groups: 'groups', wrappedDEK: 'wrappedDEK', masterWrappedDEK: 'masterWrappedDEK', recoveryWrappedDEK: 'recoveryWrappedDEK' };
        const q = dynamicUpdate('users', userId, updateMap, fullColMap);
        if (q) await run(q.sql, q.params);

        // Per-seat plans rebill when the active-user count changes. Creation and
        // deletion already trigger a Stripe seat sync; status transitions
        // (approve a pending user, SSO activation, NC group activate/deactivate)
        // funnel through here, so this is the single chokepoint that keeps
        // billing immediate for those paths too. Only fire when the status
        // actually crosses the active boundary. Fire-and-forget — a Stripe
        // outage must never block the user update; the 15-min drift cron is the
        // backstop. proration_behavior:'create_prorations' charges on increase
        // and credits on decrease.
        if (updates.status !== undefined && existing.organizationId) {
            const wasActive = (existing.status ?? 'active') === 'active';
            const nowActive = (updates.status ?? existing.status ?? 'active') === 'active';
            if (wasActive !== nowActive) {
                Promise.resolve().then(async () => {
                    try {
                        const { syncSeatQuantityForOrg } = require('../../services/stripeService');
                        await syncSeatQuantityForOrg(existing.organizationId);
                    } catch (_) { /* best-effort */ }
                });
            }
        }
        return true;
    } catch (e) { log.error(e); return false; }
}

/**
 * Record that we just saw this account (B15).
 *
 * Deliberately the narrowest possible write: one UPDATE, no read, no branches.
 * updateUser is the wrong tool here — it first does `SELECT * FROM users` and
 * then decides whether to talk to Stripe about seat counts, which is a lot of
 * machinery to hang off the request path for a single timestamp.
 *
 * The throttle that decides WHETHER this runs lives in requireAuth
 * (auth/permissions.js): one write per user per window, so a busy account costs
 * one UPDATE per quarter of an hour rather than one per request. This function
 * only performs the write.
 *
 * NOW() rather than a JS timestamp: with several pods writing the same column,
 * the database clock is the only one they agree on. Errors are swallowed —
 * last-seen is bookkeeping, not a gatekeeper, and nobody should be locked out
 * of the product because their activity clock could not be updated.
 */
async function touchLastSeen(userId) {
    if (!userId) return false;
    try {
        await initDB();
        const { rowCount } = await run('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [userId]);
        return rowCount > 0;
    } catch (_) {
        // Silent on purpose: this sits behind (nearly) every authenticated
        // request, so a database hiccup would turn one incident into a log
        // flood without telling anyone anything the DB errors do not already.
        return false;
    }
}

// ── Atomic seat-cap user creation ─────────────────────────────
// Wraps createUser in a serializable transaction so that two concurrent
// admin-add-user requests cannot both pass a "we have room" check and both
// commit. The cap is computed inside the transaction from the live row
// count + the org's effective max_users + the license seat cap. Throws
// SeatCapExceededError when the cap is hit; the caller maps that to 403.
//
// strict=true (default): throw on cap exceed.
// strict=false: return { created: false, reason: 'seat_cap' } so bulk sync
//   paths (Azure, NC) can log+skip without crashing the batch.
class SeatCapExceededError extends Error {
    constructor(current, max, organizationId) {
        super(`seat_cap_exceeded org=${organizationId} current=${current} max=${max}`);
        this.name = 'SeatCapExceededError';
        this.current = current;
        this.max = max;
        this.organizationId = organizationId;
    }
}

async function createUserWithSeatCheck(userData, { strict = true } = {}) {
    await initDB();
    const orgId = userData.organizationId || '';
    if (!orgId) {
        const ok = await createUser(userData);
        return { created: ok, reason: ok ? null : 'create_failed' };
    }

    let max = null;
    try {
        const limits = await getEffectiveLimits(orgId);
        max = limits?.max_users ?? null;
    } catch (_e) { /* ignore */ }
    try {
        const license = require('../../license');
        const seatCap = typeof license.getMaxSeatsForOrg === 'function'
            ? await license.getMaxSeatsForOrg(orgId)
            : null;
        if (seatCap != null && (max == null || seatCap < max)) max = seatCap;
    } catch (_e) { /* license module optional during early boot */ }

    const insertParams = (() => {
        const mwDek = userData.masterWrappedDEK
            ? (typeof userData.masterWrappedDEK === 'string' ? userData.masterWrappedDEK : JSON.stringify(userData.masterWrappedDEK))
            : null;
        const wDek = userData.wrappedDEK
            ? (typeof userData.wrappedDEK === 'string' ? userData.wrappedDEK : JSON.stringify(userData.wrappedDEK))
            : null;
        return [
            userData.id, userData.username, userData.displayName || userData.username,
            userData.firstName || null, userData.lastName || null, userData.email || null,
            userData.phone || null, userData.avatar || null, userData.avatarType || null,
            userData.passwordHash, userData.role || 'user',
            JSON.stringify(userData.groups || []), mwDek, wDek,
            userData.orgRole || '', orgId,
            new Date().toISOString().split('T')[0], userData.status || 'active',
            userData.azureUserId || null, userData.ncUid || null,
            userData.provider || null, userData.autoProvisioned ? true : false,
            // Same rule as createUser — see the note there.
            isNewCredential(userData) ? new Date() : null, userData.azureTenantId || null,
        ];
    })();

    for (let attempt = 0; attempt < 2; attempt++) {
        const client = await getClient();
        try {
            await client.query('BEGIN');
            await client.query("SET LOCAL TRANSACTION ISOLATION LEVEL SERIALIZABLE");

            if (max != null) {
                // PG rejects FOR UPDATE alongside aggregate functions
                // ("FOR UPDATE is not allowed with aggregate functions"),
                // so we count rows under SERIALIZABLE isolation instead.
                // Concurrent INSERTs that would push us over the cap raise
                // a 40001 serialization failure on COMMIT, which the
                // attempt-retry below already handles.
                const countRow = await client.query(
                    `SELECT COUNT(*)::int AS n FROM users WHERE "organizationId" = $1 AND COALESCE(status, 'active') = 'active'`,
                    [orgId]
                );
                const current = countRow.rows[0]?.n ?? 0;
                if (current >= max) {
                    await client.query('ROLLBACK');
                    client.release();
                    log.warn(`[seat.cap] ${strict ? 'blocked' : 'skipped'} org=${orgId} current=${current} max=${max}`);
                    if (strict) throw new SeatCapExceededError(current, max, orgId);
                    return { created: false, reason: 'seat_cap', current, max };
                }
            }

            const existing = await client.query('SELECT id FROM users WHERE id = $1', [userData.id]);
            if (existing.rowCount > 0) {
                await client.query('ROLLBACK');
                client.release();
                return { created: false, reason: 'duplicate_id' };
            }

            await client.query(
                `INSERT INTO users (id, username, "displayName", "firstName", "lastName", email, phone, avatar, "avatarType", "passwordHash", role, groups, "masterWrappedDEK", "wrappedDEK", "orgRole", "organizationId", "createdAt", status, "azureUserId", "nc_uid", "provider", "auto_provisioned", password_changed_at, "azureTenantId")
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
                insertParams
            );
            await client.query('COMMIT');
            client.release();
            // Fire-and-forget Stripe seat-quantity sync. Per-seat plans rebill
            // when the active user count changes; we don't await so a Stripe
            // outage can't block user creation. The webhook will reconcile
            // stripe_seat_quantity once the update is processed.
            if (orgId) {
                Promise.resolve().then(async () => {
                    try {
                        const { syncSeatQuantityForOrg } = require('../../services/stripeService');
                        await syncSeatQuantityForOrg(orgId);
                    } catch (_) { /* best-effort */ }
                });
            }
            return { created: true, reason: null };
        } catch (e) {
            try { await client.query('ROLLBACK'); } catch (_) { }
            client.release();
            if (e && e.code === '40001' && attempt < 1) continue;
            if (e instanceof SeatCapExceededError) throw e;
            log.error('[UserStore] createUserWithSeatCheck error:', e.message);
            return { created: false, reason: 'create_failed', error: e.message };
        }
    }
    return { created: false, reason: 'create_failed' };
}

module.exports = {
    getAllUsers, getAllUserAvatars, getUserAvatarsByIds, getOrgMembersForDirectory,
    getUser, getUserByEmail, getUserByPasswordResetToken, getUserByEmailVerificationToken,
    createUser, updateUser, deleteUser, eraseSuggestionTraces, getUserByNcUid, findOrgMemberIdByEmail,
    stagesRunBy, assertNotStageRunAs,
    createUserWithSeatCheck, SeatCapExceededError,
    touchLastSeen, isNewCredential,
};
