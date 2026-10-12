/**
 * Whole-automation actions and the Builder header's tab counts (Studio →
 * Automations handoff 5, artboards 5a/5b/5e).
 *
 *   POST /:id/duplicate            a new draft "<title> (copy)", no runs   (view)
 *   POST /:id/save-as-template     the automation as an organisation template (edit)
 *   POST /:id/suggest-description  one or two plain sentences from the steps (edit)
 *   GET  /:id/counts               { runs7d, runsFailed7d, versions, pendingChanges } (run)
 *
 * Every path has a literal second segment, so the mount position in
 * routes/automation.js is free. Built by a factory so a test hands in its own
 * store, access guard and model call; the default router uses the real ones,
 * required lazily.
 *
 * PRIVACY. A duplicate keeps the steps (the caller could read them), but not
 * the link back to an app button. A template is shared with the whole
 * organisation, so it goes through the export sanitiser: pinned samples, the
 * saved test input, credentials, approvers and table/knowledge-base ids are
 * cleared, exactly as a downloaded export. The description suggestion sends
 * the model the deterministic step summary and the step names, never run data.
 */

'use strict';

const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const { makeGuardedLoad } = require('./guardedLoad');

const NoQuery = z.object({}).strict();
const NoBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());

const TEMPLATE_TITLE_TEXT = 'title is the template name (1 to 120 characters).';
const TEMPLATE_DESCRIPTION_TEXT = 'description is at most 500 characters, or null.';
const SaveAsTemplateBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    title: z.string({ invalid_type_error: TEMPLATE_TITLE_TEXT }).trim().min(1, TEMPLATE_TITLE_TEXT).max(120, TEMPLATE_TITLE_TEXT).optional(),
    description: z.string({ invalid_type_error: TEMPLATE_DESCRIPTION_TEXT }).trim().max(500, TEMPLATE_DESCRIPTION_TEXT).nullish(),
}).strict());

const LANGUAGE_TEXT = 'language is a language code such as "en" or "nl".';
const SuggestBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    language: z.string({ invalid_type_error: LANGUAGE_TEXT }).trim().regex(/^[a-z]{2}(-[A-Za-z]{2})?$/, LANGUAGE_TEXT).optional(),
}).strict());

const LANGUAGE_NAMES = { en: 'English', nl: 'Dutch', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian' };
const COPY_SUFFIX = ' (copy)';
const MAX_TITLE = 200;

/** Collapse whitespace, strip wrapping quotes, cap. */
function sanitiseSuggestion(raw) {
    return String(raw || '')
        .replace(/\s+/g, ' ')
        .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
        .slice(0, 400)
        .trim();
}

/** "<title> (copy)", kept under the title limit. */
function copyTitle(title) {
    const base = String(title || 'Automation').trim() || 'Automation';
    return base.length + COPY_SUFFIX.length > MAX_TITLE
        ? `${base.slice(0, MAX_TITLE - COPY_SUFFIX.length - 1)}…${COPY_SUFFIX}`
        : `${base}${COPY_SUFFIX}`;
}

/** The input for the description model: the step summary plus the names in run order. */
function describeForModel(automation, { summariseDefinition, stepNumbers }) {
    const def = automation.definition || {};
    const { summary } = summariseDefinition(def);
    const labels = [];
    const numbers = stepNumbers(def);
    const byId = new Map((Array.isArray(def.steps) ? def.steps : []).filter(Boolean).map((s) => [s.id, s]));
    for (const [id, n] of [...numbers.entries()].sort((a, b) => a[1] - b[1])) {
        const s = byId.get(id);
        if (s && typeof s.label === 'string' && s.label.trim()) labels.push(`${n}. ${s.label.trim().slice(0, 80)}`);
    }
    const name = String(automation.title || 'this automation').slice(0, 200);
    return `Name: ${name}\n\n${summary}${labels.length ? `\n\nStep names: ${labels.join('; ')}` : ''}`;
}

/** Reusable Steps and flowlets have their own library; these actions are for automations. */
function onlyAutomations(a) {
    if ((a.kind || 'automation') !== 'automation') {
        throw new HttpError(400, 'unsupported_kind', 'This works on automations only, not on reusable steps.');
    }
}

function realSteps(def) {
    return (Array.isArray(def?.steps) ? def.steps : []).filter((s) => s && s.type !== 'note');
}

/**
 * @param {{
 *   store?: object, access?: { guard: Function }, orgOf?: (req) => Promise<string|null>,
 *   provisionForm?: (a, def) => Promise<{ answers: any, usage: any[] }>,
 *   syncDatatableUsage?: Function, syncKbSources?: Function,
 *   validateApprovalAssignees?: (def, ownerId) => Promise<any[]>,
 *   chat?: (modelId, messages, opts) => Promise<{ content: string }>,
 *   resolveModel?: (tier, opts) => Promise<string>,
 *   limiter?: Function, log?: { warn: Function, error: Function },
 * }} [overrides]
 */
function makeActionsRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const log = overrides.log || require('../../telemetry/log');
    const { makeAutomationAccess, projectForViewer } = require('../../automation/access');
    const access = overrides.access || makeAutomationAccess(overrides.store ? { store: overrides.store } : {});
    const orgOf = overrides.orgOf
        || (async (req) => (await require('../../auth/datatableAccess').resolveDatatablePrincipal(req)).orgId);
    const provisionForm = overrides.provisionForm || ((a, def) => require('./versions').provisionForm(a, def));
    const syncUsage = overrides.syncDatatableUsage
        || ((...args) => require('../../automation/datatableUsageSync').syncDatatableUsage(...args));
    const syncKb = overrides.syncKbSources || ((...args) => require('../../core/kb/kbSourceSync').syncKbSources(...args));
    const validateAssignees = overrides.validateApprovalAssignees
        || ((def, ownerId) => require('../../automation/approvalService').validateApprovalAssignees(def, ownerId));
    const chat = overrides.chat || ((modelId, messages, opts) => require('../../core/llm/llmClient').chat(modelId, messages, opts));
    const resolveModel = overrides.resolveModel
        || ((tier, opts) => require('../../core/llm/modelResolver').resolveModelForTierName(tier, opts));
    const limiter = overrides.limiter
        || require('../../utils/perUserRateLimit').perUserRateLimit({ windowMs: 60_000, max: 10 });

    const load = makeGuardedLoad(store, access);

    router.post('/:id/duplicate', validate({ body: NoBody, query: NoQuery }), async (req, res) => {
        const loaded = await load(req, res, 'view');
        if (!loaded) return;
        const { a } = loaded;
        onlyAutomations(a);
        const userId = req.session.user.id;
        const { stripAppRefs } = require('../../automation/portability');
        const { triggerColumnsFromDefinition } = require('../../automation/triggerColumns');
        const definition = JSON.parse(JSON.stringify(a.definition || {}));
        // The app button runs the ORIGINAL; a copy that points back at it would
        // show a button it is not behind.
        const warnings = [];
        stripAppRefs(definition, warnings);
        const assigneeErrors = await validateAssignees(definition, userId);
        if (assigneeErrors.length) throw new HttpError(400, 'invalid_definition', 'This automation names an approver outside your organisation; change the approval step first.', assigneeErrors);
        const cols = triggerColumnsFromDefinition(definition);
        const organizationId = await orgOf(req);
        const created = await store().createAutomation({
            userId, organizationId,
            title: copyTitle(a.title),
            description: a.description || '',
            definition,
            triggerType: cols.triggerType || 'manual',
            scheduleCron: cols.scheduleCron ?? null,
            scheduleTz: cols.scheduleTz || 'Europe/Amsterdam',
            nextRunAt: null,
            versionMeta: {
                description: `Copied from "${a.title}"`,
                descriptionJson: [{ code: 'duplicated_from', params: { title: a.title, automationId: a.id } }],
            },
        });
        // Same folder and icon: plain column writes, no version.
        let copy = created;
        const extra = {};
        if (a.folderId) extra.folderId = a.folderId;
        if (a.icon) extra.icon = a.icon;
        if (Object.keys(extra).length) copy = (await store().updateAutomation(created.id, extra, userId)) || created;
        const { answers, usage } = await provisionForm(copy, definition);
        await syncUsage(copy.id, organizationId, definition, { label: 'automation duplicate', extraEntries: usage || [] });
        await syncKb(copy.id, definition, { userId, title: copy.title });
        res.json({
            automation: projectForViewer(copy, { role: 'owner', via: 'owner' }),
            duplicatedFrom: a.id,
            warnings,
            ...(answers ? { answers } : {}),
        });
    });

    router.post('/:id/save-as-template', validate({ body: SaveAsTemplateBody, query: NoQuery }), async (req, res) => {
        const loaded = await load(req, res, 'edit');
        if (!loaded) return;
        const { a } = loaded;
        onlyAutomations(a);
        const { buildExport } = require('../../automation/portability');
        const { orgTemplateCard } = require('../../automation/templates');
        const { envelope, warnings } = buildExport(a);
        const definition = envelope.automation.definition;
        if (!realSteps(definition).length) throw new HttpError(400, 'nothing_to_save', 'Add a step first; an empty automation makes no template.');
        const row = await store().createAutomationTemplate({
            organizationId: await orgOf(req),
            createdBy: req.session.user.id,
            title: req.body.title || a.title || 'Automation',
            description: req.body.description !== undefined ? (req.body.description || null) : (a.description || null),
            icon: a.icon || null,
            definition,
        });
        res.json({ template: orgTemplateCard(row), warnings });
    });

    router.post('/:id/suggest-description', limiter, validate({ body: SuggestBody, query: NoQuery }), async (req, res) => {
        const loaded = await load(req, res, 'edit');
        if (!loaded) return;
        const { a } = loaded;
        if (!realSteps(a.definition).length) {
            throw new HttpError(400, 'nothing_to_describe', 'Add a step first; there is nothing to describe yet.');
        }
        const { summariseDefinition } = require('../../automation/summarise');
        const { stepNumbers } = require('../../automation/fieldDiff');
        const input = describeForModel(a, { summariseDefinition, stepNumbers });
        const language = LANGUAGE_NAMES[(req.body.language || 'en').slice(0, 2)] || 'English';
        const userId = req.session.user.id;
        const modelId = await resolveModel('fast', { userOrgId: await orgOf(req), userId, fallback: 'gemini-2.0-flash-lite' });
        const sys = 'You write the description of an automation for its settings page: one or two plain sentences '
            + '(at most about 40 words) for a non-technical colleague. Say what it does and when it starts, not which '
            + `step types it uses. Write in ${language}. Output only the sentences: no preamble, no markdown, no quotes, no dashes as punctuation.`;
        let result;
        try {
            result = await chat(modelId, [
                { role: 'system', content: sys },
                { role: 'user', content: input },
            ], { maxTokens: 160, temperature: 0.3, reasoningEffort: 'none', budgetTokens: 0 });
        } catch (e) {
            log.error('[automation suggest-description] inference failed:', e.message);
            throw new HttpError(502, 'suggestion_failed', 'Bee could not suggest a description right now. Please try again.');
        }
        const description = sanitiseSuggestion(result?.content);
        if (!description) throw new HttpError(502, 'suggestion_failed', 'Bee could not suggest a description right now. Please try again.');
        res.json({ description });
    });

    router.get('/:id/counts', validate({ query: NoQuery }), async (req, res) => {
        const loaded = await load(req, res, 'run');
        if (!loaded) return;
        const { a, acc } = loaded;
        // A run-only share sees only the runs it started (automation/access.js).
        const onlyUserId = acc.role === 'run' ? req.session.user.id : null;
        const counts = await store().countsForAutomation(a.id, { days: 7, onlyUserId });
        res.json({ ...counts, pendingChanges: a.pendingChanges ?? 0 });
    });

    return router;
}

module.exports = { makeActionsRouter, copyTitle, sanitiseSuggestion, describeForModel };
