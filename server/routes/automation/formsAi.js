/**
 * "Build it with AI" — draft or revise a form's questions from a brief.
 * (Studio → Forms, Sep 2026.)
 *
 *   POST /api/automation/forms/ai/draft
 *        { mode: 'create'|'revise', brief?, note?, current? } → { draft: { form, notes } }
 *
 * Wired into `routes/automation/crud.js`, which owns the router and its
 * gates (requireAuth, the automations feature, the active-org block). Plain
 * `(req, res)` functions, required LAZILY there, for the reason
 * routes/skills/ai.js records: crud's DB-free suites stub its dependencies
 * through a parent-keyed resolve hook, and an eager require here would drag
 * the LLM client and the provider adapters into them.
 *
 * NOTHING IS STORED. The Form page applies the draft to its unsaved
 * questions; the person reads it, changes what they like, and saves — or
 * discards. A route that wrote a form as a side effect of a suggestion would
 * leave the previous questions gone the moment a model misread a brief, and
 * on a form that already collects answers that means retired columns.
 *
 * The brief is the person's own text (or what they pasted). It goes to the
 * workspace's fast-tier model and nowhere else; the current questions go
 * along in revise mode. No other form, table or row is read.
 */

'use strict';

const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { z } = require('zod');
const { DRAFT_TOOL, MAX_BRIEF_CHARS, MAX_NOTE_CHARS, buildDraftMessages, parseFormDraft } = require('../../automation/formDraft');
const log = require('../../telemetry/log');

/** One model call per keystroke-sized request; ten a minute is plenty for a person. */
const limiter = perUserRateLimit({ windowMs: 60_000, max: 10 });

// A 40-question form with help texts and options runs a few thousand tokens.
const MAX_TOKENS = 4000;

async function orgIdOf(req) {
    const userStore = require('../../stores/userStore');
    const user = await userStore.getUser(req.session.user.id);
    return user?.organizationId || null;
}

/** The fast tier, with the global default behind it — the same resolver skills/ai.js uses. */
async function resolveModel({ userId, userOrgId }) {
    const { resolveModelForTier, resolveModelWithGlobalFallback } = require('../../core/llm/modelResolver');
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

/** One usage row per drafting call — `chatForcedTool` logs nothing itself. */
async function logDraftUsage({ userId, userOrgId, modelId, usage, startMs }) {
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            user_id: userId,
            agent_name: 'form-ai',
            agent_type: 'system',
            model: modelId,
            prompt_tokens: usage?.prompt_tokens || 0,
            completion_tokens: usage?.completion_tokens || 0,
            total_tokens: usage?.total_tokens || ((usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0)),
            cached_tokens: usage?.cached_tokens || 0,
            cache_creation_tokens: usage?.cache_creation_tokens || 0,
            source: 'form_ai_draft',
            duration_ms: Date.now() - startMs,
            organization_id: userOrgId || null,
        });
    } catch (e) {
        log.warn('[Forms/ai] failed to log usage:', e.message);
    }
}

/** The current form as the client sends it — only the parts the prompt quotes. */
function readCurrent(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    for (const k of ['title', 'description', 'submitLabel', 'successMessage']) {
        if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, 2000);
    }
    if (Array.isArray(raw.fields)) out.fields = raw.fields.slice(0, 60);
    if (raw.theme && typeof raw.theme === 'object') out.theme = raw.theme;
    if (typeof raw.collect === 'boolean') out.collect = raw.collect;
    return out;
}

// -- What a caller may send -------------------------------------------
//
// `mode` was read as `=== 'revise' ? 'revise' : 'create'`. So `mode: 'Revise'`
// -- or any other spelling -- DREW A NEW FORM over the one on screen instead
// of changing it, and answered 200 with a draft that looked plausible. The
// same class as `mode: 'defenition'` on the n8n route.
//
// `current` stays OPEN on purpose: it is the form as the editor holds it, and
// readCurrent() below is already the allow-list of the parts the prompt
// quotes. The schema asks only that it be a document, never a list.
const MODE_TEXT = 'mode is "create" or "revise".';
const DraftBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({
        mode: z.enum(['create', 'revise'], { errorMap: () => ({ message: MODE_TEXT }) }).default('create'),
        brief: z.string({ invalid_type_error: 'brief must be text.' }).optional(),
        note: z.string({ invalid_type_error: 'note must be text.' }).optional(),
        current: z.record(z.unknown()).nullish(),
    }).strict(),
);

// ── POST /api/automation/forms/ai/draft ──────────────────────────────
async function draft(req, res) {
    try {
        const body = req.body;
        const mode = body.mode;
        const brief = String(body.brief || '').trim().slice(0, MAX_BRIEF_CHARS);
        const note = String(body.note || '').trim().slice(0, MAX_NOTE_CHARS);
        const current = readCurrent(body.current);
        if (mode === 'create' && !brief) {
            return res.status(400).json({ error: 'Describe the form, or paste what it should be based on.', code: 'no_brief' });
        }
        if (mode === 'revise' && !note && !brief) {
            return res.status(400).json({ error: 'Say what should change.', code: 'no_note' });
        }
        if (mode === 'revise' && !current) {
            return res.status(400).json({ error: 'Revising needs the current questions.', code: 'no_current' });
        }
        const userId = req.session.user.id;
        const userOrgId = await orgIdOf(req);
        const modelId = await resolveModel({ userId, userOrgId });
        if (!modelId) {
            return res.status(503).json({ error: 'No AI model is configured for this workspace.', code: 'no_model' });
        }
        const llmClient = require('../../core/llm/llmClient');
        const startMs = Date.now();
        const result = await llmClient.chatForcedTool(modelId, buildDraftMessages({ mode, brief, note, current }), DRAFT_TOOL, {
            maxTokens: MAX_TOKENS,
            temperature: 0.3,
        });
        await logDraftUsage({ userId, userOrgId, modelId, usage: result?.usage, startMs });
        const parsed = parseFormDraft(result?.structured || null, { mode, current });
        if (!parsed) {
            return res.status(502).json({
                error: 'The model did not return a usable form. Try again, or describe it more concretely.',
                code: 'ai_unusable',
            });
        }
        return res.json({ draft: parsed, mode });
    } catch (err) {
        log.error('[Forms] POST /forms/ai/draft error:', err);
        return res.status(500).json({ error: 'Could not draft this form' });
    }
}

module.exports = { draft, limiter, resolveModel, orgIdOf, DraftBody };
