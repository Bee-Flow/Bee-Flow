// @typecheck
/**
 * ISMS Document Store — org-scoped policy documents with versioning and an
 * acknowledgement ledger (ISO 27001 clause 7.5 controlled documents, A.5.1
 * policies, clause 7.3 awareness).
 *
 * Semantics mirror the platform legal-doc stack (versioned sha256'd bodies +
 * per-user acceptance ledger) but live per organisation: each org owns and
 * edits its documents. Drafts live on the document row; publishing freezes an
 * immutable version row (sha256 over the body) that acknowledgements bind to.
 *
 * The `edited` flag tracks whether the org actually changed the seeded
 * template — auditors spot unedited templates instantly, so the UI nudges
 * until real editing happened.
 */

const crypto = require('crypto');
const { run, getOne, getAll, exec } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');

const initDB = makeStoreInit('IsmsDocStore', _initDB);

async function _initDB() {
    await exec(`
        CREATE TABLE IF NOT EXISTS isms_documents (
            organization_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            title TEXT NOT NULL,
            draft_body TEXT,
            current_version INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'draft',
            owner_user_id TEXT,
            review_due_at TIMESTAMPTZ,
            controls JSONB DEFAULT '[]'::jsonb,
            seeded_from TEXT,
            edited BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (organization_id, slug)
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS isms_document_versions (
            id SERIAL PRIMARY KEY,
            organization_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            version INTEGER NOT NULL,
            title TEXT NOT NULL,
            body TEXT NOT NULL,
            sha256 TEXT NOT NULL,
            published_by TEXT,
            published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (organization_id, slug, version)
        )
    `);
    await exec(`
        CREATE TABLE IF NOT EXISTS isms_acknowledgements (
            organization_id TEXT NOT NULL,
            slug TEXT NOT NULL,
            version INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            ip TEXT,
            user_agent TEXT,
            PRIMARY KEY (organization_id, slug, version, user_id)
        )
    `);
    await exec(`CREATE INDEX IF NOT EXISTS idx_isms_ack_user ON isms_acknowledgements(organization_id, user_id)`);
}

function sha256For(body) {
    return crypto.createHash('sha256').update(String(body || ''), 'utf8').digest('hex');
}

async function listDocs(orgId) {
    await initDB();
    return getAll(`
        SELECT d.*,
               (SELECT COUNT(*)::int FROM isms_acknowledgements a
                 WHERE a.organization_id = d.organization_id
                   AND a.slug = d.slug AND a.version = d.current_version) AS ack_count
        FROM isms_documents d
        WHERE d.organization_id = $1
        ORDER BY d.slug
    `, [orgId]);
}

async function getDoc(orgId, slug) {
    await initDB();
    const doc = await getOne(`
        SELECT * FROM isms_documents
        WHERE organization_id = $1 AND slug = $2
    `, [orgId, slug]);
    if (!doc) return null;
    let published = null;
    if (doc.current_version > 0) {
        published = await getOne(`
            SELECT version, title, body, sha256, published_by, published_at
            FROM isms_document_versions
            WHERE organization_id = $1 AND slug = $2 AND version = $3
        `, [orgId, slug, doc.current_version]);
    }
    return { ...doc, published };
}

/** Save the working draft. Marks `edited` once the body diverges from the seed. */
async function saveDraft(orgId, slug, { title, body }, actorId, { seedBody = null } = {}) {
    await initDB();
    const existing = await getOne(`SELECT * FROM isms_documents WHERE organization_id = $1 AND slug = $2`, [orgId, slug]);
    if (!existing) return null;
    const nextTitle = title !== undefined ? String(title || existing.title) : existing.title;
    const nextBody = body !== undefined ? String(body ?? '') : (existing.draft_body || '');
    const edited = existing.edited || (seedBody !== null && nextBody.trim() !== String(seedBody).trim());
    await run(`
        UPDATE isms_documents
        SET title = $3, draft_body = $4, edited = $5, updated_at = NOW()
        WHERE organization_id = $1 AND slug = $2
    `, [orgId, slug, nextTitle, nextBody, edited]);
    return getDoc(orgId, slug);
}

/**
 * Owner and review date. A key that is ABSENT keeps the stored value; a key
 * that is explicitly `null` clears the column. COALESCE could not tell those
 * apart, so the policy drawer — which sends `owner_user_id: null` to unassign
 * — answered 200 with the old owner still on the document, and clause 5 of
 * the conformity statement kept reading it as owned.
 */
async function setMeta(orgId, slug, patch = {}) {
    await initDB();
    const params = [orgId, slug];
    const sets = [];
    for (const col of ['owner_user_id', 'review_due_at']) {
        if (patch[col] === undefined) continue;
        params.push(patch[col] ?? null);
        sets.push(`${col} = $${params.length}`);
    }
    if (!sets.length) return getDoc(orgId, slug);
    await run(`
        UPDATE isms_documents
        SET ${sets.join(', ')}, updated_at = NOW()
        WHERE organization_id = $1 AND slug = $2
    `, params);
    return getDoc(orgId, slug);
}

/** Freeze the current draft as the next immutable published version. */
async function publish(orgId, slug, actorId) {
    await initDB();
    const doc = await getOne(`SELECT * FROM isms_documents WHERE organization_id = $1 AND slug = $2`, [orgId, slug]);
    if (!doc) return null;
    const body = doc.draft_body || '';
    if (!body.trim()) throw new Error('Cannot publish an empty document');
    const version = (doc.current_version || 0) + 1;
    const hash = sha256For(body);
    await run(`
        INSERT INTO isms_document_versions
            (organization_id, slug, version, title, body, sha256, published_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
    `, [orgId, slug, version, doc.title, body, hash, actorId || null]);
    await run(`
        UPDATE isms_documents
        SET current_version = $3, status = 'published', updated_at = NOW()
        WHERE organization_id = $1 AND slug = $2
    `, [orgId, slug, version]);
    return { ...(await getDoc(orgId, slug)), published_hash: hash };
}

/** Insert missing seed documents only — an org's own docs are never touched. */
async function seedMissing(orgId, seeds) {
    await initDB();
    let inserted = 0;
    for (const s of seeds || []) {
        if (!s?.slug || !s?.title) continue;
        const r = await run(`
            INSERT INTO isms_documents
                (organization_id, slug, title, draft_body, controls, seeded_from, status)
            VALUES ($1, $2, $3, $4, $5::jsonb, $2, 'draft')
            ON CONFLICT (organization_id, slug) DO NOTHING
        `, [orgId, s.slug, s.title, s.body || '', JSON.stringify(s.controls || [])]);
        if (r?.rowCount) inserted += r.rowCount;
    }
    return inserted;
}

/**
 * @param orgId
 * @param slug
 * @param version
 * @param userId
 * @param {{ ip?: string, userAgent?: string }} [opts]
 */
async function acknowledge(orgId, slug, version, userId, { ip, userAgent } = {}) {
    await initDB();
    await run(`
        INSERT INTO isms_acknowledgements
            (organization_id, slug, version, user_id, ip, user_agent)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (organization_id, slug, version, user_id) DO NOTHING
    `, [orgId, slug, version, userId, ip || null, userAgent || null]);
}

/** Published docs + this user's ack status — the member-facing read. */
async function listPublishedForUser(orgId, userId) {
    await initDB();
    return getAll(`
        SELECT d.slug, d.title, d.current_version, d.updated_at,
               (a.user_id IS NOT NULL) AS acknowledged,
               a.acknowledged_at
        FROM isms_documents d
        LEFT JOIN isms_acknowledgements a
            ON a.organization_id = d.organization_id AND a.slug = d.slug
           AND a.version = d.current_version AND a.user_id = $2
        WHERE d.organization_id = $1 AND d.status = 'published' AND d.current_version > 0
        ORDER BY d.slug
    `, [orgId, userId]);
}

async function getPublishedBody(orgId, slug) {
    await initDB();
    const doc = await getOne(`SELECT current_version FROM isms_documents WHERE organization_id = $1 AND slug = $2 AND status = 'published'`, [orgId, slug]);
    if (!doc?.current_version) return null;
    return getOne(`
        SELECT version, title, body, sha256, published_at
        FROM isms_document_versions
        WHERE organization_id = $1 AND slug = $2 AND version = $3
    `, [orgId, slug, doc.current_version]);
}

module.exports = {
    initDB,
    sha256For,
    listDocs,
    getDoc,
    saveDraft,
    setMeta,
    publish,
    seedMissing,
    acknowledge,
    listPublishedForUser,
    getPublishedBody,
};
