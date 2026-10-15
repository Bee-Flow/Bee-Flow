// §WS5 #4 — builder catalog endpoints, extracted verbatim from routes/automation.js.
const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const router = express.Router();
const { deliverabilityForCatalog } = require('../../automation/deliverableEvents');
const { MAX_TOPIC_LABELS } = require('../../automation/expr');
const { synthesizeDryRunOutput } = require('../../automation/outputSchemas');
const {
    loadUserTools, isWebpagesAvailable, buildApps, buildSteps, buildFormPickSources,
} = require('./catalogApps');
const {
    KNOWLEDGE_WRITE_STRATEGIES, DATATABLE_OPS, loadDatatables, loadKnowledgeBases, loadAgents,
} = require('./catalogPickers');

/**
 * Can a `code` step an author writes today actually RUN? The palette's copy
 * of the one question execCode asks (core/automationRunner/execOutbound.js):
 * `codeSandbox.isAvailable()`. isolated-vm is a native build, and an install
 * that does not carry it refuses every code step at run time ("Code step
 * unavailable: ..."). There is no switch: code steps are a standard step for
 * every organisation, and the sandbox is the safety boundary. (A platform
 * config flag and a per-org `ai_code_execution` beta used to sit here; an
 * install where nobody had set them showed the Code step greyed out with no
 * way to switch it on in the product.)
 *
 * The answer stays a BOOLEAN (`flags.code`) with the reason BESIDE it. The
 * builder palette tests that flag for truthiness
 * (agent-hub/src/components/automation/Builder/flow/stepPalette.js), so
 * widening it into an object would make it permanently truthy.
 *
 * @returns {{enabled: boolean, reason: null|'runtime'}}
 */
function resolveCodeStepGate() {
    try {
        const sandbox = require('../../automation/codeSandbox');
        if (typeof sandbox.isAvailable === 'function' && sandbox.isAvailable()) return { enabled: true, reason: null };
    } catch (_) {
        // The module itself would not load: the step cannot run here either.
    }
    return { enabled: false, reason: 'runtime' };
}

// Catalog — auto-introspect existing TOOLS arrays.
router.get('/catalog', async (req, res) => {
    const userId = req.session.user.id;
    // Gather available apps for the user (best effort: present everything,
    // mark `available: true` if integrationTools.js would expose it).
    const { userToolNames, userToolDefs } = await loadUserTools(req, userId);

    // Webpages availability is gated on the beta feature (see isWebpagesAvailable).
    const webpagesAvailable = await isWebpagesAvailable(req, userId);

    const apps = buildApps({ userToolNames, webpagesAvailable });

    // Reusable Steps (kind='block') the user may add to this automation.
    // A Step is available only when every integration it touches is
    // available to the user — otherwise the call_block would fail at run
    // time, so we hide it (matching the apps availability gate).
    const steps = await buildSteps(req, userId, apps);

    // Can a code step run on this install (the sandbox): see
    // resolveCodeStepGate at the top of this file. `codeFlag` stays a
    // boolean; `codeReason` travels beside it.
    const codeGate = resolveCodeStepGate();
    const codeFlag = codeGate.enabled;
    const codeReason = codeGate.reason;
    // If we got here, the requireBetaFeature middleware already approved
    // the user — so this user's org has the automations feature on.
    const automationsFlag = true;
    // "Is about" rules in the Condition node need the topic classifier
    // (classify-service). Same contract as `code`: a strict boolean, with the
    // reason beside it ('not_configured' | 'unreachable' | 'loading' |
    // 'error') so the editor can offer the operator DISABLED WITH THE REASON.
    // probe() never throws and is cached for seconds.
    const topicsProbe = await require('../../core/classify/classifierClient').probe();
    // NOTE: layers are inline now (definition.layers) — there is no
    // catalog of standalone layer rows and no layers feature flag.

    // Trigger output field/sample catalog — useUpstreamVariables reads this
    // to expose `trigger.output.*` variables in the binding picker.
    let triggerOutputs = {};
    try { triggerOutputs = require('../../automation/builderTools').buildTriggerOutputsCatalog(); } catch (_) { /* keep empty */ }

    // Dynamic app_event provider list — availability derives ONLY from the
    // strict getIntegrationTools result above (same fail-closed authority
    // as apps[].available) plus explicit connection-backed checks. The AI
    // builder reads the same function (automation/builderPickerCatalog.js), so
    // the dropdown and the prompt cannot offer different providers. Booleans
    // only; no connection data, no secrets, ever reaches this response.
    const orgId = req.session.user.organizationId || null;
    const appEventProviders = await require('../../automation/builderPickerCatalog').buildAppEventProvidersFor({
        userId, session: req.session, apps, userToolNames, userToolDefs, orgId,
    });
    // The tables THIS caller may use, already filtered by the same grade
    // resolver the runner uses (see loadDatatables).
    const datatables = await loadDatatables(req, userId);

    // The knowledge bases this caller may WRITE to: the `knowledge_write`
    // node's picker (see loadKnowledgeBases).
    const knowledgeBases = await loadKnowledgeBases(req, userId);

    // The agents an ai_step may hand its thinking to. A failed read is NOT
    // "no agents": `agentsError` carries the failure (see loadAgents).
    const { agents, agentsError } = await loadAgents(req, userId);

    // What an `app_pick` form question may ask for. Served from the
    // registry rather than mirrored in the builder, so the list an author
    // chooses from and the list the submit route accepts cannot drift.
    const formPickSources = buildFormPickSources(userToolNames);

    res.json({
        apps,
        datatables,
        knowledgeBases,
        agents,
        formPickSources,
        // Null on a healthy read. Non-null means `agents` is EMPTY BECAUSE
        // THE READ FAILED, which is a different sentence than "no agents".
        agentsError,
        // What a knowledge_write node can do about a near-duplicate, and what a
        // datatable node can do: declared once (catalogPickers.js).
        knowledgeWriteStrategies: KNOWLEDGE_WRITE_STRATEGIES,
        datatableOps: DATATABLE_OPS,
        // Reusable Steps (kind='block') addable as call_block nodes.
        steps,
        triggerOutputs,
        // What every run knows about the trigger that fired, beside
        // trigger.output (trigger.kind, .event, .firedAt, …). A sibling
        // key on purpose: triggerOutputs is byte-pinned by a golden test.
        triggerMeta: require('../../automation/builderTools/triggerCatalog').TRIGGER_META_FIELDS,
        // Which app_event triggers fire today (pollerBacked) vs need the
        // pending Bee Flow ExApp connector (pushPending). Arrays, not Sets,
        // so the client can render honest "fires now" / "connector" hints.
        deliverability: deliverabilityForCatalog(),
        // parse_json stays listed for LEGACY rendering only — it can no
        // longer be authored (its ability moved into the set step).
        stepTypes: ['trigger', 'integration_action', 'ai_step', 'condition', 'guard', 'tokenize', 'loop', ...(codeFlag ? ['code'] : []), 'notification', 'parse_json', 'datatable', ...(steps.length ? ['call_block'] : [])],
        triggers: [
            { kind: 'schedule', label: 'On a schedule' },
            { kind: 'manual', label: 'Run manually' },
            { kind: 'webhook', label: 'Webhook URL' },
            { kind: 'form', label: 'Form submission (public page)' },
            { kind: 'app_event', providers: appEventProviders },
            { kind: 'agent_call', label: 'Callable by AI agent or direct chat (exposed as a tool)' },
        ],
        // `code` is the honest "would a code step run for this caller?" —
        // a BOOLEAN, read for truthiness by the builder palette. When it
        // is false, `codeReason` says why ('runtime': this install has no
        // sandbox) so the palette can
        // offer the step DISABLED WITH THE REASON instead of leaving it
        // out: a missing entry reads as "this product cannot do that",
        // which is a different (and wrong) sentence. Null when enabled.
        flags: { code: codeFlag, codeReason, automations: automationsFlag, topics: topicsProbe.available === true, topicsReason: topicsProbe.reason },
        // What the editor needs to offer "is about" honestly: the threshold
        // the service applies when a rule sets none, and the topic ceiling.
        topics: {
            defaultThreshold: topicsProbe.defaultThreshold,
            maxLabels: Math.min(topicsProbe.maxLabels || MAX_TOPIC_LABELS, MAX_TOPIC_LABELS),
        },
    });
});

/**
 * Just the `app_pick` sources — the list a form question's "which app?"
 * dropdown needs, without paying for the whole builder catalog above.
 *
 * The form editor is reached from two places that have no catalog of their own
 * (the automation builder's Form panel and Studio → Forms), so it asks for this
 * directly. Same registry, same `available` rule as the big catalog: a hint
 * about THIS author, never a gate — the person filling the form in is usually
 * somebody else, and it is their access that decides what the picker shows.
 */
router.get('/catalog/form-pick-sources', async (req, res) => {
    // Unknown, not empty, when the lookup fails: `available` then reads false
    // everywhere, which greys out a hint and never removes a choice.
    const { userToolNames } = await loadUserTools(req, req.session.user.id);
    res.json({ sources: buildFormPickSources(userToolNames) });
});

router.get('/catalog/sample/:tool', async (req, res) => {
    const tool = req.params.tool;
    const sample = synthesizeDryRunOutput(tool, {});
    res.json({ tool, sample });
});

/**
 * The columns of one Nextcloud table, for the step editor.
 *
 * A Tables row step takes `values` as a map of column TITLE → binding. The
 * editor used to show that as a raw JSON field nobody could fill in, and the
 * AI keyed it by its own field names, so rows failed at run time. The
 * column-aware editor (flow/settings/TablesRowValuesEditor.jsx) renders one
 * binding row per column instead — and needs the columns. Same auth as every
 * other call on this router (requireAuth upstream); the tool runs as the
 * signed-in user through the normal Nextcloud connector path, so it sees
 * exactly the tables that user can see. Read-only.
 */
router.get('/catalog/nextcloud-tables/:tableId/columns', async (req, res, next) => {
    // An id, or a table title — the tool resolves a title itself (one exact
    // match, else a soft error naming the tables), so the editor can list
    // columns for a step that says tableId: "Facturen".
    const raw = String(req.params.tableId || '').trim();
    const asNumber = Number(raw);
    const tableId = /^\d+$/.test(raw) ? asNumber : raw;
    if (!raw || raw.length > 200 || (typeof tableId === 'number' && tableId <= 0)) {
        return res.status(400).json({ error: 'tableId must be a positive integer or a table title' });
    }
    try {
        // Through the dispatcher, never the executor directly: executeTool is
        // where ncScopeGuard decides whether this user may see this table at
        // all ("What Bee Flow may access"), and the call-site test refuses any
        // other path to a Nextcloud executor.
        const { executeTool } = require('../../core/tools/toolDispatcher');
        // `egress: false`: the step editor reading a table's column names to
        // draw its binding rows. Nobody's data is sent anywhere, so it is not
        // a transfer for the ledger (the call site's own reason, see
        // core/tools/toolEgress.js).
        const out = await executeTool('nextcloud_tables_list_columns', { tableId }, {
            userId: req.session.user.id,
            session: req.session,
            egress: false,
        });
        if (out && out.error) return next(new HttpError(502, 'upstream_failed', out.error));
        res.json(out);
    } catch (e) {
        log.error('[Catalog] Nextcloud table columns failed:', e);
        next(new HttpError(502, 'upstream_failed', 'Could not read the table columns'));
    }
});

// The AI step editor's agent and skill previews (handoff 5): agentStepRoutes.js.
require('./agentStepRoutes').registerAgentStepRoutes(router);


// List automations

module.exports = router;
