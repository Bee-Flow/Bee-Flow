// @typecheck
/**
 * content_pii_signals — does a piece of project content hold personal data,
 * as far as the last background scan could tell? One row per subject.
 *
 * Written by core/dlp/contentSignals.js after a version checkpoint of a studio
 * document or a notebook (never on keystrokes, never inside a save); read by
 * the Compliance Center's project checks, which must answer "which projects
 * hold personal data" WITHOUT opening any content during a sweep.
 *
 * WHAT IS STORED — and what never is. Per subject: the canonical category ids
 * with a count each, the personal-data kinds they map to (name, email,
 * health, id_number, …), the total number of mentions, the version the scan
 * read, and whether the scan was DEGRADED. No text, no offsets, no values,
 * no hashes of values: nothing here can be turned back into what was found.
 *
 * DEGRADED means "we could not tell" — the guard was unavailable, a segment
 * could not be scanned. It is stored as such and read as UNKNOWN by every
 * consumer, never as clean.
 *
 * Built by a factory over a `{ query }` handle so the pglite test runs the
 * store's own SQL without module mocking; the default instance wraps the pool.
 */

'use strict';

const { exec, pool } = require('../db');
const { makeStoreInit } = require('./lib/storeInit');
const log = require('../telemetry/log');

/** The kinds of content a signal can be about. */
const SUBJECT_KINDS = Object.freeze(['studio_document', 'notebook_document', 'project_chat']);

const DDL = `
    CREATE TABLE IF NOT EXISTS content_pii_signals (
        organization_id TEXT NOT NULL,
        project_id      TEXT,
        subject_kind    TEXT NOT NULL
                        CHECK (subject_kind IN ('studio_document', 'notebook_document', 'project_chat')),
        subject_id      TEXT NOT NULL,
        version_id      TEXT,
        categories      JSONB NOT NULL DEFAULT '{}'::jsonb,
        kinds           TEXT[] NOT NULL DEFAULT '{}',
        mention_count   INTEGER NOT NULL DEFAULT 0,
        degraded        BOOLEAN NOT NULL DEFAULT false,
        scanned_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (subject_kind, subject_id)
    );
    CREATE INDEX IF NOT EXISTS idx_content_pii_signals_org_project
        ON content_pii_signals(organization_id, project_id);
`;

function _toRow(r) {
    if (!r) return null;
    let categories = r.categories;
    if (typeof categories === 'string') { try { categories = JSON.parse(categories); } catch { categories = {}; } }
    return {
        organizationId: r.organization_id,
        projectId: r.project_id ?? null,
        subjectKind: r.subject_kind,
        subjectId: r.subject_id,
        versionId: r.version_id ?? null,
        categories: categories && typeof categories === 'object' ? categories : {},
        kinds: Array.isArray(r.kinds) ? r.kinds : [],
        mentionCount: Number(r.mention_count) || 0,
        degraded: !!r.degraded,
        scannedAt: r.scanned_at ? new Date(r.scanned_at).toISOString() : null,
    };
}

/**
 * @param {{ query: (sql: string, params?: any[]) => Promise<{rows: any[], rowCount?: number}> }} db
 * @param {{ ready?: () => Promise<unknown> }} [opts]
 */
function makeContentPiiSignalStore(db, { ready = async () => {} } = {}) {
    const q = async (sql, params) => { await ready(); return db.query(sql, params); };

    /**
     * Record the outcome of one scan (replaces the subject's previous row).
     * @param {{ organizationId: string, projectId?: string|null, subjectKind: string, subjectId: string,
     *           versionId?: string|null, categories?: Record<string, number>, kinds?: string[],
     *           mentionCount?: number, degraded?: boolean }} s
     */
    async function upsertSignal(s) {
        if (!SUBJECT_KINDS.includes(s.subjectKind)) throw new Error(`Unknown subject kind: ${s.subjectKind}`);
        const categories = {};
        for (const [k, v] of Object.entries(s.categories || {})) {
            const n = Math.trunc(Number(v));
            if (k && Number.isFinite(n) && n > 0) categories[k] = n;
        }
        const { rows } = await q(`
            INSERT INTO content_pii_signals
                (organization_id, project_id, subject_kind, subject_id, version_id, categories, kinds, mention_count, degraded, scanned_at)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::text[], $8, $9, NOW())
            ON CONFLICT (subject_kind, subject_id) DO UPDATE SET
                organization_id = EXCLUDED.organization_id,
                project_id = EXCLUDED.project_id,
                version_id = EXCLUDED.version_id,
                categories = EXCLUDED.categories,
                kinds = EXCLUDED.kinds,
                mention_count = EXCLUDED.mention_count,
                degraded = EXCLUDED.degraded,
                scanned_at = NOW()
            RETURNING *
        `, [
            String(s.organizationId), s.projectId == null ? null : String(s.projectId), s.subjectKind, String(s.subjectId),
            s.versionId == null ? null : String(s.versionId), JSON.stringify(categories),
            [...new Set((s.kinds || []).map(String))], Math.max(0, Math.trunc(Number(s.mentionCount) || 0)), !!s.degraded,
        ]);
        return _toRow(rows[0]);
    }

    async function getSignal(subjectKind, subjectId) {
        const { rows } = await q(
            `SELECT * FROM content_pii_signals WHERE subject_kind = $1 AND subject_id = $2`,
            [subjectKind, String(subjectId)],
        );
        return _toRow(rows[0]);
    }

    /** Every signal of an org's projects (bounded). */
    async function listForOrg(organizationId, { limit = 5000 } = {}) {
        const { rows } = await q(`
            SELECT * FROM content_pii_signals
            WHERE organization_id = $1
            ORDER BY scanned_at DESC
            LIMIT $2
        `, [String(organizationId), Math.max(1, Math.min(20000, Math.trunc(Number(limit) || 5000)))]);
        return rows.map(_toRow);
    }

    /** Forget a subject (its content was deleted). */
    async function deleteSignal(subjectKind, subjectId) {
        const r = await q(`DELETE FROM content_pii_signals WHERE subject_kind = $1 AND subject_id = $2`, [subjectKind, String(subjectId)]);
        return (r.rowCount || 0) > 0;
    }

    return { upsertSignal, getSignal, listForOrg, deleteSignal };
}

const initDB = makeStoreInit('ContentPiiSignalStore', async () => {
    await exec(DDL);
    log.info('[ContentPiiSignalStore] PostgreSQL initialized');
});

const defaultStore = makeContentPiiSignalStore({ query: (sql, params) => pool.query(sql, params) }, { ready: initDB });

module.exports = {
    initDB,
    DDL,
    SUBJECT_KINDS,
    makeContentPiiSignalStore,
    ...defaultStore,
};
