/**
 * Language Routes — Admin API for managing i18n locales, GUI translations, and prompt translations
 * 
 * All admin routes require authentication + admin permissions.
 * User-facing routes (GET effective strings) require only authentication.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const languageStore = require('../../stores/languageStore');
const { PROMPT_IDS, PROMPT_LABELS, PROMPT_CATEGORIES, getAllDefaults } = require('../../i18n/defaults/promptDefaults');
const { GUI_DEFAULTS, getGUINamespaces } = require('../../i18n/defaults/en');
const {
    EMAIL_TEMPLATE_IDS, EMAIL_TEMPLATE_FIELDS, EMAIL_TEMPLATE_VARIABLES,
    EMAIL_TEMPLATE_LABELS, EMAIL_TEMPLATE_DEFAULTS,
} = require('../../i18n/defaults/emailTemplates');

// ── Middleware ───────────────────────────────────────────────────

const { hasPermission } = require('../../auth/permissions');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth, getUserPermissions } = require('../../auth/permissions');
const { validate } = require('../../core/http/validate');
const { z } = require('zod');

// -- What a caller may send ------------------------------------------
//
// The guards here were `typeof x === 'object'`, which an ARRAY passes, and
// `if (!code || !name)`, which a number passes. Three things came out of that:
//
//   - `PUT /:code/gui` with `translations: []` replaced a locale's whole
//     string table with an array. Every key then read as missing, so the
//     locale fell back to English -- the translations were gone, answered
//     with `{ success: true }`;
//   - `PUT /:code/prompts/:id` with `text: 42` stored the number as that
//     locale's system prompt, and answered `{ success: true }`;
//   - `POST /:code/ai-translate-prompts` with a misspelled id in `promptIds`
//     matched no prompt, so the run answered "All prompts are already
//     translated" and translated nothing.
//
// One body stays OPEN on purpose and says so where it is registered:
// `POST /:code/import` IS the export document, whatever shape it was
// exported in.

/** A string whose every refusal -- including "you left it out" -- is a sentence. */
const worded = (message) => z.string({ required_error: message, invalid_type_error: message });

/** A body that also accepts no body at all: Express 5 leaves `req.body` undefined then. */
const bodyOf = (shape) => z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object(shape).strict());

/** A key -> string map. `z.record` refuses an array, which `typeof` did not. */
const stringMap = (name, value) => {
    const text = `${name} is a map of keys to strings.`;
    return z.record(worded(text), value(text), { required_error: text, invalid_type_error: text });
};

const CODE_TEXT = 'A locale needs a code, like "nl" or "pt-BR".';
const NAME_TEXT = 'A locale needs a name.';
const AddLocaleBody = bodyOf({
    code: worded(CODE_TEXT).trim().regex(/^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/, CODE_TEXT),
    name: worded(NAME_TEXT).trim().min(1, NAME_TEXT).max(80, 'A locale name is at most 80 characters.'),
});

const GuiBody = bodyOf({ translations: stringMap('translations', (t) => worded(t)) });
// A key set to '' or null is a RESET to the English default -- the one place
// a null belongs in a translation map.
const GuiPatchBody = bodyOf({ updates: stringMap('updates', (t) => worded(t).nullable()) });

const TEMPLATE_TEXT = `templateId is one of: ${EMAIL_TEMPLATE_IDS.join(', ')}.`;
const TemplateId = z.enum(EMAIL_TEMPLATE_IDS, { errorMap: () => ({ message: TEMPLATE_TEXT }) });
/**
 * The template's own fields, and only those. A misspelled field name used to
 * be dropped by the store's own allow-list and answered with the saved row,
 * so the edit simply did not happen.
 */
const TemplateFields = z.object(Object.fromEntries(
    EMAIL_TEMPLATE_FIELDS.map((f) => [f, worded(`${f} must be text.`).optional()]),
)).strict();
const EmailTemplateBody = bodyOf({ templateId: TemplateId, fields: TemplateFields });
const EmailPreviewBody = bodyOf({ fields: TemplateFields.optional() });

const RECIPIENT_TEXT = 'Send the test letter to an e-mail address.';
const EmailTestBody = bodyOf({ testRecipient: worded(RECIPIENT_TEXT).trim().email(RECIPIENT_TEXT) });

// The tier vocabulary is the workspace's own (chat_model_tiers, plus org
// custom tiers), so it is not an enum here -- only "a tier is a name".
const TIER_TEXT = 'modelTier is the name of a model tier.';
const modelTier = () => worded(TIER_TEXT).trim().min(1, TIER_TEXT).optional();
const TranslateBody = bodyOf({ modelTier: modelTier() });
const PROMPTS_TEXT = `promptIds names prompts this install has: ${PROMPT_IDS.slice(0, 3).join(', ')}, ...`;
const TranslatePromptsBody = bodyOf({
    modelTier: modelTier(),
    promptIds: z.array(
        worded(PROMPTS_TEXT).refine((v) => PROMPT_IDS.includes(v), (v) => ({ message: `"${v}" is not a prompt this install has.` })),
        { invalid_type_error: PROMPTS_TEXT },
    ).optional(),
});

const TEXT_TEXT = 'text is the translated prompt, or empty to fall back to the default.';
const PromptTextBody = bodyOf({ text: worded(TEXT_TEXT).nullish() });

const DEFAULT_LOCALE_TEXT = 'defaultLocale is the code of a configured locale.';
const OrgDefaultBody = bodyOf({ defaultLocale: worded(DEFAULT_LOCALE_TEXT).trim().min(1, DEFAULT_LOCALE_TEXT) });

async function requireAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
    // Check RBAC permissions
    const userId = req.session.user?.id;
    if (userId && await hasPermission(userId, 'all', req.session)) return next();
    return res.status(403).json({ error: 'Admin access required' });
}

// ══════════════════════════════════════════════════════════════════
// ADMIN ROUTES (require admin)
// ══════════════════════════════════════════════════════════════════

// ── Locale Management ───────────────────────────────────────────

// GET /admin/languages — List all configured locales
router.get('/', requireAdmin, async (req, res) => {
    const locales = await languageStore.getAvailableLocales();
    res.json({
        locales,
        catalog: languageStore.AVAILABLE_LOCALE_CATALOG,
    });
});

// POST /admin/languages — Add a new locale
router.post('/', requireAdmin, validate({ body: AddLocaleBody }), async (req, res) => {
    try {
        const { code, name } = req.body;
        const locales = await languageStore.addLocale(code.toLowerCase(), name);
        res.json({ success: true, locales });
    } catch (err) {
        log.error('[Languages] Add error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// DELETE /admin/languages/:code — Delete a locale and all its translations
router.delete('/:code', requireAdmin, async (req, res) => {
    try {
        const locales = await languageStore.deleteLocale(req.params.code);
        res.json({ success: true, locales });
    } catch (err) {
        log.error('[Languages] Delete error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// PUT /admin/languages/:code/default — Set a locale as the default
//
// `/org/default` at the bottom of this file is a FIXED path, and THIS one is
// parameterised and registered first — so every `PUT /api/languages/org/default`
// landed here with code='org' and answered `Locale 'org' not found`, while the
// org default for new users was never written. An org admin, who is not a
// platform admin, got requireAdmin's 403 instead. Hand that one path on.
router.put('/:code/default', (req, res, next) => (req.params.code === 'org' ? next('route') : next()), requireAdmin, async (req, res) => {
    try {
        const locales = await languageStore.setDefaultLocale(req.params.code);
        res.json({ success: true, locales });
    } catch (err) {
        log.error('[Languages] Set default error:', err.message);
        res.status(400).json({ error: err.message });
    }
});

// ── GUI Translations ────────────────────────────────────────────

// GET /admin/languages/defaults/gui — Get English default GUI strings
router.get('/defaults/gui', requireAdmin, async (req, res) => {
    res.json({
        defaults: GUI_DEFAULTS,
        namespaces: getGUINamespaces(),
        totalKeys: Object.keys(GUI_DEFAULTS).length,
    });
});

// GET /admin/languages/:code/gui — Get GUI translations for a locale
router.get('/:code/gui', requireAdmin, async (req, res) => {
    const translations = await languageStore.getGUITranslations(req.params.code);
    const totalKeys = Object.keys(GUI_DEFAULTS).length;
    const translatedKeys = Object.keys(translations).length;

    res.json({
        translations,
        defaults: GUI_DEFAULTS,
        namespaces: getGUINamespaces(),
        stats: {
            total: totalKeys,
            translated: translatedKeys,
            missing: totalKeys - translatedKeys,
            progress: totalKeys > 0 ? Math.round((translatedKeys / totalKeys) * 100) : 0,
        },
    });
});

// PUT /admin/languages/:code/gui — Save GUI translations for a locale
router.put('/:code/gui', requireAdmin, validate({ body: GuiBody }), async (req, res) => {
    const { translations } = req.body;
    await languageStore.setGUITranslations(req.params.code, translations);
    res.json({ success: true });
});

// PATCH /admin/languages/:code/gui — Update individual GUI translations (merge)
router.patch('/:code/gui', requireAdmin, validate({ body: GuiPatchBody }), async (req, res) => {
    const { updates } = req.body; // { "key": "value", ... }
    const existing = await languageStore.getGUITranslations(req.params.code);
    const merged = { ...existing, ...updates };

    // Remove keys set to empty string (treat as "reset to default")
    for (const [key, val] of Object.entries(updates)) {
        if (val === '' || val === null) delete merged[key];
    }

    await languageStore.setGUITranslations(req.params.code, merged);
    res.json({ success: true, translations: merged });
});

// ── Email Templates (verification + welcome) ─────────────────────
// Per-locale, structured-field transactional email templates. Stored as
// overrides; getEffectiveEmailTemplate merges per-field over the English
// defaults so a partially translated locale still renders.

// GET /admin/languages/:code/email-templates — overrides + defaults + meta
router.get('/:code/email-templates', requireAdmin, async (req, res) => {
    const code = req.params.code;
    const templates = await languageStore.getAllEmailTemplates(code);
    // Per-template effective view (defaults merged with this locale's overrides).
    const effective = {};
    for (const id of EMAIL_TEMPLATE_IDS) {
        effective[id] = await languageStore.getEffectiveEmailTemplate(id, code);
    }
    res.json({
        templates,            // raw overrides for this locale
        effective,            // defaults + overrides, per template
        defaults: EMAIL_TEMPLATE_DEFAULTS,
        templateIds: EMAIL_TEMPLATE_IDS,
        fields: EMAIL_TEMPLATE_FIELDS,
        variables: EMAIL_TEMPLATE_VARIABLES,
        labels: EMAIL_TEMPLATE_LABELS,
    });
});

// PUT /admin/languages/:code/email-templates — save one template's fields
// (empty/blank field = reset that field to the English default)
router.put('/:code/email-templates', requireAdmin, validate({ body: EmailTemplateBody }), async (req, res) => {
    const { templateId, fields } = req.body;
    const templates = await languageStore.setEmailTemplate(req.params.code, templateId, fields);
    res.json({ success: true, templates });
});

// POST /admin/languages/:code/email-templates/:templateId/preview
// Render a branded HTML preview WITHOUT sending. Accepts optional in-progress
// `fields` in the body so the admin sees unsaved edits; otherwise uses the
// effective (saved/merged) template.
router.post('/:code/email-templates/:templateId/preview', requireAdmin, validate({ body: EmailPreviewBody }), async (req, res) => {
    const { code, templateId } = req.params;
    if (!EMAIL_TEMPLATE_IDS.includes(templateId)) {
        return res.status(400).json({ error: 'Unknown templateId' });
    }
    const { renderEmailFromTemplate, welcomeLearnUrl } = require('../../utils/emailService');
    const base = await languageStore.getEffectiveEmailTemplate(templateId, code);
    // Merge in-progress fields (non-empty) over the effective template.
    const incoming = req.body.fields || {};
    const tpl = { ...base };
    for (const f of EMAIL_TEMPLATE_FIELDS) {
        if (typeof incoming[f] === 'string' && incoming[f].trim()) tpl[f] = incoming[f];
    }
    const clientHost = require('../../utils/appPaths').clientHost();
    const vars = {
        name: 'Alex Example',
        orgName: 'Bee Flow',
        ...(templateId === 'verification' ? { verifyUrl: `${clientHost}/auth/verify-email/preview` } : { loginUrl: clientHost }),
        // The Learning Center link, filled the way sendWelcomeEmail fills it
        // (BFSF-279); without it the preview showed "explore it here:" and nothing.
        ...(templateId === 'welcome' ? { learnUrl: welcomeLearnUrl() } : {}),
    };
    const { subject, html } = renderEmailFromTemplate(tpl, vars);
    res.json({ subject, html });
});

// POST /admin/languages/:code/email-templates/:templateId/test
// Send the REAL rendered template to a recipient for a true end-to-end check.
router.post('/:code/email-templates/:templateId/test', requireAdmin, validate({ body: EmailTestBody }), async (req, res) => {
    const { code, templateId } = req.params;
    const { testRecipient } = req.body;
    if (!EMAIL_TEMPLATE_IDS.includes(templateId)) {
        return res.status(400).json({ error: 'Unknown templateId' });
    }
    const clientHost = require('../../utils/appPaths').clientHost();
    const { sendVerificationEmail, sendWelcomeEmail } = require('../../utils/emailService');
    const common = { email: testRecipient, displayName: 'Alex Example', orgName: 'Bee Flow', locale: code };
    const result = templateId === 'verification'
        ? await sendVerificationEmail({ ...common, verifyUrl: `${clientHost}/auth/verify-email/preview` })
        : await sendWelcomeEmail({ ...common, loginUrl: clientHost });
    if (result.success) return res.json({ success: true, messageId: result.messageId });
    return res.status(500).json({ error: result.error || 'Failed to send test email' });
});

// POST /admin/languages/:code/ai-translate-emails — AI-translate the email
// template fields for a locale (preserves {{variables}}). Mirrors the GUI
// ai-translate handler.
router.post('/:code/ai-translate-emails', requireAdmin, validate({ body: TranslateBody }), async (req, res) => {
    const locale = req.params.code;
    const { modelTier = 'fast' } = req.body;
    if (locale === 'en') {
        return res.status(400).json({ error: 'Cannot AI-translate the base English locale' });
    }
    const llmClient = require('../../core/llm/llmClient');
        const { resolveModelForTierName } = require('../../core/llm/modelResolver');

        let modelId;
        try {
            modelId = await resolveModelForTierName(modelTier || 'fast', { fallback: 'mistral-small-latest' });
        } catch (_) {
            const { getAIConfig } = require('../../core/aiAgent');
            modelId = (await getAIConfig()).model || 'mistral-small-latest';
        }

        const locales = await languageStore.getAvailableLocales();
        const languageName = (locales.find(l => l.code === locale)?.name) || locale;

        const systemPrompt = `You are a professional translator. Translate the following English transactional-email fields to ${languageName} (${locale}).
Return ONLY a valid JSON object with the same shape: { "<templateId>": { "subject": "...", "title": "...", "intro": "...", "body": "...", "ctaLabel": "..." }, ... }.
Keep it natural and concise — these are customer emails.
CRITICAL: preserve placeholder tokens EXACTLY as written, e.g. {{name}}, {{orgName}}, {{verifyUrl}}, {{loginUrl}}. Do not translate or alter them.
Do NOT translate the JSON keys (templateId / field names), only the values.
Do NOT add explanation, markdown, or code fences — output raw JSON only.`;

        const payload = {};
        for (const id of EMAIL_TEMPLATE_IDS) payload[id] = EMAIL_TEMPLATE_DEFAULTS[id];

        const result = await llmClient.chat(modelId, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: JSON.stringify(payload, null, 2) },
        ], { maxTokens: 2048, temperature: 0.3 });

        let responseText = (result.content || '').trim();
        responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
        const translated = JSON.parse(responseText);

        let count = 0;
        for (const id of EMAIL_TEMPLATE_IDS) {
            const t = translated[id];
            if (!t || typeof t !== 'object') continue;
            const fields = {};
            for (const f of EMAIL_TEMPLATE_FIELDS) {
                if (typeof t[f] === 'string' && t[f].trim()) fields[f] = t[f];
            }
            if (Object.keys(fields).length) {
                await languageStore.setEmailTemplate(locale, id, fields);
                count++;
            }
        }
        res.json({ success: true, translated: count, message: `Translated ${count} email template(s)` });
});

// ── AI Translation ──────────────────────────────────────────────

// POST /admin/languages/:code/ai-translate — Use AI to auto-translate GUI strings
router.post('/:code/ai-translate', requireAdmin, validate({ body: TranslateBody }), async (req, res) => {
    const locale = req.params.code;
    const { modelTier = 'fast' } = req.body;

    if (locale === 'en') {
        return res.status(400).json({ error: 'Cannot AI-translate the base English locale' });
    }

    const llmClient = require('../../core/llm/llmClient');
        const { resolveModelForTierName } = require('../../core/llm/modelResolver');

        // ── Resolve model from tier (centralized, admin context — no EU override) ─────────
        const resolvedTier = modelTier || 'fast';
        let modelId;
        try {
            modelId = await resolveModelForTierName(resolvedTier, { fallback: 'mistral-small-latest' });
        } catch (_) {
            const { getAIConfig } = require('../../core/aiAgent');
            const config = await getAIConfig();
            modelId = config.model || 'mistral-small-latest';
        }

        log.info(`[Languages AI] Translating to ${locale} using model ${modelId} (tier: ${resolvedTier})`);

        // ── Gather untranslated keys ────────────────────────────────
        const existing = await languageStore.getGUITranslations(locale);
        const allKeys = Object.keys(GUI_DEFAULTS);
        const untranslated = allKeys.filter(key => !existing[key]);

        if (untranslated.length === 0) {
            return res.json({ success: true, translated: 0, total: allKeys.length, message: 'All keys are already translated' });
        }

        // ── Resolve locale name ─────────────────────────────────────
        const locales = await languageStore.getAvailableLocales();
        const localeInfo = locales.find(l => l.code === locale);
        const languageName = localeInfo?.name || locale;

        // ── Batch translate ─────────────────────────────────────────
        const BATCH_SIZE = 40;
        const batches = [];
        for (let i = 0; i < untranslated.length; i += BATCH_SIZE) {
            batches.push(untranslated.slice(i, i + BATCH_SIZE));
        }

        let translatedCount = 0;
        let errors = 0;
        const merged = { ...existing };

        const systemPrompt = `You are a professional translator. Translate the following English UI strings to ${languageName} (${locale}).
Return ONLY a valid JSON object mapping each key to its translated value.
Keep translations concise — these are UI labels, buttons, and short messages.
Preserve any placeholder tokens like {name}, {count}, etc.
Do NOT translate keys, only values.
For keys whose name contains "placeholder_" the value is an example shown as a form-field hint. Localize these examples to match the conventions of the target locale's primary country: phone numbers in local dialling format, addresses in local format, email domains, and tax/registration IDs (e.g. VAT/KVK) in the local equivalent. Keep company names that are proper nouns (e.g. "Bee Flow B.V.") unchanged.
Do NOT add any explanation, markdown formatting, or code fences — output raw JSON only.`;

        // Run all batches in parallel
        const batchResults = await Promise.allSettled(batches.map(async (batch, batchIdx) => {
            const batchObj = {};
            for (const key of batch) {
                batchObj[key] = GUI_DEFAULTS[key];
            }

            const result = await llmClient.chat(modelId, [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: JSON.stringify(batchObj, null, 2) },
            ], { maxTokens: 4096, temperature: 0.3 });

            // Parse the response — handle possible markdown code fences
            let responseText = (result.content || '').trim();
            responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

            const translations = JSON.parse(responseText);
            log.info(`[Languages AI] Batch ${batchIdx + 1}/${batches.length}: ${Object.keys(translations).length} translations`);
            return translations;
        }));

        // Merge all results
        for (const result of batchResults) {
            if (result.status === 'fulfilled') {
                for (const [key, value] of Object.entries(result.value)) {
                    if (typeof value === 'string' && value.trim() && GUI_DEFAULTS[key]) {
                        merged[key] = value;
                        translatedCount++;
                    }
                }
            } else {
                log.error(`[Languages AI] Batch failed:`, result.reason?.message);
                errors++;
            }
        }

        // ── Save merged translations ────────────────────────────────
        await languageStore.setGUITranslations(locale, merged);

        const totalKeys = allKeys.length;
        const totalTranslated = Object.keys(merged).length;

        log.info(`[Languages AI] Done: ${translatedCount} new translations for ${locale} (${errors} batch errors)`);

        res.json({
            success: true,
            translated: translatedCount,
            total: totalKeys,
            totalTranslated,
            progress: totalKeys > 0 ? Math.round((totalTranslated / totalKeys) * 100) : 0,
            errors,
            message: errors > 0
                ? `Translated ${translatedCount} strings with ${errors} batch error(s)`
                : `Successfully translated ${translatedCount} strings`,
        });
});

// POST /admin/languages/:code/ai-translate-prompts — Use AI to auto-translate system prompts
router.post('/:code/ai-translate-prompts', requireAdmin, validate({ body: TranslatePromptsBody }), async (req, res) => {
    const locale = req.params.code;
    const { modelTier = 'fast', promptIds: requestedIds } = req.body;

    if (locale === 'en') {
        return res.status(400).json({ error: 'Cannot AI-translate the base English locale' });
    }

    const llmClient = require('../../core/llm/llmClient');
        const { resolveModelForTierName } = require('../../core/llm/modelResolver');

        // ── Resolve model ───────────────────────────────────────────
        const resolvedTier = modelTier || 'fast';
        let modelId;
        try {
            modelId = await resolveModelForTierName(resolvedTier, { fallback: 'mistral-small-latest' });
        } catch (_) {
            const { getAIConfig } = require('../../core/aiAgent');
            const config = await getAIConfig();
            modelId = config.model || 'mistral-small-latest';
        }

        log.info(`[Languages AI] Translating prompts to ${locale} using model ${modelId} (tier: ${resolvedTier})`);

        // ── Resolve locale name ─────────────────────────────────────
        const locales = await languageStore.getAvailableLocales();
        const localeInfo = locales.find(l => l.code === locale);
        const languageName = localeInfo?.name || locale;

        // ── Gather untranslated prompts ──────────────────────────────
        const existingTranslations = await languageStore.getAllPromptTranslations(locale);
        const defaults = await getAllDefaults();
        const idsToTranslate = (requestedIds || PROMPT_IDS).filter(id =>
            !existingTranslations[id] && defaults[id]
        );

        if (idsToTranslate.length === 0) {
            return res.json({ success: true, translated: 0, total: PROMPT_IDS.length, message: 'All prompts are already translated' });
        }

        // ── Translate each prompt individually (they are long-form) ──
        const systemPrompt = `You are a professional translator specializing in AI system prompts and technical documentation.
Translate the following system prompt from English to ${languageName} (${locale}).

RULES:
- Translate the ENTIRE prompt faithfully. Do not summarize or skip sections.
- Preserve ALL Markdown formatting (headings, lists, bold, code blocks, etc).
- Preserve placeholder tokens like {name}, {count}, {{variable}}, etc — do NOT translate these.
- Preserve technical terms, tool names, function names, and API references exactly as-is (e.g. "notebook_read", "json-research", "vega-lite").
- Keep code examples and JSON structures unchanged.
- Maintain the same tone and instruction style.
- Output ONLY the translated prompt text — no explanations, no wrapping, no code fences.`;

        let translatedCount = 0;
        let errors = 0;

        // Process prompts in parallel (max 3 concurrent to avoid rate limits)
        const CONCURRENCY = 3;
        for (let i = 0; i < idsToTranslate.length; i += CONCURRENCY) {
            const batch = idsToTranslate.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(batch.map(async (promptId) => {
                const defaultText = defaults[promptId];
                if (!defaultText || defaultText.trim().length < 10) return null; // Skip empty/tiny prompts

                const result = await llmClient.chat(modelId, [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: defaultText },
                ], { maxTokens: 8192, temperature: 0.3 });

                const translated = (result.content || '').trim();
                if (translated && translated.length > 20) {
                    await languageStore.setPromptTranslation(locale, promptId, translated);
                    log.info(`[Languages AI] Translated prompt "${promptId}" (${translated.length} chars)`);
                    return promptId;
                }
                return null;
            }));

            for (const result of results) {
                if (result.status === 'fulfilled' && result.value) {
                    translatedCount++;
                } else if (result.status === 'rejected') {
                    log.error(`[Languages AI] Prompt translation failed:`, result.reason?.message);
                    errors++;
                }
            }
        }

        // ── Clear prompt cache ──────────────────────────────────────
        const { clearDefaultsCache } = require('../../i18n/defaults/promptDefaults');
        clearDefaultsCache();

        const totalPrompts = PROMPT_IDS.filter(id => defaults[id]).length;
        const totalTranslated = Object.keys(existingTranslations).length + translatedCount;

        log.info(`[Languages AI] Prompt translation done: ${translatedCount} new for ${locale} (${errors} errors)`);

        res.json({
            success: true,
            translated: translatedCount,
            total: totalPrompts,
            totalTranslated,
            progress: totalPrompts > 0 ? Math.round((totalTranslated / totalPrompts) * 100) : 0,
            errors,
            message: errors > 0
                ? `Translated ${translatedCount} prompts with ${errors} error(s)`
                : `Successfully translated ${translatedCount} prompts`,
        });
});

// ── Prompt Translations ─────────────────────────────────────────

// GET /admin/languages/defaults/prompts — Get all default prompt texts
router.get('/defaults/prompts', requireAdmin, async (req, res) => {
    const defaults = await getAllDefaults();
    res.json({
        defaults,
        labels: PROMPT_LABELS,
        categories: PROMPT_CATEGORIES,
        promptIds: PROMPT_IDS,
    });
});

// GET /admin/languages/:code/prompts — Get all prompt translations for a locale
router.get('/:code/prompts', requireAdmin, async (req, res) => {
    const translations = await languageStore.getAllPromptTranslations(req.params.code);
    const defaults = await getAllDefaults();

    res.json({
        translations,
        defaults,
        labels: PROMPT_LABELS,
        categories: PROMPT_CATEGORIES,
        promptIds: PROMPT_IDS,
        stats: {
            total: PROMPT_IDS.length,
            translated: Object.keys(translations).length,
            missing: PROMPT_IDS.length - Object.keys(translations).length,
        },
    });
});

// GET /admin/languages/:code/prompts/:promptId — Get a single prompt translation
router.get('/:code/prompts/:promptId', requireAdmin, async (req, res) => {
    const { code, promptId } = req.params;
    const translation = await languageStore.getPromptTranslation(code, promptId);
    const { getDefaultPrompt } = require('../../i18n/defaults/promptDefaults');
    const defaultText = await getDefaultPrompt(promptId);

    res.json({
        promptId,
        label: PROMPT_LABELS[promptId] || promptId,
        translation: translation || '',
        default: defaultText || '',
        hasTranslation: !!translation,
    });
});

// PUT /admin/languages/:code/prompts/:promptId — Save a single prompt translation
router.put('/:code/prompts/:promptId', requireAdmin, validate({ body: PromptTextBody }), async (req, res) => {
    const { code, promptId } = req.params;
    const { text } = req.body;

    if (!PROMPT_IDS.includes(promptId)) {
        return res.status(400).json({ error: `Unknown prompt ID: ${promptId}` });
    }

    if (text === '' || text === null || text === undefined) {
        // Empty = remove translation (fall back to default)
        const configStore = require('../../stores/configStore');
        await configStore.deleteConfig(`i18n_prompt_${code}_${promptId}`);
    } else {
        await languageStore.setPromptTranslation(code, promptId, text);
    }

    // Clear prompt cache so changes take effect immediately
    const { clearDefaultsCache } = require('../../i18n/defaults/promptDefaults');
    clearDefaultsCache();

    res.json({ success: true });
});

// ── Import / Export ─────────────────────────────────────────────

// GET /admin/languages/:code/export — Export locale as JSON
router.get('/:code/export', requireAdmin, async (req, res) => {
    const data = await languageStore.exportLocale(req.params.code);
    res.setHeader('Content-Disposition', `attachment; filename="beeflow-i18n-${req.params.code}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(data);
});

// POST /admin/languages/:code/import — Import locale from JSON
// LEFT OPEN on purpose: the body IS the document GET /:code/export produced,
// whatever shape that export had. languageStore.importLocale reads the parts
// it knows; a schema here would refuse last year's export file.
router.post('/:code/import', requireAdmin, async (req, res) => {
    const data = req.body;
    if (!data || typeof data !== 'object') {
        return res.status(400).json({ error: 'Invalid import data' });
    }
    const result = await languageStore.importLocale(req.params.code, data);
    res.json({ success: true, ...result });
});

// ══════════════════════════════════════════════════════════════════
// ORG ADMIN ROUTES (require org admin or platform admin)
// ══════════════════════════════════════════════════════════════════

// Permissions are resolved from the DATABASE, not read off the session.
//
// An SSO session's `user` object carries only { id, email, picture, firstName,
// lastName, displayName, provider } — no `permissions` and no `orgRole`. Reading
// those fields off the session therefore evaluated `[]` and `undefined` for
// every SSO user, so a genuine organisation admin got a 403 on their own
// organisation's language settings. getUserPermissions() unions the orgRole →
// permission mapping (config/orgRoles.json), so an org_admin resolves to a set
// containing 'org_admin'; the predicate below is otherwise unchanged.
async function requireOrgAdmin(req, res, next) {
    if (!req.session?.user) return res.status(401).json({ error: 'Unauthorized' });
    // Platform admin can always manage
    if (req.session.isAdmin || req.session.user?.role === 'admin') return next();
    try {
        const perms = await getUserPermissions(req.session.user.id, req.session);
        if (perms.includes('all') || perms.includes('org_admin') || perms.some(p => p.startsWith('admin_'))) {
            return next();
        }
    } catch (err) {
        log.error('[Languages] org admin check failed:', err.message);
        return res.status(500).json({ error: 'Authorization check failed' });
    }
    res.status(403).json({ error: 'Organisation admin access required' });
}

// GET /api/languages/org/default — Get the org default locale for new users
router.get('/org/default', requireOrgAdmin, async (req, res) => {
    const configStore = require('../../stores/configStore');
    const defaultLocale = await configStore.getConfig('org_default_locale') || 'en';
    const locales = await languageStore.getAvailableLocales();
    res.json({ defaultLocale, locales });
});

// PUT /api/languages/org/default — Set the org default locale for new users
router.put('/org/default', requireOrgAdmin, validate({ body: OrgDefaultBody }), async (req, res) => {
    const { defaultLocale } = req.body;
    // Validate that the locale exists
    const locales = await languageStore.getAvailableLocales();
    if (!locales.find(l => l.code === defaultLocale)) {
        return res.status(400).json({ error: `Locale '${defaultLocale}' is not available` });
    }
    const configStore = require('../../stores/configStore');
    await configStore.setConfig('org_default_locale', defaultLocale);
    log.info(`[Languages] Org default locale set to: ${defaultLocale}`);
    res.json({ success: true, defaultLocale });
});

// ══════════════════════════════════════════════════════════════════
// USER-FACING ROUTES (require only auth)
// ══════════════════════════════════════════════════════════════════

// GET /api/languages/user/locales — Get available locales for language picker
router.get('/user/locales', requireAuth, async (req, res) => {
    const locales = await languageStore.getAvailableLocales();
    // Include org default locale info so the frontend can use it for new users
    const configStore = require('../../stores/configStore');
    const defaultLocale = await configStore.getConfig('org_default_locale') || null;
    // Attach default info to the response — the frontend already expects an array,
    // so we annotate each locale with isOrgDefault
    const withDefaults = locales.map(l => ({
        ...l,
        isOrgDefault: l.code === defaultLocale,
    }));
    res.json(withDefaults);
});

// GET /api/languages/user/strings/:locale — Get effective GUI strings for a locale
router.get('/user/strings/:locale', requireAuth, async (req, res) => {
    const strings = await languageStore.getEffectiveGUIStrings(req.params.locale);
    res.json(strings);
});

// ── Public (no-auth) endpoints for pre-login language detection ───

// GET /api/languages/public/locales — List available locales without auth
// Used by login page language picker
router.get('/public/locales', async (req, res) => {
    const locales = await languageStore.getAvailableLocales();
    res.set('Cache-Control', 'public, max-age=600');
    res.json(locales.map(l => ({ code: l.code, name: l.name })));
});

// GET /api/languages/public/strings/:locale — Get effective GUI strings without auth
// Used by the login page to serve translations before user authenticates
router.get('/public/strings/:locale', async (req, res) => {
    const locale = req.params.locale;
    // Only serve locales that are actually configured
    const locales = await languageStore.getAvailableLocales();
    if (!locales.find(l => l.code === locale)) {
        return res.status(404).json({ error: 'Locale not available' });
    }
    const strings = await languageStore.getEffectiveGUIStrings(locale);
    res.set('Cache-Control', 'public, max-age=600');
    res.json(strings);
});

module.exports = router;
