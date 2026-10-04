/**
 * The AI Act check and the "Ready to activate?" checklist of one automation
 * (Studio → Automations handoff 5, settings page).
 *
 *   GET /:id/ai-act             the check's state and what was answered   (view)
 *   GET /:id/ai-act/check       Bee checks by itself: records what it can
 *                               answer, lists only what it cannot         (view; records for edit)
 *   PUT /:id/ai-act/answers     answer just those questions               (edit)
 *   GET /:id/ai-act/suggestion  prefilled answers for the three questions (view)
 *   PUT /:id/ai-act             the full editor: record the three answers (edit)
 *   GET /:id/readiness          the checklist                             (view)
 *
 * The automatic check is automation/aiActAuto.js; the same check runs inside
 * activate and publish (routes/automation/crud.js), so an automation Bee can
 * assess by itself goes live without anyone opening this page.
 *
 * The hub's register (routes/compliance/aiAct.js) is admin_compliance only and
 * sits behind the `compliance_hub_gdpr` mount. These paths are the automation's
 * own: its owner and the people who may edit it record the check here, into
 * the same register row, evidence chain and event (compliance/aiAct/attest.js).
 * An org admin with manage_automations counts as owner (automation/access.js).
 *
 * Without `compliance_hub_gdpr` in the automation's organisation there is no
 * check to do: every answer says `required: false` (status 'not_required'),
 * the settings page hides the card, activation is not gated, and a PUT is
 * refused with 403 `ai_act_not_available`.
 *
 * Built by a factory so a test hands in its own store, register, licence and
 * signals; the default router requires the real ones lazily.
 */

'use strict';

const express = require('express');
const { HttpError, badRequest } = require('../../core/http/errors');
const { makeGuardedLoad } = require('./guardedLoad');
const { makeAutomationAccess } = require('../../automation/access');
const aiActCheck = require('../../automation/aiActCheck');
const { makeAiActAuto, loadBlocksWith } = require('../../automation/aiActAuto');
const { computeReadiness } = require('../../automation/readiness');

/** How many recent runs the checklist looks through for the last test. */
const RUNS_FOR_LAST_TEST = 100;

/**
 * @param {object} [overrides]
 * @param {object}   [overrides.store]          automationStore surface (getAutomation, getRunsForAutomation, listSharesForAutomation)
 * @param {Function} [overrides.getUser]        (id) => user row
 * @param {Function} [overrides.hasPermission]  (userId, perm, session) => bool
 * @param {object}   [overrides.assessments]    aiActAssessmentStore surface (getLatest)
 * @param {Function} [overrides.isRequired]     async (automation, orgId) => bool (the licence)
 * @param {Function} [overrides.liveSignals]    async (orgId, automationId) => signals|null
 * @param {Function} [overrides.attest]         compliance/aiAct/attest.attest
 * @param {Function} [overrides.validateDefinition]
 * @param {Function} [overrides.classify]       aiActClassify.makeClassifier result (the fast-model verdict)
 * @param {Function} [overrides.loadBlocks]     async (definition) => { blockId: definition|null }
 * @param {Function} [overrides.now]            () => ms
 */
function makeAiActRouter(overrides = {}) {
    const router = express.Router();
    const store = () => overrides.store || require('../../stores/automationStore');
    const getUser = overrides.getUser || ((id) => require('../../stores/userStore').getUser(id));
    const assessments = () => overrides.assessments || require('../../stores/aiActAssessmentStore');
    const access = makeAutomationAccess({
        store: overrides.store,
        getUser,
        ...(overrides.hasPermission ? { hasPermission: overrides.hasPermission } : {}),
    });
    const validateDefinition = overrides.validateDefinition
        || ((def) => require('../../automation/validate').validateDefinition(def));
    const liveSignals = overrides.liveSignals
        || ((orgId, id) => require('../../compliance/aiAct/signals').signalsForAutomation(orgId, id));
    const attest = overrides.attest || ((input) => require('../../compliance/aiAct/attest').attest(input));
    const now = overrides.now || (() => Date.now());

    const aiActState = overrides.isRequired
        ? aiActCheck.makeAiActState({
            organisationOf: (a) => access.organisationOf(a),
            isRequired: overrides.isRequired,
            getLatest: (orgId, kind, id) => assessments().getLatest(orgId, kind, id),
            now,
        })
        : aiActCheck.defaultAiActState();

    const load = makeGuardedLoad(store, access);

    /** The signals as the register stores them; the definition alone when the org read finds nothing. */
    async function signalsFor(a, orgId) {
        let s = null;
        if (orgId) {
            try { s = await liveSignals(orgId, a.id); } catch { s = null; }
        }
        if (s) return s;
        return require('../../compliance/aiAct/signals').signalsFromDefinition(a.definition || {}, {
            title: a.title, description: a.description,
        });
    }

    /** The mail domains that count as inside: the owner's. Best effort. */
    async function internalDomainsOf(a) {
        const owner = await Promise.resolve(getUser(a.userId)).catch(() => null);
        const email = typeof owner?.email === 'string' ? owner.email : '';
        const at = email.lastIndexOf('@');
        return at > 0 ? [email.slice(at + 1).toLowerCase()] : [];
    }

    const auto = makeAiActAuto({
        aiActState: (a, def) => aiActState(a, def),
        attest: (input) => attest(input),
        classify: overrides.classify || require('../../automation/aiActClassify').defaultClassifier(),
        signalsFor: async (a, orgId, def) => {
            const live = await signalsFor(a, orgId);
            const fromDef = require('../../compliance/aiAct/signals').signalsFromDefinition(def || {}, { title: a.title, description: a.description });
            // The checked definition decides what it contains; the database adds live pages and marking.
            return { ...live, ...fromDef, customer_facing: !!(fromDef.customer_facing || live?.customer_facing), marking_enabled: !!live?.marking_enabled };
        },
        internalDomainsOf: (a) => internalDomainsOf(a),
        loadBlocks: overrides.loadBlocks || ((def) => loadBlocksWith(store(), def)),
        now,
    });

    const canEditOf = (acc) => acc.role === 'owner' || acc.role === 'edit';

    function describe(state, acc) {
        const assess = require('../../compliance/aiAct/assess');
        const row = state.row;
        return {
            ...aiActCheck.publicState(state),
            answers: aiActCheck.wizardFromAssessment(row),
            openDuties: row ? assess.openDuties(row.signals || {}, row.answers || {}) : [],
            canEdit: canEditOf(acc),
        };
    }

    /** A check's answer: the state, what Bee found per question, and the questions left. */
    function describeCheck(r, acc) {
        return {
            ...describe(r.state, acc),
            recorded: !!r.recorded,
            applicable: r.applicable ?? null,
            findings: r.findings || [],
            questions: r.pending || [],
        };
    }

    router.get('/:id/ai-act', async (req, res) => {
        const loaded = await load(req, res, 'view');
        if (!loaded) return;
        const state = await aiActState(loaded.a, loaded.a.definition || {});
        res.json(describe(state, loaded.acc));
    });

    // Bee checks by itself. Only somebody who may edit the automation makes Bee
    // record the result; a viewer sees the same answer without a write.
    router.get('/:id/ai-act/check', async (req, res) => {
        const loaded = await load(req, res, 'view');
        if (!loaded) return;
        const { a, acc } = loaded;
        const r = await auto.check(a, a.definition || {}, { record: canEditOf(acc), actorId: req.session?.user?.id || null });
        res.json(describeCheck(r, acc));
    });

    // The questions Bee could not answer (or any the person wants to change),
    // merged into what Bee found. Records the check once nothing is left open.
    router.put('/:id/ai-act/answers', async (req, res) => {
        const loaded = await load(req, res, 'edit');
        if (!loaded) return;
        const { a, acc } = loaded;
        const parsed = aiActCheck.parseAnswers(req.body);
        if (!parsed.ok) throw badRequest(parsed.code, parsed.message);
        const r = await auto.check(a, a.definition || {}, { record: true, actorId: req.session?.user?.id || null, answers: parsed.answers });
        if (!r.state.required) {
            throw new HttpError(403, 'ai_act_not_available', 'The AI Act check is part of the compliance hub, which this organisation does not have.');
        }
        res.json(describeCheck(r, acc));
    });

    router.get('/:id/ai-act/suggestion', async (req, res) => {
        const loaded = await load(req, res, 'view');
        if (!loaded) return;
        const { a } = loaded;
        const state = await aiActState(a, a.definition || {});
        const signals = state.required ? await signalsFor(a, state.orgId) : null;
        const suggestion = aiActCheck.suggestWizard({
            definition: a.definition || {},
            signals,
            latest: state.row,
            internalDomains: await internalDomainsOf(a),
            title: a.title || '',
            description: a.description || '',
        });
        res.json({ required: state.required, status: state.status, ...suggestion });
    });

    router.put('/:id/ai-act', async (req, res) => {
        const loaded = await load(req, res, 'edit');
        if (!loaded) return;
        const { a, acc } = loaded;
        const parsed = aiActCheck.parseWizard(req.body);
        if (!parsed.ok) throw badRequest(parsed.code, parsed.message);
        const before = await aiActState(a, a.definition || {});
        if (!before.required) {
            throw new HttpError(403, 'ai_act_not_available', 'The AI Act check is part of the compliance hub, which this organisation does not have.');
        }
        // Through the automatic check, so what Bee found is stored beside the
        // person's answers and the next check keeps them (source 'manual').
        // Twelve months, "not applicable" included (aiActAuto.js).
        const r = await auto.check(a, a.definition || {}, {
            record: true, actorId: req.session?.user?.id || null, answers: parsed.wizard, manual: true,
        });
        res.json(describe(r.state, acc));
    });

    router.get('/:id/readiness', async (req, res) => {
        const loaded = await load(req, res, 'view');
        if (!loaded) return;
        const { a } = loaded;
        const def = a.definition || {};
        let validation;
        try { validation = validateDefinition(def); }
        catch (e) { validation = { ok: false, errors: [{ code: 'shape.unreadable', path: '', message: e.message }] }; }
        const runs = await Promise.resolve(store().getRunsForAutomation(a.id, { limit: RUNS_FOR_LAST_TEST })).catch(() => []);
        const state = await aiActState(a, def);
        res.json(computeReadiness({ automation: a, validation, runs, aiAct: aiActCheck.publicState(state) }));
    });

    return router;
}

module.exports = { makeAiActRouter };
