// §WS5 #4 — builder catalog endpoints, extracted verbatim from routes/automation.js.
const express = require('express');
const log = require('../../telemetry/log');
const { HttpError } = require('../../core/http/errors');
const router = express.Router();
const automationStore = require('../../stores/automationStore');
const { deliverabilityForCatalog } = require('../../automation/deliverableEvents');
const { MAX_TOPIC_LABELS } = require('../../automation/expr');
const { TOOL_REGISTRY, loadTools } = require('../../automation/toolRegistry');
const { isSideEffect, effectOf } = require('../../automation/sideEffectMap');
const { getOutputSchema, synthesizeDryRunOutput, producesList, iterableFieldsOf } = require('../../automation/outputSchemas');
const { resolveIntegration } = require('../../core/integrations/integrationToolMap');

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

/**
 * What a person reads for an action, next to the app's name: `nextcloud_mail_list_mailboxes`
 * under "Nextcloud Mail" is "List mailboxes", `gmail_search` under "Gmail" is "Search". The
 * leading words the app's name already says are dropped (at least one word stays), the rest
 * is sentence case. It used to be the tool id with spaces ("nextcloud mail list mailboxes").
 */
function actionLabel(name, appLabels) {
    const words = String(name).split('_').filter(Boolean);
    const said = new Set(appLabels.filter(Boolean).flatMap(l => String(l).toLowerCase().split(/[^a-z0-9]+/)).filter(Boolean));
    let i = 0;
    while (i < words.length - 1 && said.has(words[i].toLowerCase())) i += 1;
    const rest = words.slice(i).join(' ');
    return rest.charAt(0).toUpperCase() + rest.slice(1);
}

// Catalog — auto-introspect existing TOOLS arrays.
router.get('/catalog', async (req, res) => {
    const userId = req.session.user.id;
    // Gather available apps for the user (best effort: present everything,
    // mark `available: true` if integrationTools.js would expose it).
    const session = req.session;
    const { getIntegrationTools } = require('../../core/integrations/integrationTools');
    // `available` is computed STRICTLY from getIntegrationTools — the same
    // authoritative gate the runtime uses (org grant ∩ group grant ∩
    // personal toggle ∩ credentials). An app counts as available only when a
    // tool it owns is actually in the user's resolved tool set, so the picker
    // never advertises an integration the user's org/group hasn't enabled.
    // Do NOT broaden this with getUserPermittedApps(): that helper fails OPEN
    // (no explicit org list → AUTO_ENABLED_APPS lets nearly everything
    // through) and would expose the whole server catalog. See memory
    // reference_automations_catalog_strict_gating.
    let userToolNames = new Set();
    // Kept alongside the names so app_event can auto-derive watchable
    // sources for integrations that ship no trigger declaration.
    let userToolDefs = [];
    try {
        const result = await getIntegrationTools({ userId, session, isAdmin: !!req.session?.isAdmin, automationStep: true });
        userToolDefs = result.tools || [];
        for (const t of userToolDefs) {
            if (t?.function?.name) userToolNames.add(t.function.name);
        }
    } catch (_) { /* user might not be fully set up */ }

    // Webpages availability is gated on the beta feature — the same gate
    // getIntegrationTools now uses to actually provision the tools (so the
    // "available" flag here matches what the running agent/automation receives),
    // and the same gate the direct webpage chat uses. Check it directly
    // rather than inferring from userToolNames so the flag is correct even
    // if the tool-name derivation changes.
    let webpagesAvailable = false;
    try {
        const { userHasBetaFeature } = require('../../core/entitlements/betaFeatures');
        webpagesAvailable = await userHasBetaFeature(userId, 'webpages', req.session);
    } catch (_) { /* default false */ }

    const apps = TOOL_REGISTRY.map(entry => {
        const tools = loadTools(entry);
        const actions = tools.map(t => {
            const name = t?.function?.name;
            if (!name) return null;
            // Resolve the integration that owns this tool so the visual
            // builder can render the brand logo on each action chip /
            // node. Falls back to the app id when no prefix matches.
            const resolved = resolveIntegration(name) || null;
            const os = getOutputSchema(name);
            return {
                name,
                label: actionLabel(name, [resolved?.label, entry.label]),
                description: t.function?.description || '',
                inputSchema: t.function?.parameters || null,
                outputSchema: os,
                // useUpstreamVariables (frontend) reads outputSample to seed
                // the variable picker with realistic field names.
                outputSample: os?.sample || null,
                // Does this action hand back a LIST of records? App Studio
                // connectors badge those (a list is what can fill a table) and
                // `listField` is the key the rows sit under, so a caller can
                // pick the rows path without running the tool first. Both are
                // declaration-derived, so they are false/null for the ~300
                // tools with no OUTPUT_SCHEMAS entry — a live sample settles
                // those (appStudio/connectorSchema.js).
                producesList: producesList(name),
                listField: iterableFieldsOf(name)[0] || null,
                sideEffect: isSideEffect(name),
                // The three-way split the agent tool picker labels and
                // defaults its confirmation on: 'reads' | 'writes' |
                // 'sends'. `sideEffect` stays exactly what it was (the
                // dry-run question) — this is the "does it leave the
                // building" question, and the two genuinely differ:
                // renaming a file and mailing a customer are both side
                // effects, only one of them is unrecallable.
                effect: effectOf(name),
                integrationId: resolved?.integration || entry.app,
                integrationLabel: resolved?.label || entry.label,
            };
        }).filter(Boolean);
        // For webpages, "available" is the beta feature OR the fact that
        // getIntegrationTools actually provisioned the webpage tools for
        // this user (which now also happens when they have access to a
        // webpage even without the beta toggle — see getIntegrationTools).
        // ORing keeps the design-time palette flag in lockstep with what
        // the running automation will actually receive.
        const available = entry.app === 'webpages'
            ? (webpagesAvailable || actions.some(a => userToolNames.has(a.name)))
            : actions.some(a => userToolNames.has(a.name));
        return { id: entry.app, label: entry.label, available, actions };
    });

    // Reusable Steps (kind='block') the user may add to this automation.
    // A Step is available only when every integration it touches is
    // available to the user — otherwise the call_block would fail at run
    // time, so we hide it (matching the apps availability gate).
    let steps = [];
    try {
        const { resolveAudienceContext } = require('../../auth/audience');
        const { orgIds, userGroups } = await resolveAudienceContext(req);
        const orgIdList = orgIds === null ? [] : [...orgIds];
        const callable = await automationStore.getCallableStepsForUser(userId, { orgIds: orgIdList, userGroups: userGroups || [] });
        // Build the set of integration ids the user can use right now.
        const availableIntegrationIds = new Set();
        for (const app of apps) {
            if (!app.available) continue;
            availableIntegrationIds.add(app.id);
            for (const a of app.actions) if (a.integrationId) availableIntegrationIds.add(a.integrationId);
        }
        steps = callable.map(s => ({
            id: s.id,
            title: s.title,
            description: s.description,
            icon: s.icon || null,
            category: s.category || null,
            params: s.params,
            outputFields: s.outputFields,
            requiredIntegrations: s.requiredIntegrations,
            available: (s.requiredIntegrations || []).every(i => availableIntegrationIds.has(i)),
        }));
    } catch (e) { log.warn('[automation/catalog] steps load failed:', e.message); }

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
    // resolver the runner uses. The canvas has nowhere to hang a permission
    // check, so availability has to arrive pre-filtered — exactly as `apps`
    // does. One shape carries the columns too, so the editor can offer a
    // column picker without a second round trip.
    let datatables = [];
    try {
        const { resolveDatatablePrincipal } = require('../../auth/datatableAccess');
        const { buildDatatableCatalogForUser } = require('../../automation/builderDatatableCatalog');
        // The org comes from `users`, not from the session — this picker was
        // empty for every member whose login shape omits organizationId,
        // and the catch below swallowed the fact that it never even looked.
        // The list itself is built by the same module the AI builder
        // reads its "Datatables you may use" block from, so the picker
        // and the prompt cannot offer two different sets of tables.
        const principal = await resolveDatatablePrincipal(req);
        datatables = await buildDatatableCatalogForUser(userId, { principal });
    } catch (e) {
        // A datatable outage must not take the whole catalog down; the
        // picker renders its empty state and every other node still works.
        log.warn('[automation/catalog] datatables unavailable:', e.message);
    }

    /**
     * The knowledge bases this caller may WRITE to — the `knowledge_write`
     * node's picker (K10).
     *
     * Pre-filtered for the same reason the datatables are: the canvas has
     * nowhere to hang a permission check, so an id must not be offerable
     * unless it is allowed. And the predicate is the WRITE one
     * (`canUserManageKB`), not the read one: a person can read a dozen
     * bases they must not add documents to, and offering those would put an
     * id in the definition that the save check then refuses — the picker
     * teaching the author to build something invalid.
     *
     * `canWrite` rather than a filtered list, so a base the author can see
     * but not write to is shown DISABLED with the reason, the way the
     * datatable picker already does it. A picker that silently omits what
     * you were looking for reads as a bug.
     */
    let knowledgeBases = [];
    try {
        const { resolveUserOrgIds, hasPermission, resolveUserGroups } = require('../../auth');
        // `userId` is the handler's own, from req.session.user — reaching
        // for req.user here would have been undefined, and an undefined
        // userId makes canUserManageKB's owner test silently false for
        // every base somebody owns.
        // Never null: `canUserManageKB` reads a null `orgIds` as super-admin
        // and returns true for every base there is.
        const resolved = await resolveUserOrgIds(req);
        const orgIds = resolved instanceof Set ? resolved : new Set(Array.isArray(resolved) ? resolved : []);
        const canManage = await hasPermission(userId, 'manage_knowledge').catch(() => false);
        // resolveUserGroups takes a USER ID, not the request — the KB routes
        // wrap it for exactly this reason (routes/knowledgeBases/shared.js).
        // Called with `req` it resolved to [], so filterByGroupAccess dropped
        // every group-restricted base out of the picker, including ones the
        // author manages and the save-time gate would have allowed.
        const userGroups = await resolveUserGroups(userId).catch(() => []);
        // isOrgAdmin, like routes/knowledgeBases/list.js: without it an org
        // admin is shown fewer bases here than in the Knowledge Studio, and
        // the ones missing are exactly the unpublished ones they manage.
        let isOrgAdmin = false;
        try { isOrgAdmin = await require('../../support/kbAccess').resolveIsOrgAdmin(req); } catch (_) { isOrgAdmin = false; }
        knowledgeBases = await require('../../automation/builderPickerCatalog')
            .listKnowledgeBasePicker({ userId, orgIds, userGroups, canManage, isOrgAdmin });
    } catch (e) {
        // Same posture as the datatables above: the picker renders its
        // empty state and every other node still works.
        log.warn('[automation/catalog] knowledge bases unavailable:', e.message);
    }

    /**
     * The agents an ai_step may hand its thinking to (R2).
     *
     * ── A FAILED READ IS NOT "NO AGENTS" ────────────────────────
     * This is the ONE list in this response that does not fail to an empty
     * array. Datatables and knowledge bases can: an empty picker there
     * reads as "nothing linked yet", which is a normal state of a normal
     * workspace. An empty AGENT picker is not — every workspace that got
     * as far as building an automation has agents — so an empty list on a
     * failed read would tell the author their agents are gone and send
     * them looking in the wrong place. `agentsError` carries the failure
     * instead, and the editor says "could not check" rather than "none".
     *
     * ── WHAT IS IN IT, AND WHY IT IS BOTH LISTS ─────────────────
     * The author's OWN agents (including the ones still on draft) plus the
     * published agents their org and groups show them. Own-first, because
     * `agentPickerRows` dedupes first-wins and the own row carries the
     * concept state of an agent that appears in both.
     *
     * A row that cannot be used still ships, with the reason — see the
     * header of automation/agentPickerRows.js for why that is safe here
     * and deliberately not safe in the validator.
     */
    // The list itself is built by automation/builderPickerCatalog.js, the same
    // function the AI builder reads its "Agents you may use" block from. The
    // principal is the one this request already resolved (and cached on req).
    const agentRead = await (async () => {
        try {
            const { resolveDatatablePrincipal } = require('../../auth/datatableAccess');
            // The HOME organisation from the user row — `principal.organizationId`,
            // not `principal.orgId` (see buildAgentPickerForUser).
            return await require('../../automation/builderPickerCatalog')
                .buildAgentPickerForUser(userId, { principal: await resolveDatatablePrincipal(req) });
        } catch (e) {
            log.warn('[automation/catalog] agents unavailable:', e.message);
            return { agents: [], agentsError: e.message || 'agent list unavailable' };
        }
    })();
    const { agents, agentsError } = agentRead;

    // What an `app_pick` form question may ask for. Served from the
    // registry rather than mirrored in the builder, so the list an author
    // chooses from and the list the submit route accepts cannot drift.
    //
    // `available` is about THIS AUTHOR — whether they could try the picker
    // themselves — and deliberately does NOT gate the choice. The person
    // who fills the form in is usually somebody else, and it is THEIR
    // access that decides what the picker shows; refusing an author the
    // ability to ask their colleagues for a Fireflies transcript because
    // the author has no Fireflies of their own would be the wrong rule.
    const { catalog: pickCatalog, toolsFor, getSource } = require('../../automation/formPickSources');
    const formPickSources = pickCatalog().map(src => ({
        ...src,
        available: src.internal || toolsFor(getSource(src.id)).every(t => userToolNames.has(t)),
    }));

    res.json({
        apps,
        datatables,
        knowledgeBases,
        agents,
        formPickSources,
        // Null on a healthy read. Non-null means `agents` is EMPTY BECAUSE
        // THE READ FAILED, which is a different sentence than "no agents".
        agentsError,
        // What a knowledge_write node can do about a near-duplicate,
        // declared once so the editor's dropdown and the runner cannot
        // drift. The order is the order the dropdown offers them.
        knowledgeWriteStrategies: [
            { value: 'skip', label: 'Keep what is there', blurb: 'If the base already holds nearly the same text, leave it alone.' },
            { value: 'merge', label: 'Merge into one', blurb: 'Combine the two into a single, richer document.' },
            { value: 'replace', label: 'Replace it', blurb: 'Overwrite the near-identical document with this one.' },
            { value: 'add', label: 'Add it anyway', blurb: 'Store it as its own document, even if a similar one exists.' },
        ],
        // What a datatable node can do, declared once so the editor's
        // dropdown and the AI builder's prompt cannot drift.
        datatableOps: [
            { op: 'find_rows', label: 'Find rows', blurb: 'Look rows up. Nothing is changed.', writes: false },
            { op: 'count_rows', label: 'Count rows', blurb: 'How many rows match — the real total, not one page of them.', writes: false },
            { op: 'add_row', label: 'Add a row', blurb: 'Always adds a new row, even if a matching one exists.', writes: true },
            { op: 'save_row', label: 'Add or update a row', blurb: 'Updates the row that matches, or adds it if there is not one yet.', writes: true },
            { op: 'update_rows', label: 'Update rows that match', blurb: 'Changes every row that matches. Needs at least one condition.', writes: true },
            { op: 'delete_rows', label: 'Delete rows that match', blurb: 'Removes every row that matches. Needs at least one condition.', writes: true },
        ],
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
    const { catalog: pickCatalog, toolsFor, getSource } = require('../../automation/formPickSources');
    let userToolNames = new Set();
    try {
        const { getIntegrationTools } = require('../../core/integrations/integrationTools');
        const result = await getIntegrationTools({
            userId: req.session.user.id,
            session: req.session,
            isAdmin: !!req.session?.isAdmin,
            automationStep: true,
        });
        for (const t of (result.tools || [])) if (t?.function?.name) userToolNames.add(t.function.name);
    } catch (_) {
        // Unknown, not empty. `available` then reads false everywhere,
        // which greys out a hint — it never removes a choice.
    }
    res.json({
        sources: pickCatalog().map(src => ({
            ...src,
            available: src.internal || toolsFor(getSource(src.id)).every(t => userToolNames.has(t)),
        })),
    });
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
        if (out && out.error) return res.status(502).json({ error: out.error });
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
