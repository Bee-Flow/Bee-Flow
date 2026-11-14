// @typecheck
/**
 * "Build it with AI" — draft or revise a form's questions from a brief.
 * (Studio → Forms, Sep 2026.)
 *
 *   POST /api/automation/forms/ai/draft
 *        { mode: 'create'|'revise', brief?, note?, current? } → { draft: { form, notes } }
 *
 *   POST /api/automation/:id/forms/style-assist
 *        { prompt, triggerStepId?, style?, theme?, customCss? } → { css, notes, removed }
 *
 * Wired into `routes/automation/forms.js`, registered on the router
 * `routes/automation/crud.js` owns, behind that router's gates (requireAuth,
 * the automations feature, the active-org block). Plain
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
 *
 * STYLE ASSIST ("Describe the look") needs `edit` on the automation (forms.js
 * checks it before the body is read). The model gets the stable class names,
 * the theme and style, the current custom CSS and the questions' labels
 * (core/forms/formStyleAssist.mts), never an answer or a visitor, and answers
 * CSS that goes through sanitizeFormCss before it is returned. Nothing is
 * stored and the CSS never runs here: the editor previews it.
 */

'use strict';

const { perUserRateLimit } = require('../../utils/perUserRateLimit');
const { usageLogFields } = require('../../core/providers/usageNormalizer');
const { HttpError } = require('../../core/http/errors');
const { DRAFT_TOOL, MAX_BRIEF_CHARS, MAX_NOTE_CHARS, buildDraftMessages, parseFormDraft } = require('../../automation/formDraft');
const log = require('../../telemetry/log');
const { bestEffort } = require('../../utils/bestEffort');

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
    } catch (err) { bestEffort('routes/automation/formsAi:resolveModel', err); /* fall through */ }
    try {
        return await resolveModelWithGlobalFallback('tier:fast', { userOrgId, userId });
    } catch (_) {
        return null;
    }
}

/** One usage row per model call — `chatForcedTool` logs nothing itself. */
async function logDraftUsage({ userId, userOrgId, modelId, usage, startMs, source = 'form_ai_draft' }) {
    try {
        const usageStore = require('../../stores/usageStore');
        await usageStore.logUsage({
            user_id: userId,
            agent_name: 'form-ai',
            agent_type: 'system',
            model: modelId,
            // Normalised by the adapter (providers/usageNormalizer.js): cache read/write,
            // the 5m/1h split and reasoning tokens ride along.
            ...usageLogFields(usage),
            source,
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
    if (raw.style && typeof raw.style === 'object') out.style = raw.style;
    if (typeof raw.collect === 'boolean') out.collect = raw.collect;
    return out;
}

// What a caller may send: formDraftBody.mts.
const { DraftBody } = require('./formDraftBody.mts');

// ── POST /api/automation/forms/ai/draft ──────────────────────────────
async function draft(req, res) {
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
        throw new HttpError(503, 'no_model', 'No AI model is configured for this workspace.');
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
        throw new HttpError(502, 'ai_unusable', 'The model did not return a usable form. Try again, or describe it more concretely.');
    }
    return res.json({ draft: parsed, mode });
}

// ── POST /api/automation/:id/forms/style-assist ──────────────────────

// 20 000 characters of CSS is some 6 000 tokens; the notes are a few lines.
const STYLE_MAX_TOKENS = 8000;

/** @typedef {{ kind?: string, form?: StyleSource | null }} FormTriggerNode */
/** @typedef {{ theme?: unknown, style?: Record<string, unknown> | null }} StyleSource */
/**
 * The questions the CSS can target by `data-field`: the entered trigger's and
 * every input page's. Names, labels and types only.
 * @param {import('../../automation/formAnswers/derive').Def} definition
 * @param {FormTriggerNode} trigger
 * @returns {{ name: string, label: string, type: string }[]}
 */
function styleQuestionsOf(definition, trigger) {
    const { normalizeFields } = require('../../automation/formTriggerContract');
    const { inputPagesOf } = require('../../automation/formAnswers/derive');
    const forms = [trigger.form, ...inputPagesOf(definition).map((/** @type {{ form: unknown }} */ p) => p.form)];
    return forms.flatMap((form) => normalizeFields(form))
        .filter((f) => typeof f.name === 'string' && f.name)
        .map((f) => ({ name: f.name, label: typeof f.label === 'string' ? f.label : '', type: String(f.type || 'text') }));
}

/**
 * The look the model starts from: what the editor sent (unsaved), else what
 * the form has saved. `null` from the editor means "none".
 * @param {StyleSource & { customCss?: string | null }} body
 * @param {StyleSource | null | undefined} savedForm
 */
function styleInputsOf(body, savedForm) {
    const saved = savedForm && typeof savedForm === 'object' ? savedForm : {};
    const style = body.style !== undefined ? body.style : saved.style;
    const savedCss = typeof style?.customCss === 'string' ? style.customCss : null;
    return {
        theme: body.theme !== undefined ? body.theme : saved.theme,
        style,
        customCss: body.customCss !== undefined ? body.customCss : savedCss,
    };
}

/**
 * Edit access is checked before this runs (forms.js leaves the automation on
 * res.locals). The editor's unsaved style, theme and CSS win over the saved
 * ones; a value left out falls back to what the form has.
 * @param {import('express').Request<{ id: string }>} req
 * @param {import('express').Response} res
 */
async function styleAssist(req, res) {
    const a = res.locals.automation;
    const body = req.body;
    const { resolveTriggerStepId } = require('../../usecases/automation/runEntry');
    const entered = resolveTriggerStepId(a.definition, body.triggerStepId || null);
    if (entered.error) throw new HttpError(400, 'invalid_trigger_step', entered.error);
    const trigger = /** @type {FormTriggerNode | null | undefined} */ (entered.trigger);
    if (!trigger || trigger.kind !== 'form') throw new HttpError(409, 'not_a_form', 'This trigger is not a form.');
    const { theme, style, customCss } = styleInputsOf(body, trigger.form);

    const userId = req.session.user.id;
    const userOrgId = await orgIdOf(req);
    const modelId = await resolveModel({ userId, userOrgId });
    if (!modelId) {
        throw new HttpError(503, 'no_model', 'No AI model is configured for this workspace.');
    }
    const { STYLE_TOOL, buildStyleMessages, parseStyleAnswer } = require('../../core/forms/formStyleAssist.mts');
    const llmClient = require('../../core/llm/llmClient');
    const startMs = Date.now();
    const messages = buildStyleMessages({ prompt: body.prompt, theme, style, customCss, questions: styleQuestionsOf(a.definition, trigger) });
    const result = await llmClient.chatForcedTool(modelId, messages, STYLE_TOOL, { maxTokens: STYLE_MAX_TOKENS, temperature: 0.4 });
    await logDraftUsage({ userId, userOrgId, modelId, usage: result?.usage, startMs, source: 'form_ai_style' });
    const answer = parseStyleAnswer(result?.structured || null);
    if (!answer) {
        throw new HttpError(502, 'ai_unusable', 'The model did not return usable CSS. Try again, or describe the look differently.');
    }
    return res.json(answer);
}

module.exports = { draft, styleAssist, limiter, resolveModel, orgIdOf, DraftBody };
