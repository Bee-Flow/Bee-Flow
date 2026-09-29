// @typecheck
/**
 * forms.js — automationStore aggregate for the `form` trigger.
 *
 * A form page's `id` IS its public URL token AND its only credential, exactly
 * like automation_webhooks.id: 192 bits of entropy, stored as-is, looked up by
 * exact match. That is a deliberate choice (agreed with the owner): the URL is
 * meant to be pasted into a website, an email or a QR code, so it has to be
 * reproducible for the author. Rotating = replace the row; the old link 404s
 * immediately.
 *
 * The upload ledger is quarantine-first (studioAppFiles pattern): a row exists
 * only after a clean scan, and an upload that never reaches a submission
 * expires.
 */

const crypto = require('crypto');
const { initDB, run, getOne, getAll } = require('./core');

// How long an uploaded file may sit unclaimed before it is reaped. Long enough
// to fill in the rest of a long form, short enough that abandoned bytes do not
// accumulate.
const UPLOAD_TTL_MS = 6 * 60 * 60 * 1000;

const { AUDIENCES } = require('../../automation/formAudience');

function idList(value) {
    let arr = value;
    if (typeof value === 'string') {
        try { arr = JSON.parse(value || '[]'); } catch (_) { arr = []; }
    }
    if (!Array.isArray(arr)) return [];
    return Array.from(new Set(arr.filter(v => typeof v === 'string' && v)));
}

function rowToPage(r) {
    if (!r) return null;
    return {
        id: r.id,
        automationId: r.automation_id,
        triggerStepId: r.trigger_step_id ?? null,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at ?? null,
        submissions: Number(r.submissions || 0),
        // Who may fill it in (automation-form-audience-2026-09). A row from
        // before the column reads as 'org' — the rule it was made under.
        audience: AUDIENCES.includes(r.audience) ? r.audience : 'org',
        sharedGroups: idList(r.shared_groups),
        sharedUserIds: idList(r.shared_user_ids),
    };
}

/**
 * A NEW page is the owner's until they share it: 'restricted' with nobody
 * on it. The column's own default is 'org', for the rows that predate it.
 */
async function createFormPage(automationId, triggerStepId = null, { audience = 'restricted', sharedGroups = [], sharedUserIds = [] } = {}) {
    await initDB();
    const id = crypto.randomBytes(24).toString('hex');
    const mode = AUDIENCES.includes(audience) ? audience : 'restricted';
    await run(
        `INSERT INTO automation_form_pages (id, automation_id, trigger_step_id, audience, shared_groups, shared_user_ids)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [id, automationId, triggerStepId, mode, JSON.stringify(idList(sharedGroups)), JSON.stringify(idList(sharedUserIds))],
    );
    return { id, automationId, triggerStepId, submissions: 0, audience: mode, sharedGroups: idList(sharedGroups), sharedUserIds: idList(sharedUserIds) };
}

/**
 * Who may fill the form in. Owner-scoped by `automationId` like every other
 * write on a page row. Returns the updated page, or null when the row is
 * not this routine's.
 */
async function setFormPageAudience(id, automationId, { audience, sharedGroups, sharedUserIds }) {
    await initDB();
    const mode = AUDIENCES.includes(audience) ? audience : 'restricted';
    const row = await getOne(
        `UPDATE automation_form_pages
            SET audience = $3, shared_groups = $4::jsonb, shared_user_ids = $5::jsonb
          WHERE id = $1 AND automation_id = $2
      RETURNING *`,
        [id, automationId, mode, JSON.stringify(idList(sharedGroups)), JSON.stringify(idList(sharedUserIds))],
    );
    return rowToPage(row);
}

async function getFormPage(id) {
    await initDB();
    // Exact match on the PK: no LIKE, no prefix search, so a partial token is
    // never a partial match.
    return rowToPage(await getOne('SELECT * FROM automation_form_pages WHERE id = $1', [id]));
}

async function getFormPagesForAutomation(automationId) {
    await initDB();
    const rows = await getAll('SELECT * FROM automation_form_pages WHERE automation_id = $1 ORDER BY created_at', [automationId]);
    return rows.map(rowToPage);
}

/** Bump the counters after an accepted submission (best-effort, never blocks). */
async function touchFormPage(id) {
    await initDB();
    await run(`UPDATE automation_form_pages SET last_seen_at = NOW(), submissions = submissions + 1 WHERE id = $1`, [id]);
}

async function deleteFormPage(id, automationId) {
    await initDB();
    const { rowCount } = await run(`DELETE FROM automation_form_pages WHERE id = $1 AND automation_id = $2`, [id, automationId]);
    return rowCount > 0;
}

/**
 * Every published form in one organisation, newest first.
 *
 * A published form has a public URL, which makes it an organisation's asset
 * rather than its author's — a colleague who is away should not take the only
 * way of finding the form with them. So this is deliberately org-scoped, unlike
 * getAutomationsForUser, which filters by user_id.
 *
 * The automation's own columns ride along because every consumer needs them:
 * the title to show, and isActive/isDraft because a page whose routine is
 * either of those 404s for visitors (see formPublic.js's loadForm) and has to
 * read as "not live" rather than as a working link. The definition comes too —
 * the row survives the author switching the trigger to something else, and the
 * caller drops those the same way loadForm does.
 */
async function listFormPagesForOrg(organizationId, userId) {
    await initDB();
    // Scoped through COALESCE(the routine's own organisation, the OWNER's), and
    // the COALESCE is load-bearing in BOTH directions now.
    //
    // When this was written nothing ever wrote automations.organization_id, so
    // the owner's column was the only answer. Since then the create and import
    // routes DO stamp it (routes/automation/crud.js — `const organizationId =
    // await orgOf(req)`), which is why the second half matters: rows created
    // before that change still have it NULL, and a query narrowed to
    // `a.organization_id = $1` would drop every one of them without saying so.
    // A directory that silently loses the organisation's oldest forms is worse
    // than one that errors. Any new org-wide read over `automations` copies
    // this JOIN rather than simplifying it.
    //
    // A caller with no organisation sees only their OWN forms. Matching "no org
    // to no org" would put every orgless user on a shared install into one
    // bucket and show them each other's links.
    const scoped = organizationId
        ? {
            where: 'COALESCE(a.organization_id, u."organizationId") = $1',
            params: [organizationId],
        }
        : { where: 'a.user_id = $1', params: [userId] };
    const rows = await getAll(
        `SELECT p.*, a.title, a.description, a.is_active, a.is_draft, a.user_id, a.definition_json,
                a.live_definition_json, a.live_version
           FROM automation_form_pages p
           JOIN automations a ON a.id = p.automation_id
           JOIN users u ON u.id = a.user_id
          WHERE ${scoped.where}
            AND a.deleted_at IS NULL
          ORDER BY p.created_at DESC`,
        scoped.params,
    );
    return rows.map(r => ({
        ...rowToPage(r),
        title: r.title || null,
        description: r.description || null,
        isActive: !!r.is_active,
        isDraft: !!r.is_draft,
        userId: r.user_id,
        // The WORKING copy: the Form page's Questions tab saves it back
        // through PUT /:id. What visitors are served is the live copy.
        definition: r.definition_json || null,
        // Handoff 5: the definition visitors get (null while never live, when
        // the working copy is also the one that runs).
        liveDefinition: r.live_definition_json || null,
        liveVersion: r.live_version ?? null,
    }));
}

/**
 * Who a form belongs to: its owner, and their organisation.
 *
 * Used to decide whether a signed-in caller may open it now that forms are not
 * public. Same scoping rule as listFormPagesForOrg, and the same COALESCE for
 * the same reason (see the note there): the routine's own organisation when it
 * has one, the OWNER's for every row created before that column started being
 * written. Returns null for an unknown token, which the caller answers as 404.
 */
async function formPageAudience(id) {
    await initDB();
    const row = await getOne(
        `SELECT a.user_id, COALESCE(a.organization_id, u."organizationId") AS organization_id,
                p.audience, p.shared_groups, p.shared_user_ids
           FROM automation_form_pages p
           JOIN automations a ON a.id = p.automation_id
           JOIN users u ON u.id = a.user_id
          WHERE p.id = $1`,
        [id],
    );
    if (!row) return null;
    return {
        userId: row.user_id,
        organizationId: row.organization_id || null,
        audience: AUDIENCES.includes(row.audience) ? row.audience : 'org',
        sharedGroups: idList(row.shared_groups),
        sharedUserIds: idList(row.shared_user_ids),
    };
}


/**
 * The page for a form trigger, made if it is not there yet.
 *
 * A `form` trigger's whole purpose is a public page, so the page exists for as
 * long as the trigger does. This used to be provisioned lazily by the builder
 * panel that displayed the link — which meant the form was published as a side
 * effect of an author happening to open that panel, and stopped being published
 * at all once the panel was hidden.
 *
 * Minting early costs nothing: loadForm 404s while the routine is a draft or
 * inactive, so a token without a live routine opens nothing.
 */
async function ensureFormPage(automationId, triggerStepId = null) {
    await initDB();
    const existing = await getOne(
        `SELECT * FROM automation_form_pages
          WHERE automation_id = $1 AND trigger_step_id IS NOT DISTINCT FROM $2`,
        [automationId, triggerStepId],
    );
    if (existing) return rowToPage(existing);
    return createFormPage(automationId, triggerStepId);
}

/**
 * Replace a form page with a fresh token, keeping its trigger binding. The old
 * URL stops working the instant this returns — the URL *is* the credential, so
 * there is nothing else to rotate.
 */
async function rotateFormPage(id, automationId) {
    await initDB();
    const existing = await getOne('SELECT * FROM automation_form_pages WHERE id = $1 AND automation_id = $2', [id, automationId]);
    if (!existing) return null;
    await run(`DELETE FROM automation_form_pages WHERE id = $1`, [id]);
    // A new token, the same audience: rotating the link is not un-sharing.
    const prev = rowToPage(existing);
    return createFormPage(automationId, existing.trigger_step_id ?? null, {
        audience: prev.audience, sharedGroups: prev.sharedGroups, sharedUserIds: prev.sharedUserIds,
    });
}

// ── Upload ledger ─────────────────────────────────────

function rowToUpload(r) {
    if (!r) return null;
    return {
        id: r.id,
        formPageId: r.form_page_id,
        storageKey: r.storage_key,
        filename: r.filename,
        mimeType: r.mime_type,
        size: Number(r.size_bytes || 0),
        scanned: !!r.scanned,
        createdAt: r.created_at,
        expiresAt: r.expires_at ?? null,
        claimedAt: r.claimed_at ?? null,
    };
}

/** Only called AFTER a clean scan — an unscanned blob never gets a row. */
async function recordFormUpload(formPageId, { storageKey, filename, mimeType, size }) {
    await initDB();
    const id = crypto.randomBytes(18).toString('hex');
    await run(
        `INSERT INTO automation_form_uploads (id, form_page_id, storage_key, filename, mime_type, size_bytes, scanned, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, TRUE, NOW() + ($7::bigint * INTERVAL '1 millisecond'))`,
        [id, formPageId, storageKey, filename, mimeType, size, UPLOAD_TTL_MS],
    );
    return { id, formPageId, storageKey, filename, mimeType, size };
}

async function getFormUpload(id, formPageId) {
    await initDB();
    // Scoped to the page: a token for form A can never claim a file uploaded
    // through form B.
    return rowToUpload(await getOne('SELECT * FROM automation_form_uploads WHERE id = $1 AND form_page_id = $2', [id, formPageId]));
}

/**
 * Claim an upload for a submission. Returns the row only if this call was the
 * one that claimed it — a replayed submission cannot re-attach the same file.
 */
async function claimFormUpload(id, formPageId) {
    await initDB();
    const { rowCount } = await run(
        `UPDATE automation_form_uploads SET claimed_at = NOW(), expires_at = NULL
          WHERE id = $1 AND form_page_id = $2 AND claimed_at IS NULL`,
        [id, formPageId],
    );
    if (rowCount === 0) return null;
    return getFormUpload(id, formPageId);
}

/** Bytes + count uploaded through one form inside a window — the anonymous quota. */
async function formUploadUsage(formPageId, windowMs) {
    await initDB();
    const r = await getOne(
        `SELECT COUNT(*)::int AS files, COALESCE(SUM(size_bytes), 0)::bigint AS bytes
           FROM automation_form_uploads
          WHERE form_page_id = $1 AND created_at > NOW() - ($2::bigint * INTERVAL '1 millisecond')`,
        [formPageId, windowMs],
    );
    return { files: Number(r?.files || 0), bytes: Number(r?.bytes || 0) };
}

/** Expired, never-claimed uploads — the caller deletes the blobs, then the rows. */
async function listExpiredFormUploads(limit = 200) {
    await initDB();
    const rows = await getAll(
        `SELECT * FROM automation_form_uploads
          WHERE claimed_at IS NULL AND expires_at IS NOT NULL AND expires_at < NOW()
          ORDER BY expires_at LIMIT $1`,
        [limit],
    );
    return rows.map(rowToUpload);
}

async function deleteFormUploads(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    await initDB();
    const { rowCount } = await run(`DELETE FROM automation_form_uploads WHERE id = ANY($1::text[])`, [ids]);
    return rowCount;
}

// ── Visitor sessions (multi-page forms) ───────────────
//
// One row per visitor journey through a form. The id is the polling credential
// the browser holds; `run_id` follows the run chain, because resuming a paused
// run produces a CHILD run. There is deliberately no status column — the poll
// endpoint derives the visitor's state from the run row, so there is no second
// copy of the truth.

// How long a visitor's journey may stay open. The run's own
// awaiting_step_expires_at is the authority for the PAUSE; this is the outer
// bound on the session pointer itself, refreshed on every poll.
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function rowToSession(r) {
    if (!r) return null;
    return {
        id: r.id,
        formPageId: r.form_page_id,
        automationId: r.automation_id,
        runId: r.run_id ?? null,
        rootStepId: r.root_step_id ?? null,
        triggerHeaders: r.trigger_headers ?? null,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        expiresAt: r.expires_at,
    };
}

async function createFormSession(formPageId, automationId, { rootStepId = null, triggerHeaders = null } = {}) {
    await initDB();
    const id = crypto.randomBytes(24).toString('hex');
    await run(
        `INSERT INTO automation_form_sessions (id, form_page_id, automation_id, root_step_id, trigger_headers, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6::bigint * INTERVAL '1 millisecond'))`,
        [id, formPageId, automationId, rootStepId, triggerHeaders ? JSON.stringify(triggerHeaders) : null, SESSION_TTL_MS],
    );
    return { id, formPageId, automationId, rootStepId, triggerHeaders, runId: null };
}

async function getFormSession(id, formPageId) {
    await initDB();
    // Scoped to the page for the same reason uploads are: a session minted on
    // form A must be meaningless against form B's token.
    return rowToSession(await getOne(
        `SELECT * FROM automation_form_sessions WHERE id = $1 AND form_page_id = $2`, [id, formPageId],
    ));
}

/** Point the session at the run that is now carrying it (the newest child). */
async function attachFormSessionRun(id, runId) {
    await initDB();
    await run(
        `UPDATE automation_form_sessions SET run_id = $2, updated_at = NOW(),
                expires_at = NOW() + ($3::bigint * INTERVAL '1 millisecond')
          WHERE id = $1`,
        [id, runId, SESSION_TTL_MS],
    );
}

/** Keep a session the visitor is actively polling from ageing out under them. */
async function touchFormSession(id) {
    await initDB();
    await run(
        `UPDATE automation_form_sessions SET updated_at = NOW(),
                expires_at = NOW() + ($2::bigint * INTERVAL '1 millisecond')
          WHERE id = $1`,
        [id, SESSION_TTL_MS],
    );
}

async function deleteExpiredFormSessions(limit = 500) {
    await initDB();
    const { rowCount } = await run(
        `DELETE FROM automation_form_sessions
          WHERE id IN (SELECT id FROM automation_form_sessions WHERE expires_at < NOW() ORDER BY expires_at LIMIT $1)`,
        [limit],
    );
    return rowCount || 0;
}

module.exports = {
    UPLOAD_TTL_MS,
    SESSION_TTL_MS,
    createFormSession,
    getFormSession,
    attachFormSessionRun,
    touchFormSession,
    deleteExpiredFormSessions,
    createFormPage,
    getFormPage,
    getFormPagesForAutomation,
    listFormPagesForOrg,
    formPageAudience,
    setFormPageAudience,
    ensureFormPage,
    touchFormPage,
    deleteFormPage,
    rotateFormPage,
    recordFormUpload,
    getFormUpload,
    claimFormUpload,
    formUploadUsage,
    listExpiredFormUploads,
    deleteFormUploads,
};
