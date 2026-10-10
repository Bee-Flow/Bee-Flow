'use strict';

/**
 * Memory consolidation — nightly housekeeping of INFERRED memories.
 *
 *   1. merge     near-duplicates (cosine >= 0.95 or identical text, same type and scope): the
 *                older row is superseded by the newer one, so history stays
 *   2. archive   inferred rows unused for more than a year (last_used_at, else
 *                created_at) whose importance is below 0.5
 *   3. quality   inferred rows (instructions: strict rules only) that fail the extractor's CURRENT content rules
 *                (agents/memory/contentRules.js: tasks, questions, "Include:",
 *                requests to the assistant, fragments) and exact duplicates in
 *                the same scope are archived (restorable from the panel)
 *   4. review    inferred rows never judged before (reviewed_at IS NULL) go, <= 25 at a
 *                time, to the fast/extraction model, which says KEEP or ARCHIVE per id.
 *                The regexes cannot see "Hier wordt een datatable gemaakt" or an
 *                assistant sentence stored as a preference; a model can. Ids only come
 *                back, a failed or partial answer leaves rows unreviewed (retried next
 *                run), archived rows stay restorable, counts are logged, never text.
 *
 * Never touches explicit memories; inferred instructions are only judged by the strict quality rules. Idempotent (a merged or
 * archived row is no longer a candidate) and resumable: users are walked in id
 * order in batches, the cursor is kept between runs, and a run stops at its
 * time budget and carries on from the cursor the next night.
 *
 * Every dependency is injected (`createConsolidation(deps)`), so the pass is
 * testable without module mocks; the exports use the real ones, required
 * lazily.
 */

const log = require('../telemetry/log');
const { junkReason, strictJunkReason, normaliseText } = require('../agents/memory/contentRules');

const FIRST_RUN_DELAY_MS = 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;
const MERGE_AT = 0.95;
const STALE_DAYS = 365;
const STALE_IMPORTANCE = 0.5;
const USER_BATCH = 50;
const ROWS_PER_USER = 200;
const QUALITY_ROWS_PER_USER = 2000;
const DEFAULT_BUDGET_MS = 5 * 60 * 1000;
const REVIEW_BATCH = 25;
const REVIEW_ROWS_PER_USER = 200;
const REVIEW_ROWS_PER_RUN = 400;
const CURSOR_KEY = 'memory_consolidation_cursor';

/** System prompt of the review pass. Memories arrive as id, type and content only. */
const REVIEW_SYSTEM_PROMPT = `You clean up an AI assistant's long-term memory about a user. You get a JSON list of stored memories (id, type, content). The content may be in any language. Judge each one.

KEEP only if it is a durable fact, preference or standing instruction about the user, their work, people or projects that would genuinely help in a future, unrelated conversation.

ARCHIVE (keep=false) if it is any of:
- a request or question to the assistant, or a task to do now
- a fragment of a task or a narration of steps ("Hier wordt een datatable gemaakt", "Then the app is created")
- a partial, garbled or ungrammatical sentence
- text written by the assistant (explanations, offers, "I need to take an extra step")
- a bare label or title without a claim about the user (a single product, feature or tool name, "Playbook")
- transient context that only matters for the current conversation

When unsure: KEEP.

Answer with JSON only: {"results":[{"id":"<id>","keep":true|false}]}. One entry per memory, ids copied exactly. Never repeat or quote the memory text.`;

const REVIEW_SCHEMA = {
    type: 'json_schema',
    json_schema: {
        name: 'memory_review',
        strict: true,
        schema: {
            type: 'object',
            properties: {
                results: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: { id: { type: 'string' }, keep: { type: 'boolean' } },
                        required: ['id', 'keep'],
                        additionalProperties: false,
                    },
                },
            },
            required: ['results'],
            additionalProperties: false,
        },
    },
};

/** Ids-only answer -> Map(id -> keep). Unknown ids, non-boolean verdicts and repeats are ignored; null when unparseable. */
function parseReview(raw, allowedIds) {
    let parsed;
    const text = String(raw || '').trim();
    try { parsed = JSON.parse(text); } catch (_) {
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return null;
        try { parsed = JSON.parse(m[0]); } catch (_e) { return null; }
    }
    if (!parsed || !Array.isArray(parsed.results)) return null;
    const out = new Map();
    for (const r of parsed.results) {
        if (!r || typeof r.id !== 'string' || typeof r.keep !== 'boolean') continue;
        if (!allowedIds.has(r.id) || out.has(r.id)) continue;
        out.set(r.id, r.keep);
    }
    return out;
}

function realDeps() {
    const db = () => require('../db');
    const store = () => require('../stores/memoryStore');
    const lifecycle = () => require('../stores/memoryLifecycle');
    const config = () => require('../stores/configStore');
    return {
        log,
        now: () => Date.now(),
        // Users with something to consolidate, after the cursor.
        listUsers: async (afterId, limit) => (await db().getAll(
            `SELECT DISTINCT user_id FROM user_memories
              WHERE status = 'active' AND origin = 'inferred' AND user_id > $1
              ORDER BY user_id LIMIT $2`, [afterId || '', limit])).map((r) => r.user_id),
        // Newest first; hydrated, because the text may be sealed.
        listActiveInferred: async (userId, limit) => {
            const rows = await db().getAll(
                `SELECT * FROM user_memories
                  WHERE user_id = $1 AND status = 'active' AND origin = 'inferred' AND valid_to IS NULL
                    AND type NOT IN ('instruction', 'schedule_coverage')
                  ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
            return require('../stores/memoryCrypto').hydrateRows(rows);
        },
        // All active inferred rows of one user (newest first, hydrated) for the quality pass.
        listForQuality: async (userId, limit) => {
            const rows = await db().getAll(
                `SELECT * FROM user_memories
                  WHERE user_id = $1 AND status = 'active' AND origin = 'inferred' AND valid_to IS NULL
                    AND type <> 'schedule_coverage'
                  ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
            return require('../stores/memoryCrypto').hydrateRows(rows);
        },
        // Never-reviewed inferred rows, newest first, hydrated (the text may be sealed).
        listForReview: async (userId, limit) => {
            const rows = await db().getAll(
                `SELECT * FROM user_memories
                  WHERE user_id = $1 AND status = 'active' AND origin = 'inferred' AND valid_to IS NULL
                    AND reviewed_at IS NULL AND type <> 'schedule_coverage'
                  ORDER BY created_at DESC LIMIT $2`, [userId, limit]);
            return require('../stores/memoryCrypto').hydrateRows(rows);
        },
        markReviewed: async (ids, userId) => {
            if (!ids.length) return 0;
            await db().run(`UPDATE user_memories SET reviewed_at = NOW() WHERE user_id = $1 AND id = ANY($2::text[])`, [userId, ids]);
            return ids.length;
        },
        // { allowed, orgId, shield, scrub }: memory off for the org or user -> not allowed.
        reviewContext: async (userId) => {
            const row = await db().getOne(`SELECT "organizationId" AS org FROM users WHERE id = $1`, [userId]);
            const orgId = row?.org || null;
            const policy = await require('../core/memory/memoryPolicy').resolveMemoryPolicy({ userId, orgId });
            if (!policy.read) return { allowed: false, orgId, shield: null, scrub: false };
            const cfg = config();
            const shield = orgId ? await cfg.getConfig(`org_privacy_shield_${orgId}`) : null;
            let scrub = !!shield?.enabled;
            if (!scrub) { try { scrub = !!(await require('../core/aiAgent').getAIConfig())?.piiDetectionEnabled; } catch (_) { /* fail open: no scrub flag */ } }
            return { allowed: true, orgId, shield, scrub };
        },
        scrubText: async (text, shield) => (await require('../core/memory/scrubMemoryContext').scrubMemoryContext(text, shield)).scrubbed,
        // Same model resolution and chat options as the extractor and the writer's judge.
        judgeBatch: async ({ items, orgId, userId }) => {
            const { resolveMemoryExtractionModel, EXTRACTION_CHAT_OPTIONS } = require('../core/memory/extractionModel');
            const model = await resolveMemoryExtractionModel({ agentModel: null, userOrgId: orgId || null, userId });
            const result = await require('../core/llm/llmClient').chat(model, [
                { role: 'system', content: REVIEW_SYSTEM_PROMPT },
                { role: 'user', content: JSON.stringify(items) },
            ], { ...EXTRACTION_CHAT_OPTIONS, maxTokens: 1024, temperature: 0, responseFormat: REVIEW_SCHEMA });
            return result?.content;
        },
        findStaleIds: async (userId, cutoff) => (await db().getAll(
            `SELECT id FROM user_memories
              WHERE user_id = $1 AND status = 'active' AND origin = 'inferred' AND type NOT IN ('instruction', 'schedule_coverage')
                AND COALESCE(importance, 0.5) < $3 AND COALESCE(last_used_at, created_at) < $2`,
            [userId, cutoff, STALE_IMPORTANCE])).map((r) => r.id),
        findSimilarMemories: (...a) => store().findSimilarMemories(...a),
        supersede: (o, n) => lifecycle().supersede(o, n),
        archive: (ids, userId) => lifecycle().archive(ids, userId),
        getCursor: async () => {
            try { const v = await config().getConfig(CURSOR_KEY); return typeof v === 'string' ? v : ''; } catch (_) { return ''; }
        },
        setCursor: async (v) => {
            try { await config().setConfig(CURSOR_KEY, v); } catch (e) { log.warn('[MemoryConsolidation] cursor not saved:', e.message); }
        },
    };
}

const scopeKey = (r) => `${r.type}|${r.project_id || ''}|${r.agent_id || ''}`;
const ts = (v) => (v ? new Date(v).getTime() : 0);

function createConsolidation(overrides = {}) {
    const d = { ...realDeps(), ...overrides };

    /** One user: archive the stale, then merge the duplicates. */
    async function consolidateUser(userId) {
        const out = { merged: 0, archived: 0, cleaned: 0 };

        // Quality first: junk and exact duplicates (newest kept) go to the archive.
        const junk = [];
        const seen = new Set();
        for (const r of await d.listForQuality(userId, QUALITY_ROWS_PER_USER)) {
            if (r.origin && r.origin !== 'inferred') continue;
            const text = String(r.content ?? '');
            // A row that is still sealed (no key) cannot be judged.
            if (text.startsWith('{"_bfenc"')) continue;
            const key = `${r.project_id || ''}|${r.agent_id || ''}|${normaliseText(text)}`;
            // Instructions are imperative by nature: strict rules only.
            const reason = r.type === 'instruction' ? strictJunkReason(text) : junkReason(text);
            if (reason || seen.has(key)) junk.push(r.id);
            else seen.add(key);
        }
        if (junk.length > 0) out.cleaned = await d.archive(junk, userId);
        const junkSet = new Set(junk);

        const cutoff = new Date(d.now() - STALE_DAYS * 86400000);
        const stale = (await d.findStaleIds(userId, cutoff)).filter((id) => !junkSet.has(id));
        if (stale.length > 0) out.archived = await d.archive(stale, userId);
        const staleSet = new Set(stale);

        const rows = (await d.listActiveInferred(userId, ROWS_PER_USER)).filter((r) => !staleSet.has(r.id) && !junkSet.has(r.id));
        const byId = new Map(rows.map((r) => [r.id, r]));
        const gone = new Set();
        // Newest first: each row absorbs the older near-duplicates behind it.
        for (const row of rows) {
            if (gone.has(row.id)) continue;
            const hits = await d.findSimilarMemories(userId, row.content, {
                projectId: row.project_id || null, agentId: row.agent_id || null, limit: 5,
            });
            for (const hit of hits || []) {
                const other = byId.get(hit.id);
                if (!other || other.id === row.id || gone.has(other.id)) continue;
                if (scopeKey(other) !== scopeKey(row)) continue;
                // Same meaning (cosine) or the same text. Lexical overlap alone
                // merges "likes Python over Java" with "likes Java over Python".
                const same = String(other.content || '').trim().toLowerCase().replace(/\s+/g, ' ')
                    === String(row.content || '').trim().toLowerCase().replace(/\s+/g, ' ');
                if (!same && !(typeof hit.cosine === 'number' && hit.cosine >= MERGE_AT)) continue;
                if (ts(other.created_at) > ts(row.created_at)) continue; // the newer one absorbs us later
                if (await d.supersede(other.id, row.id)) {
                    gone.add(other.id);
                    out.merged++;
                }
            }
        }
        return out;
    }

    /**
     * LLM review of one user's never-judged inferred rows. `runLeft` is how many
     * rows the whole run may still send. Returns { sent, archived }.
     */
    async function reviewUser(userId, runLeft) {
        const out = { sent: 0, archived: 0 };
        let left = Math.min(REVIEW_ROWS_PER_USER, runLeft);
        if (left <= 0) return out;
        const ctx = await d.reviewContext(userId);
        if (!ctx?.allowed) return out;
        const rows = (await d.listForReview(userId, left)).filter((r) => (
            r.origin === 'inferred' && r.status === 'active' && !r.reviewed_at
            && typeof r.content === 'string' && r.content.trim() && !r.content.startsWith('{"_bfenc"')));
        for (let i = 0; i < rows.length && left > 0; i += REVIEW_BATCH) {
            const batch = rows.slice(i, i + Math.min(REVIEW_BATCH, left));
            let answer;
            try {
                // id, type and content only; label-scrubbed when the org's PII protection is on.
                const items = [];
                for (const r of batch) {
                    const content = ctx.scrub ? await d.scrubText(r.content, ctx.shield) : r.content;
                    items.push({ id: r.id, type: r.type, content });
                }
                answer = await d.judgeBatch({ items, orgId: ctx.orgId, userId });
            } catch (e) {
                d.log.warn('[MemoryConsolidation] review call failed:', e.message);
                continue;
            }
            out.sent += batch.length;
            left -= batch.length;
            const verdicts = parseReview(answer, new Set(batch.map((r) => r.id)));
            if (!verdicts || verdicts.size === 0) continue;
            const drop = [...verdicts].filter(([, keep]) => !keep).map(([id]) => id);
            if (drop.length > 0) out.archived += await d.archive(drop, userId);
            await d.markReviewed([...verdicts.keys()], userId);
        }
        return out;
    }

    /** One bounded pass from the saved cursor. */
    async function runOnce({ budgetMs = DEFAULT_BUDGET_MS } = {}) {
        const started = d.now();
        const total = { users: 0, merged: 0, archived: 0, cleaned: 0, reviewed: 0, reviewArchived: 0, wrapped: false };
        let cursor = await d.getCursor();
        for (;;) {
            const users = await d.listUsers(cursor, USER_BATCH);
            if (users.length === 0) { cursor = ''; total.wrapped = true; break; }
            for (const userId of users) {
                if (d.now() - started >= budgetMs) {
                    await d.setCursor(cursor);
                    d.log.info(`[MemoryConsolidation] Budget reached after ${total.users} users — resuming next run`);
                    return total;
                }
                try {
                    const r = await consolidateUser(userId);
                    total.merged += r.merged;
                    total.archived += r.archived;
                    total.cleaned += r.cleaned;
                    if (total.reviewed < REVIEW_ROWS_PER_RUN) {
                        const rv = await reviewUser(userId, REVIEW_ROWS_PER_RUN - total.reviewed);
                        total.reviewed += rv.sent;
                        total.reviewArchived += rv.archived;
                    }
                } catch (e) {
                    d.log.warn('[MemoryConsolidation] user failed:', e.message);
                }
                total.users++;
                cursor = userId;
            }
        }
        await d.setCursor(cursor);
        d.log.info(`[MemoryConsolidation] Done: ${total.users} users, merged ${total.merged}, archived ${total.archived}, quality-archived ${total.cleaned}, reviewed ${total.reviewed}, review-archived ${total.reviewArchived}`);
        return total;
    }

    return { runOnce, consolidateUser, reviewUser };
}

let _default = null;
let _timer = null;
let _running = false;
const getDefault = () => (_default ||= createConsolidation());

async function runOnce(opts) {
    if (_running) return null;
    _running = true;
    try { return await getDefault().runOnce(opts); } finally { _running = false; }
}

function start() {
    if (_timer) return;
    // First pass shortly after boot (a dev server restarts far more often than
    // every 10 minutes and would never get there), then daily.
    const initial = setTimeout(() => runOnce().catch((e) => log.warn('[MemoryConsolidation] initial pass failed:', e.message)), FIRST_RUN_DELAY_MS);
    if (initial.unref) initial.unref();
    _timer = setInterval(() => runOnce().catch((e) => log.warn('[MemoryConsolidation] pass failed:', e.message)), INTERVAL_MS);
    if (_timer.unref) _timer.unref();
    log.info('[MemoryConsolidation] Started — interval 24 h');
}

function stop() {
    if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { createConsolidation, start, stop, runOnce, FIRST_RUN_DELAY_MS, REVIEW_SYSTEM_PROMPT, REVIEW_BATCH, REVIEW_ROWS_PER_USER, REVIEW_ROWS_PER_RUN, parseReview, MERGE_AT, STALE_DAYS, STALE_IMPORTANCE };
