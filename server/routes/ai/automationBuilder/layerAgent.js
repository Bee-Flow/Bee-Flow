/**
 * Automation Builder — POST /layer-agent (SSE): build or refine ONE inline
 * flowlet with a focused thinking-model sub-agent, separate from the chat.
 *
 * The body is checked BEFORE the stream opens, so a refusal is a 400 with a
 * sentence (useFlowletAgentStream shows `error` from a non-2xx) instead of an
 * `error` event inside a 200. The check that mattered: `mode` was compared to
 * 'refine' and everything else meant create — so `mode: 'Refine'` with a
 * layerKey built a SECOND flowlet next to the one the user asked to refine,
 * ran the sub-agent on it and saved the automation with both.
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();
const { z } = require('zod');
const { validate } = require('../../../core/http/validate');

const { getUserTierMap } = require('../../../core/llm/modelResolver');
const { applyToolCall } = require('../../../automation/builderTools');
const { runLayerAgent, resolveLayerAgentModel } = require('../../../automation/flowletAgent');
const { buildCatalogForUser } = require('../../../automation/builderCatalog');
const { buildDatatableCatalogForUser } = require('../../../automation/builderDatatableCatalog');
const { startSseHeartbeat } = require('../../../core/http/sseHelpers');
const { requireAuth } = require('../../../auth/permissions');
const { layerAgentRateLimit } = require('./rateLimits');
const { loadOrCreateDraft, persistDraftWrap } = require('./builderDraft');

const SAVE_FIRST = 'Save the automation first, then build a flowlet.';
const INSTRUCTION_TEXT = 'An instruction is required.';

const LayerAgentBody = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({
    automationId: z.string({ required_error: SAVE_FIRST, invalid_type_error: 'automationId is the id of the saved automation.' })
        .trim().min(1, SAVE_FIRST),
    instruction: z.string({ required_error: INSTRUCTION_TEXT, invalid_type_error: INSTRUCTION_TEXT })
        .trim().min(1, INSTRUCTION_TEXT),
    mode: z.enum(['create', 'refine'], { errorMap: () => ({ message: "mode is 'create' or 'refine'." }) }).default('create'),
    // The hook sends null for both when it has nothing to say.
    layerKey: z.string({ invalid_type_error: 'layerKey is the key of the flowlet to refine.' }).trim().nullish(),
    title: z.string({ invalid_type_error: 'A flowlet title is text.' }).trim().nullish(),
}).strict().superRefine((body, ctx) => {
    if (body.mode === 'refine' && !body.layerKey) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['layerKey'], message: 'Refining needs the layerKey of the flowlet to refine.' });
    }
    // A key without mode 'refine' is a refinement that lost its mode — and
    // create would have built a new flowlet beside the one it names.
    if (body.mode === 'create' && body.layerKey) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['mode'], message: "A layerKey names a flowlet to refine: send mode 'refine' with it. 'create' always builds a new one." });
    }
}));

/**
 * POST /layer-agent — SSE. Build or refine ONE inline flowlet with a focused
 * thinking-model sub-agent, SEPARATE from the chat (no chat history touched).
 * Powers the Flowlets panel's "Build a flowlet with AI" / "Refine with AI".
 *
 * Body: { automationId, instruction, mode:'create'|'refine', layerKey?, title? }
 * Events: builder_session, layer_agent_start, tool_call (per sub-agent step),
 *         layer_agent_done, draft (final definition), done | error.
 */
router.post('/layer-agent', requireAuth, layerAgentRateLimit, validate({ body: LayerAgentBody }), async (req, res) => {
    const userId = req.session.user.id;
    const { automationId, instruction, mode, layerKey: existingKey, title } = req.body;

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    // Flush headers + 10s heartbeat — the flowlet agent (with sub-agents)
    // can run for a while; without pings an upstream gateway idle-times-out
    // and the embedded app sees a false 504. Auto-stops on res close/finish.
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const stopLayerHeartbeat = startSseHeartbeat(res);
    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {} };

    try {
        const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
        if (!(await userHasBetaFeature(userId, 'automations', req.session))) {
            send('error', { error: 'The Automations beta is not enabled for your organisation.' });
            return res.end();
        }
        // The flowlet agent operates on the SAVED automation — make sure one
        // exists (the panel calls ensureAutomationCreated first, but guard).
        const draftWrap = await loadOrCreateDraft({ userId, builderSessionId: null, automationId });
        if (!draftWrap.automationId) {
            send('error', { error: SAVE_FIRST });
            return res.end();
        }
        draftWrap.orgId = req.session?.user?.organizationId || null;
        send('builder_session', { automationId: draftWrap.automationId });

        const userOrgForTiers = req.session?.user?.organizationId || null;
        const modelId = await resolveLayerAgentModel({ userOrgId: userOrgForTiers, userId });
        // Null means neither the thinking nor the fast tier is configured for
        // this workspace. Say so — the alternative was a hardcoded default
        // model nobody here picked (see modelResolver.resolveModelForTierName).
        if (!modelId) {
            send('error', { error: 'No AI model is configured for this workspace. Set a model tier first.' });
            return res.end();
        }
        const catalog = await buildCatalogForUser(userId, req.session);
        // Same datatable catalog the main builder gets (chatStream.js): without
        // it the flowlet sub-agent saw no "Datatables you may use" block and the
        // datatable builder ran with a permissive null gate.
        try { draftWrap._datatables = await buildDatatableCatalogForUser(userId); }
        catch (e) { log.warn('[LayerAgent] datatable catalog unavailable:', e.message); draftWrap._datatables = null; }
        catalog.datatables = draftWrap._datatables;
        // …and the designed documents, for the same reason: without them the
        // sub-agent has no "Documents you may fill" block and fill_document
        // runs against a permissive null gate.
        draftWrap._documentDiscoveryRequired = true;
        try { draftWrap._documents = await require('../../../automation/builderDocumentCatalog').buildDocumentCatalogForUser(userId); }
        catch (e) { log.warn('[LayerAgent] document catalog unavailable:', e.message); draftWrap._documents = null; }
        catalog.documents = draftWrap._documents;
        // …and the agents and knowledge bases, so a flowlet that runs an ai_step
        // on an agent or writes to a base has real ids to use (no app_event
        // providers: a flowlet has no trigger of its own).
        Object.assign(catalog, await require('../../../automation/builderPickerCatalog')
            .buildPickerCatalogsForUser(userId, req.session, catalog, { providers: false }));
        // ai_step modelTier gate: sub-agents may only pick the user's tiers.
        //
        // Een onleesbare tiermap WEIGERT, net als de `!modelId` hierboven. Hij
        // werd hier stil geslikt, waarna `_allowedModelTiers` ongezet bleef en
        // stepBuilders dat las als "alles mag": dezelfde configuratiebron, twee
        // tegengestelde antwoorden op "ik kan het niet lezen", en de ruimste
        // ervan op de tak die duurdere modellen vastlegt in elke volgende run.
        try {
            const tierMap = await getUserTierMap({ userOrgId: userOrgForTiers, userId });
            draftWrap._allowedModelTiers = new Set(['auto', ...Object.keys(tierMap).filter(k => k !== 'swarm' && k !== 'standard')]);
        } catch (e) {
            log.error('[layerAgent] tier map unreadable:', e.message);
            send('error', { error: 'Could not check which models this workspace may use. Try again.' });
            return res.end();
        }

        let layerKey = existingKey;
        if (mode === 'refine') {
            if (!layerKey || !draftWrap.def?.layers?.[layerKey]) {
                send('error', { error: 'That flowlet no longer exists — refresh and try again.' });
                return res.end();
            }
        } else {
            const created = await applyToolCall('builder_create_layer', { title: title || 'New layer' }, draftWrap);
            if (created?.error) { send('error', { error: created.error }); return res.end(); }
            layerKey = created.layerKey;
        }

        send('layer_agent_start', { layerKey, mode });
        let layerClientGone = false;
        const layerAbort = new AbortController();
        req.on('close', () => {
            layerClientGone = true;
            try { layerAbort.abort(); } catch (_) { /* already aborted */ }
        });
        const r = await runLayerAgent({
            draftWrap, layerKey, instruction, mode,
            modelId, userId, userOrgId: userOrgForTiers, session: req.session, catalog, send,
            isAborted: () => layerClientGone || res.writableEnded,
            signal: layerAbort.signal,
        });
        await persistDraftWrap(draftWrap);
        send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
        send('layer_agent_done', { layerKey, outputFields: r.outputFields, summary: r.summary });
        send('done', { automationId: draftWrap.automationId, layerKey });
    } catch (e) {
        log.error('[automationBuilder/layer-agent] error:', e.message);
        send('error', { error: e.message });
    } finally {
        stopLayerHeartbeat();
        res.end();
    }
});

module.exports = router;
