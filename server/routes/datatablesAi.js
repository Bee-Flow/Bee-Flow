/**
 * "Build it with AI" — draft or revise a datatable's columns from a brief.
 * (Studio → Datatables, Sep 2026; the form twin is routes/automation/formsAi.js.)
 *
 *   POST /api/datatables/ai/draft
 *        { mode: 'create'|'revise', brief?, note?, current?, allowDestructive? }
 *        → { draft: { name, key, description, fields, notes, changes }, mode }
 *
 * Wired into routes/datatables.js (which owns the router and its gates),
 * required LAZILY there so the router's DB-free suites never load the LLM
 * client. NOTHING IS STORED: the create dialog fills its fields with the
 * draft and the person presses Create; the column designer puts it in its
 * unsaved list and the person presses Save — behind the designer's own
 * destructive-change confirmation. The clamps that keep a draft from
 * costing rows live in dataModel/datatableDraft.js; `allowDestructive` is
 * the person's explicit say-so and defaults to false.
 *
 * The brief and the current columns go to the workspace's fast-tier model
 * and nowhere else; no row is ever read.
 *
 * ── What a caller may send ──────────────────────────────────────────
 *
 * `mode` was read as `=== 'revise' ? 'revise' : 'create'`, so `'Revise'` —
 * or any other spelling — DREW A NEW TABLE from the brief instead of revising
 * the one in the designer, and answered 200 with a draft that looked
 * plausible: the formsAi twin's bug, and `mode: 'defenition'`'s on the n8n
 * route. `allowDestructive: 'true'` (text) was read as no, silently. The body
 * is `.strict()` now, and `current` stays open inside — it is the table as
 * the designer holds it, and readCurrent() below is the allow-list of what
 * the prompt quotes.
 *
 * A change request longer than MAX_NOTE_CHARS was CUT there without a word —
 * and the column designer's box allows six times as much, so a long request
 * typed in the real UI reached the model without its tail, often the part
 * that mattered. It is refused now, in a sentence the panel shows; the brief
 * gets the same rule at its own cap.
 *
 * The router that mounts this (routes/datatables/index.js) calls `draft(req,
 * res)` without a `next`, so the schema is applied here, through the same
 * validate() every other route uses, and answered in its envelope. DraftBody
 * is exported so the mount can put it in front, the way automation/crud.js
 * does for the forms twin; applying it twice is harmless.
 */

'use strict';

const { z } = require('zod');
const { perUserRateLimit } = require('../utils/perUserRateLimit');
const { DRAFT_TOOL, MAX_BRIEF_CHARS, MAX_NOTE_CHARS, buildDraftMessages, parseDatatableDraft } = require('../core/dataEngine/dataModel/datatableDraft');
const { isSchemaLockedKind } = require('../core/dataEngine/dataModel/managedTables');
const { validate } = require('../core/http/validate');
const { choice } = require('./datatables/schemas');
const log = require('../telemetry/log');

const NOTE_TEXT = `A change request is at most ${MAX_NOTE_CHARS} characters — shorten it, or split it into two.`;
const BRIEF_TEXT = `A table description is at most ${MAX_BRIEF_CHARS} characters — shorten it, or leave out what the columns do not need.`;

const DraftBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({
        mode: choice(['create', 'revise'], 'mode is "create" or "revise".').default('create'),
        // Capped, not cut: the model is only ever sent this much of either.
        brief: z.string({ invalid_type_error: 'brief must be text.' }).trim().max(MAX_BRIEF_CHARS, BRIEF_TEXT).nullish(),
        note: z.string({ invalid_type_error: 'note must be text.' }).trim().max(MAX_NOTE_CHARS, NOTE_TEXT).nullish(),
        current: z.record(z.unknown(), { invalid_type_error: 'current is the table as the designer holds it.' }).nullish(),
        allowDestructive: z.boolean({ invalid_type_error: 'allowDestructive is true or false.' }).optional(),
    }).strict(),
);
const validateDraft = validate({ body: DraftBody });

/** Run the schema; answer its refusal in the envelope the terminal handler would. */
function refused(req, res) {
    let error = null;
    validateDraft(req, res, (err) => { error = err || null; });
    if (!error) return false;
    res.status(error.status).json({ error: error.message, code: error.code, details: error.details });
    return true;
}

const limiter = perUserRateLimit({ windowMs: 60_000, max: 10 });
const MAX_TOKENS = 4000;

async function orgIdOf(req) {
    const userStore = require('../stores/userStore');
    const user = await userStore.getUser(req.session.user.id);
    return user?.organizationId || null;
}

async function resolveModel({ userId, userOrgId }) {
    const { resolveModelForTier, resolveModelWithGlobalFallback } = require('../core/llm/modelResolver');
    try {
        const resolved = await resolveModelForTier('tier:fast', { userOrgId, userId, fallbackTier: 'fast' });
        if (resolved) return resolved;
    } catch (_) { /* fall through */ }
    try {
        return await resolveModelWithGlobalFallback('tier:fast', { userOrgId, userId });
    } catch (_) {
        return null;
    }
}

async function logDraftUsage({ userId, userOrgId, modelId, usage, startMs }) {
    try {
        const usageStore = require('../stores/usageStore');
        await usageStore.logUsage({
            user_id: userId,
            agent_name: 'datatable-ai',
            agent_type: 'system',
            model: modelId,
            prompt_tokens: usage?.prompt_tokens || 0,
            completion_tokens: usage?.completion_tokens || 0,
            total_tokens: usage?.total_tokens || ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0)),
            cached_tokens: usage?.cached_tokens || 0,
            cache_creation_tokens: usage?.cache_creation_tokens || 0,
            source: 'datatable_ai_draft',
            duration_ms: Date.now() - startMs,
            organization_id: userOrgId || null,
        });
    } catch (e) {
        log.warn('[Datatables/ai] failed to log usage:', e.message);
    }
}

/** The current table as the client sends it — only what the prompt quotes. */
function readCurrent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const k of ['name', 'description', 'managedKind']) if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, 600);
    if (Number.isFinite(raw.rowCount)) out.rowCount = raw.rowCount;
    out.fields = Array.isArray(raw.fields) ? raw.fields.slice(0, 120).filter(f => f && typeof f === 'object').map(f => ({
        id: typeof f.id === 'string' ? f.id : undefined,
        key: typeof f.key === 'string' ? f.key : '',
        name: typeof f.name === 'string' ? f.name : '',
        type: typeof f.type === 'string' ? f.type : 'text',
        options: Array.isArray(f.options) ? f.options : undefined,
        required: f.required === true,
        unique: f.unique === true,
    })) : [];
    return out;
}

async function draft(req, res) {
    try {
        if (refused(req, res)) return;
        const body = req.body;
        const mode = body.mode;
        const brief = String(body.brief || '').trim().slice(0, MAX_BRIEF_CHARS);
        const note = String(body.note || '').trim().slice(0, MAX_NOTE_CHARS);
        const allowDestructive = body.allowDestructive === true;
        const current = readCurrent(body.current);
        if (mode === 'create' && !brief) {
            return res.status(400).json({ error: 'Describe the table, or paste what its columns should be based on.', code: 'no_brief' });
        }
        if (mode === 'revise' && !current) {
            return res.status(400).json({ error: 'Revising needs the current columns.', code: 'no_current' });
        }
        if (mode === 'revise' && !note && !brief) {
            return res.status(400).json({ error: 'Say what should change.', code: 'no_note' });
        }
        if (current?.managedKind && isSchemaLockedKind(current.managedKind)) {
            return res.status(409).json({ error: 'The columns of this table are not yours to change here.', code: 'schema_locked' });
        }
        const userId = req.session.user.id;
        const userOrgId = await orgIdOf(req);
        const modelId = await resolveModel({ userId, userOrgId });
        if (!modelId) return res.status(503).json({ error: 'No AI model is configured for this workspace.', code: 'no_model' });
        const llmClient = require('../core/llm/llmClient');
        const startMs = Date.now();
        const result = await llmClient.chatForcedTool(modelId, buildDraftMessages({ mode, brief, note, current, allowDestructive }), DRAFT_TOOL, {
            maxTokens: MAX_TOKENS,
            temperature: 0.3,
        });
        await logDraftUsage({ userId, userOrgId, modelId, usage: result?.usage, startMs });
        const parsed = parseDatatableDraft(result?.structured || null, { mode, current, allowDestructive });
        if (!parsed) {
            return res.status(502).json({ error: 'The model did not return a usable table. Try again, or describe it more concretely.', code: 'ai_unusable' });
        }
        return res.json({ draft: parsed, mode });
    } catch (err) {
        log.error('[Datatables] POST /ai/draft error:', err);
        return res.status(500).json({ error: 'Could not draft this table' });
    }
}

module.exports = { draft, limiter, resolveModel, orgIdOf, DraftBody };
