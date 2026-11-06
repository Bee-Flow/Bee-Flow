/**
 * stores/kb/queryLog: the KB query log (one row per search per knowledge base that logs).
 *
 * Content (query, passages, answer, citations, review note) is sealed by
 * core/kb/queryLog/crypto.mts before it reaches the database and opened after it leaves.
 * Metadata (time, user, channel, outcome, status, counts) stays in the clear so SQL can filter.
 * A decrypt failure of one field never fails a list: that field comes back null and the row
 * carries `decryptFailed: true`.
 *
 * The store is a factory over a `{ query }` handle (the pool in production, PGlite in tests);
 * the module also exports the functions bound to the real pool.
 */

import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import {
    ANSWER_CAP, CHUNK_TEXT_CAP, DEFAULT_RETENTION_DAYS, QUERY_CAP, cap,
    type ReviewStatus,
} from '../../../core/kb/queryLog/vocab.mts';
import { makeAckFns } from './acks.mts';
import { makeSettingsFns } from './settings.mts';
import * as realCrypto from '../../../core/kb/queryLog/crypto.mts';

const nodeRequire = createRequire(import.meta.url);

import type { Db, CryptoApi, LogChunk, InsertRow, FinishPatch, ListFilter, EntryRow, QueryLogSettings, SettingsPatch } from './types.mts';
export type { Db, CryptoApi, LogChunk, InsertRow, FinishPatch, ListFilter, EntryRow, QueryLogSettings, SettingsPatch } from './types.mts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The in-memory text filter looks at no more than this many rows. */
export const TEXT_FILTER_ROW_CAP = 5000;
const MAX_PAGE = 500;
const EXPORT_BATCH = 500;
// Columns of a read that does not need the passages or the citations.
const META_COLS = 'id, search_group_id, organization_id, kb_id, user_id, channel, channel_ref, created_at, chunk_count, top_score, retrieval_ms, model, answer_ms, outcome, error_code, answered_at, review_status, reviewed_by, reviewed_at, expires_at';
const MATCH_COLS = `${META_COLS}, query_enc, answer_enc`;
const EXPORT_COLS = `${MATCH_COLS}, review_note_enc`;
const DELETE_BATCH_DEFAULT = 1000;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v ? new Date(String(v)).toISOString() : null);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const expiry = (from: Date, days: number): Date => new Date(from.getTime() + days * 86_400_000);

function parseJson<T>(text: string | null, fallback: T): T {
    if (!text) return fallback;
    try { return JSON.parse(text) as T; } catch { return fallback; }
}

function cleanChunk(c: LogChunk): LogChunk {
    return {
        chunkId: c.chunkId ?? null, documentId: c.documentId ?? null, documentVersionId: c.documentVersionId ?? null,
        documentVersion: c.documentVersion ?? null,
        sourceUri: c.sourceUri ?? null, title: c.title ?? null,
        score: typeof c.score === 'number' && Number.isFinite(c.score) ? c.score : null,
        page: typeof c.page === 'number' && Number.isFinite(c.page) ? c.page : null,
        text: cap(c.text, CHUNK_TEXT_CAP),
    };
}

export function makeKbQueryLogStore(db: Db, crypto: CryptoApi = realCrypto, clock: () => Date = () => new Date()) {
    async function getLoggingKbs(kbIds: string[]): Promise<Array<{ id: string; organizationId: string | null; retentionDays: number }>> {
        const ids = [...new Set((kbIds || []).filter((id) => typeof id === 'string' && UUID_RE.test(id)))];
        if (ids.length === 0) return [];
        const { rows } = await db.query(
            `SELECT id, organization_id, query_log_retention_days FROM knowledge_bases WHERE id = ANY($1::uuid[]) AND query_log_enabled = true`, [ids]);
        return rows.map((r) => ({ id: String(r.id), organizationId: r.organization_id ?? null, retentionDays: Number(r.query_log_retention_days) || DEFAULT_RETENTION_DAYS }));
    }

    /** Which of `kbIds` each document belongs to: Map(documentId -> kbId). Unknown or foreign documents are absent. */
    async function kbIdsForDocuments(documentIds: string[], kbIds: string[]): Promise<Map<string, string>> {
        const docs = [...new Set((documentIds || []).filter((id) => typeof id === 'string' && UUID_RE.test(id)))];
        const kbs = [...new Set((kbIds || []).filter((id) => typeof id === 'string' && UUID_RE.test(id)))];
        const out = new Map<string, string>();
        if (docs.length === 0 || kbs.length === 0) return out;
        const { rows } = await db.query(
            `SELECT id, knowledge_base_id FROM documents WHERE id = ANY($1::uuid[]) AND knowledge_base_id = ANY($2::uuid[])`, [docs, kbs]);
        for (const r of rows) out.set(String(r.id), String(r.knowledge_base_id));
        return out;
    }

    /**
     * The version of each document at the moment of the search: Map(documentId -> {versionId, label}). `label` is the
     * start of the document's content hash (what a re-ingest changes); `versionId` is the newest kb_document_versions
     * snapshot of the document, when it has one (those are written before a delete or an overwrite).
     */
    async function documentVersions(documentIds: string[]): Promise<Map<string, { versionId: string | null; label: string | null }>> {
        const docs = [...new Set((documentIds || []).filter((id) => typeof id === 'string' && UUID_RE.test(id)))];
        const out = new Map<string, { versionId: string | null; label: string | null }>();
        if (docs.length === 0) return out;
        const { rows } = await db.query(
            `SELECT d.id, d.content_hash,
                    (SELECT v.id FROM kb_document_versions v WHERE v.document_id = d.id ORDER BY v.deleted_at DESC LIMIT 1) AS version_id
             FROM documents d WHERE d.id = ANY($1::uuid[])`, [docs]);
        for (const r of rows) out.set(String(r.id), { versionId: r.version_id ? String(r.version_id) : null, label: r.content_hash ? String(r.content_hash).slice(0, 12) : null });
        return out;
    }

    /** Seal everything first, then write: a key problem leaves no partial group behind. */
    async function insertEntries(rows: InsertRow[]): Promise<number> {
        const prepared = [];
        for (const r of rows) {
            const id = r.id || randomUUID();
            const chunks = (r.chunks || []).map(cleanChunk);
            const scores = chunks.map((c) => c.score).filter((s): s is number => typeof s === 'number');
            const createdAt = r.createdAt ? new Date(r.createdAt) : clock();
            prepared.push({
                r, id, chunks, createdAt,
                topScore: scores.length ? Math.max(...scores) : null,
                queryEnc: await crypto.sealField(r.organizationId, r.kbId, id, 'query', cap(r.query, QUERY_CAP)),
                chunksEnc: await crypto.sealField(r.organizationId, r.kbId, id, 'chunks', JSON.stringify(chunks)),
            });
        }
        // Conditional at write time: the recorder's 30 s cache (or a search already in flight) may still say
        // "logging", while the manager has switched it off, purged, or moved the KB out of the organisation.
        let written = 0;
        for (const p of prepared) {
            const res = await db.query(
                `INSERT INTO kb_query_log (id, search_group_id, organization_id, kb_id, user_id, channel, channel_ref, created_at,
                    query_enc, chunks_enc, chunk_count, top_score, retrieval_ms, outcome, error_code, expires_at)
                 SELECT $1::text, $2::text, $3::text, $4::uuid, $5::text, $6::text, $7::jsonb, $8::timestamptz,
                    $9::text, $10::text, $11::int, $12::real, $13::int, $14::text, $15::text, $16::timestamptz
                 WHERE EXISTS (SELECT 1 FROM knowledge_bases WHERE id = $4::uuid AND query_log_enabled = true AND organization_id IS NOT NULL)`,
                [p.id, p.r.searchGroupId, p.r.organizationId ?? null, p.r.kbId, p.r.userId ?? null, p.r.channel,
                    JSON.stringify(p.r.channelRef || {}), p.createdAt.toISOString(), p.queryEnc, p.chunksEnc, p.chunks.length,
                    p.topScore, p.r.retrievalMs ?? null, p.r.outcome, p.r.errorCode ?? null, expiry(p.createdAt, p.r.retentionDays).toISOString()]);
            written += res.rowCount ?? 1;
        }
        return written;
    }

    /** Attach the answer to every row of one search. A KB that gave no passages keeps `no_results`. */
    async function finishGroup(searchGroupId: string, patch: FinishPatch): Promise<number> {
        const { rows } = await db.query(
            `SELECT id, kb_id, organization_id, chunk_count FROM kb_query_log WHERE search_group_id = $1`, [searchGroupId]);
        const sealed = [];
        for (const r of rows) {
            sealed.push({
                id: String(r.id),
                outcome: patch.outcome === 'answered' && Number(r.chunk_count) === 0 ? 'no_results' : patch.outcome,
                answerEnc: await crypto.sealField(r.organization_id ?? null, String(r.kb_id), String(r.id), 'answer',
                    patch.answer == null ? null : cap(patch.answer, ANSWER_CAP)),
                citationsEnc: await crypto.sealField(r.organization_id ?? null, String(r.kb_id), String(r.id), 'citations',
                    patch.citations == null ? null : JSON.stringify(patch.citations)),
            });
        }
        for (const s of sealed) {
            await db.query(
                `UPDATE kb_query_log SET answer_enc = $2, citations_enc = $3, model = $4, answer_ms = $5, outcome = $6,
                        error_code = $7, answered_at = $8 WHERE id = $1`,
                [s.id, s.answerEnc, s.citationsEnc, patch.model ?? null, patch.answerMs ?? null, s.outcome, patch.errorCode ?? null, clock().toISOString()]);
        }
        return sealed.length;
    }

    /** Which sealed fields a read opens. `true` = all of them. */
    type Want = true | { query?: boolean; answer?: boolean; note?: boolean };

    async function decryptRow(r: any, want: Want | false): Promise<EntryRow> {
        const id = String(r.id); const kbId = String(r.kb_id); const org = r.organization_id ?? null;
        let decryptFailed = false;
        const open = async (field: realCrypto.KbQueryLogField, stored: string | null): Promise<string | null> => {
            try { return await crypto.openField(org, kbId, id, field, stored); } catch { decryptFailed = true; return null; }
        };
        const base: EntryRow = {
            id, searchGroupId: String(r.search_group_id), kbId, organizationId: org, userId: r.user_id ?? null,
            channel: r.channel, channelRef: r.channel_ref || {}, createdAt: iso(r.created_at),
            query: null, chunks: [], chunkCount: Number(r.chunk_count) || 0, topScore: num(r.top_score), retrievalMs: num(r.retrieval_ms),
            answer: null, citations: [], model: r.model ?? null, answerMs: num(r.answer_ms),
            outcome: r.outcome, errorCode: r.error_code ?? null, answeredAt: iso(r.answered_at),
            reviewStatus: r.review_status, reviewNote: null, reviewedBy: r.reviewed_by ?? null, reviewedAt: iso(r.reviewed_at), expiresAt: iso(r.expires_at),
        };
        if (!want) return base;
        if (want === true || want.query) base.query = await open('query', r.query_enc);
        if (want === true) base.chunks = parseJson<LogChunk[]>(await open('chunks', r.chunks_enc), []);
        if (want === true || want.answer) base.answer = await open('answer', r.answer_enc);
        if (want === true) base.citations = parseJson<unknown[]>(await open('citations', r.citations_enc), []);
        if (want === true || want.note) base.reviewNote = await open('review_note', r.review_note_enc);
        if (decryptFailed) base.decryptFailed = true;
        return base;
    }

    async function addUserNames(rows: EntryRow[]): Promise<void> {
        const ids = [...new Set(rows.map((r) => r.userId).filter((u): u is string => !!u))];
        if (ids.length === 0) return;
        try {
            const { rows: users } = await db.query(`SELECT id, "displayName", username FROM users WHERE id = ANY($1::text[])`, [ids]);
            const byId = new Map(users.map((u) => [String(u.id), (u.displayName || u.username || null) as string | null]));
            for (const r of rows) if (r.userId) r.userName = byId.get(r.userId) ?? null;
        } catch { /* names are a convenience; the id stays */ }
    }

    function where(f: ListFilter): { sql: string; params: unknown[] } {
        const c: string[] = []; const p: unknown[] = [];
        const add = (sql: string, v: unknown) => { p.push(v); c.push(sql.replace('?', `$${p.length}`)); };
        if (f.kbId) add('kb_id = ?::uuid', f.kbId);
        if (f.orgId !== undefined) add('organization_id IS NOT DISTINCT FROM ?', f.orgId);
        if (f.from) add('created_at >= ?', new Date(f.from).toISOString());
        if (f.to) add('created_at <= ?', new Date(f.to).toISOString());
        if (f.userId) add('user_id = ?', f.userId);
        if (f.channel) add('channel = ?', f.channel);
        if (f.outcome) add('outcome = ?', f.outcome);
        if (f.status) add('review_status = ?', f.status);
        return { sql: c.length ? `WHERE ${c.join(' AND ')}` : '', params: p };
    }

    async function listEntries(f: ListFilter): Promise<{ rows: EntryRow[]; total: number }> {
        if (f.kbId && !UUID_RE.test(f.kbId)) return { rows: [], total: 0 };
        const limit = Math.min(Math.max(Number(f.limit) || 50, 1), MAX_PAGE);
        const offset = Math.max(Number(f.offset) || 0, 0);
        const w = where(f);
        const text = f.includeContent && f.q ? String(f.q).trim().toLowerCase() : '';
        if (!text) {
            const total = Number((await db.query(`SELECT COUNT(*)::int AS n FROM kb_query_log ${w.sql}`, w.params)).rows[0]?.n) || 0;
            const { rows } = await db.query(
                `SELECT * FROM kb_query_log ${w.sql} ORDER BY created_at DESC, id LIMIT ${limit} OFFSET ${offset}`, w.params);
            const out = await Promise.all(rows.map((r) => decryptRow(r, !!f.includeContent)));
            await addUserNames(out);
            return { rows: out, total };
        }
        // The text filter opens only the question and the answer of up to TEXT_FILTER_ROW_CAP rows (the passages,
        // citations and note are neither selected nor opened); the page that is returned is then read in full.
        const { rows } = await db.query(
            `SELECT ${MATCH_COLS} FROM kb_query_log ${w.sql} ORDER BY created_at DESC, id LIMIT ${TEXT_FILTER_ROW_CAP}`, w.params);
        const hitIds: string[] = [];
        for (const r of rows) {
            const d = await decryptRow(r, { query: true, answer: true });
            if (`${d.query ?? ''}\n${d.answer ?? ''}`.toLowerCase().includes(text)) hitIds.push(d.id);
        }
        const pageIds = hitIds.slice(offset, offset + limit);
        if (pageIds.length === 0) return { rows: [], total: hitIds.length };
        const { rows: full } = await db.query(`SELECT * FROM kb_query_log WHERE id = ANY($1::text[])`, [pageIds]);
        const byId = new Map(full.map((r) => [String(r.id), r]));
        const page = await Promise.all(pageIds.map((id) => byId.get(id)).filter(Boolean).map((r) => decryptRow(r, true)));
        await addUserNames(page);
        return { rows: page, total: hitIds.length };
    }

    /**
     * The rows of an export, one batch at a time: a keyset walk over the filter (no OFFSET re-scan), opening only
     * the question, the answer and the review note, never the passages or the citations. With `q`, at most
     * TEXT_FILTER_ROW_CAP rows are looked at (the same bound as the list) and only the matches are yielded.
     * Stops after `cap` rows.
     */
    async function* exportEntries(f: ListFilter, cap: number): AsyncGenerator<EntryRow> {
        if (f.kbId && !UUID_RE.test(f.kbId)) return;
        const text = f.q ? String(f.q).trim().toLowerCase() : '';
        const maxScan = text ? TEXT_FILTER_ROW_CAP : cap;
        const w = where(f);
        let scanned = 0, yielded = 0;
        let after: { at: string; id: string } | null = null;
        while (scanned < maxScan && yielded < cap) {
            const params = [...w.params];
            let cond = w.sql;
            if (after) {
                params.push(after.at, after.id);
                cond += `${cond ? ' AND' : 'WHERE'} (created_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::text)`;
            }
            const take = Math.min(EXPORT_BATCH, maxScan - scanned);
            const { rows } = await db.query(
                `SELECT ${EXPORT_COLS} FROM kb_query_log ${cond} ORDER BY created_at DESC, id DESC LIMIT ${take}`, params);
            if (rows.length === 0) return;
            const batch: EntryRow[] = [];
            for (const r of rows) {
                scanned++;
                const d = await decryptRow(r, { query: true, answer: true, note: true });
                if (text && !`${d.query ?? ''}\n${d.answer ?? ''}`.toLowerCase().includes(text)) continue;
                batch.push(d);
            }
            await addUserNames(batch);
            for (const d of batch) { if (yielded++ >= cap) return; yield d; }
            const last = rows[rows.length - 1];
            after = { at: (last.created_at instanceof Date ? last.created_at : new Date(last.created_at)).toISOString(), id: String(last.id) };
            if (rows.length < take) return;
        }
    }

    async function getEntry(kbId: string, id: string): Promise<EntryRow | null> {
        if (!UUID_RE.test(kbId) || !id) return null;
        const { rows } = await db.query(`SELECT * FROM kb_query_log WHERE kb_id = $1::uuid AND id = $2`, [kbId, String(id)]);
        if (!rows[0]) return null;
        const row = await decryptRow(rows[0], true);
        await addUserNames([row]);
        return row;
    }

    async function setReview(kbId: string, id: string, { status, note, reviewedBy }: { status: ReviewStatus; note?: string | null; reviewedBy: string }): Promise<EntryRow | null> {
        if (!UUID_RE.test(kbId)) return null;
        const { rows } = await db.query(`SELECT id, organization_id FROM kb_query_log WHERE kb_id = $1::uuid AND id = $2`, [kbId, String(id)]);
        if (!rows[0]) return null;
        const noteEnc = await crypto.sealField(rows[0].organization_id ?? null, kbId, String(id), 'review_note', note ? cap(note, 4000) : null);
        await db.query(
            `UPDATE kb_query_log SET review_status = $3, review_note_enc = $4, reviewed_by = $5, reviewed_at = $6 WHERE kb_id = $1::uuid AND id = $2`,
            [kbId, String(id), status, noteEnc, reviewedBy ?? null, clock().toISOString()]);
        return getEntry(kbId, id);
    }

    async function deleteForKb(kbId: string): Promise<number> {
        if (!UUID_RE.test(kbId)) return 0;
        await db.query(`DELETE FROM kb_query_log_ack WHERE kb_id = $1::uuid`, [kbId]);
        return (await db.query(`DELETE FROM kb_query_log WHERE kb_id = $1::uuid`, [kbId])).rowCount || 0;
    }

    /** Erase a person's rows, and clear their name from rows they reviewed. A null `orgId` means every organisation. */
    async function deleteForUser(orgId: string | null | undefined, userId: string): Promise<number> {
        if (!userId) return 0;
        const org = orgId ?? null;
        // Account erasure (no organisation given) also drops the person's acknowledgements.
        if (org === null) await db.query(`DELETE FROM kb_query_log_ack WHERE user_id = $1`, [userId]);
        const n = (await db.query(
            `DELETE FROM kb_query_log WHERE user_id = $1 AND ($2::text IS NULL OR organization_id = $2)`, [userId, org])).rowCount || 0;
        await db.query(`UPDATE kb_query_log SET reviewed_by = NULL WHERE reviewed_by = $1 AND ($2::text IS NULL OR organization_id = $2)`, [userId, org]);
        return n;
    }

    async function deleteExpired(limit: number = DELETE_BATCH_DEFAULT): Promise<number> {
        const lim = Math.max(1, Math.floor(Number(limit) || DELETE_BATCH_DEFAULT));
        return (await db.query(
            `DELETE FROM kb_query_log WHERE id IN (SELECT id FROM kb_query_log WHERE expires_at < now() ORDER BY expires_at LIMIT ${lim})`)).rowCount || 0;
    }

    async function countsByKb(orgId: string | null): Promise<Record<string, { total: number; byOutcome: Record<string, number>; byStatus: Record<string, number> }>> {
        const { rows } = await db.query(
            `SELECT kb_id, outcome, review_status, COUNT(*)::int AS n FROM kb_query_log WHERE organization_id IS NOT DISTINCT FROM $1 GROUP BY kb_id, outcome, review_status`, [orgId ?? null]);
        const out: Record<string, { total: number; byOutcome: Record<string, number>; byStatus: Record<string, number> }> = {};
        for (const r of rows) {
            const e = (out[String(r.kb_id)] ||= { total: 0, byOutcome: {}, byStatus: {} });
            e.total += r.n; e.byOutcome[r.outcome] = (e.byOutcome[r.outcome] || 0) + r.n; e.byStatus[r.review_status] = (e.byStatus[r.review_status] || 0) + r.n;
        }
        return out;
    }

    async function countsForUser(orgId: string | null, userId: string): Promise<{ total: number; byKb: Record<string, number> }> {
        const { rows } = await db.query(
            `SELECT kb_id, COUNT(*)::int AS n FROM kb_query_log WHERE user_id = $1 AND organization_id IS NOT DISTINCT FROM $2 GROUP BY kb_id`, [userId, orgId ?? null]);
        const byKb: Record<string, number> = {}; let total = 0;
        for (const r of rows) { byKb[String(r.kb_id)] = r.n; total += r.n; }
        return { total, byKb };
    }

    /** The people who asked this base (for resolving a pseudonym in the person filter). */
    async function askersOfKb(kbId: string): Promise<string[]> {
        if (!UUID_RE.test(kbId)) return [];
        const { rows } = await db.query(`SELECT DISTINCT user_id FROM kb_query_log WHERE kb_id = $1::uuid AND user_id IS NOT NULL`, [kbId]);
        return rows.map((r) => String(r.user_id));
    }

    const acks = makeAckFns(db, clock);
    const settingsFns = makeSettingsFns(db, clock);
    return {
        getLoggingKbs, kbIdsForDocuments, documentVersions, insertEntries, finishGroup, listEntries, exportEntries, getEntry, setReview, deleteForKb, deleteForUser,
        deleteExpired, countsByKb, countsForUser, ...settingsFns,
        ...acks, askersOfKb,
    };
}

export type KbQueryLogStore = ReturnType<typeof makeKbQueryLogStore>;

let real: KbQueryLogStore | null = null;
/** The store over the real pool, built on first use. */
export function kbQueryLogStore(): KbQueryLogStore {
    return real ??= makeKbQueryLogStore({ query: (sql, params) => nodeRequire('../../../db.js').pool.query(sql, params) });
}

export const getLoggingKbs: KbQueryLogStore['getLoggingKbs'] = (...a) => kbQueryLogStore().getLoggingKbs(...a);
export const kbIdsForDocuments: KbQueryLogStore['kbIdsForDocuments'] = (...a) => kbQueryLogStore().kbIdsForDocuments(...a);
export const insertEntries: KbQueryLogStore['insertEntries'] = (...a) => kbQueryLogStore().insertEntries(...a);
export const finishGroup: KbQueryLogStore['finishGroup'] = (...a) => kbQueryLogStore().finishGroup(...a);
export const listEntries: KbQueryLogStore['listEntries'] = (...a) => kbQueryLogStore().listEntries(...a);
export const exportEntries: KbQueryLogStore['exportEntries'] = (...a) => kbQueryLogStore().exportEntries(...a);
export const getEntry: KbQueryLogStore['getEntry'] = (...a) => kbQueryLogStore().getEntry(...a);
export const setReview: KbQueryLogStore['setReview'] = (...a) => kbQueryLogStore().setReview(...a);
export const deleteForKb: KbQueryLogStore['deleteForKb'] = (...a) => kbQueryLogStore().deleteForKb(...a);
export const deleteForUser: KbQueryLogStore['deleteForUser'] = (...a) => kbQueryLogStore().deleteForUser(...a);
export const deleteExpired: KbQueryLogStore['deleteExpired'] = (...a) => kbQueryLogStore().deleteExpired(...a);
export const recomputeExpiry: KbQueryLogStore['recomputeExpiry'] = (...a) => kbQueryLogStore().recomputeExpiry(...a);
export const countsByKb: KbQueryLogStore['countsByKb'] = (...a) => kbQueryLogStore().countsByKb(...a);
export const countsForUser: KbQueryLogStore['countsForUser'] = (...a) => kbQueryLogStore().countsForUser(...a);
export const documentVersions: KbQueryLogStore['documentVersions'] = (...a) => kbQueryLogStore().documentVersions(...a);
export const acknowledge: KbQueryLogStore['acknowledge'] = (...a) => kbQueryLogStore().acknowledge(...a);
export const validAckKbIds: KbQueryLogStore['validAckKbIds'] = (...a) => kbQueryLogStore().validAckKbIds(...a);
export const ackCountsByKb: KbQueryLogStore['ackCountsByKb'] = (...a) => kbQueryLogStore().ackCountsByKb(...a);
export const askersOfKb: KbQueryLogStore['askersOfKb'] = (...a) => kbQueryLogStore().askersOfKb(...a);
export const getQueryLogSettings: KbQueryLogStore['getQueryLogSettings'] = (...a) => kbQueryLogStore().getQueryLogSettings(...a);
export const setQueryLogSettings: KbQueryLogStore['setQueryLogSettings'] = (...a) => kbQueryLogStore().setQueryLogSettings(...a);
