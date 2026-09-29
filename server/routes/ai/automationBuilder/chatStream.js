/**
 * Automation Builder — conversational SSE endpoint.
 *
 *   POST /api/automation/builder/stream  (mounted at /api/automation/builder)
 *
 * Body: { message, builderSessionId?, automationId?, modelTier?, history?,
 *         seedMetadata? { title?, description? } — a host's name for a draft
 *         this request CREATES (the playbook stage sends its brief's title);
 *         ignored for an existing draft }
 *
 * The builder owns a per-(userId, builderSessionId) draft kept in-memory
 * and persisted to the `automations` table (is_draft=TRUE) after every
 * mutation, so:
 *
 *   - a page refresh recovers the draft via /api/automation/:id
 *   - the user always sees a saved row in their list
 *
 * SSE events emitted:
 *   round_start    — { iter, modelId, promptChars, effort, local, providerType }
 *                    — a model round is about to start; promptChars sizes the
 *                    prefill wait, `local` says the model runs on a self-hosted
 *                    runtime (providers/localModels.isLocalProviderType)
 *   prompt_progress— { iter, total, cache, processed, timeMs } — llama-server
 *                    prefill progress (return_progress); ≤ ~4/s
 *   tool_draft     — { iter, name, chars, count, steps, inspect } — the steps a
 *                    tool call's still-streaming arguments already describe
 *                    (toolDraft.js); ≤ 1 per 250 ms plus one on every change
 *   message        — assistant text token (streamed delta)
 *   thinking_start — { partId, redacted? } — a reasoning block opened
 *   thinking       — { partId, text } — reasoning delta (live)
 *   thinking_stop  — { partId, redacted? } — a reasoning block closed
 *   tool_call      — { name, arguments, result }
 *   draft          — full updated definition (debounced)
 *   summary       — plain-English summary
 *   dryrun_started — { run: { id, status, startedAt } } — the dry run's row
 *                    exists; the canvas follows it live from here (BuildTab's
 *                    step poller), the same way a manual run is followed
 *   dryrun        — { run, steps } — the finished dry run, every step row
 *   finalized     — { automationId }
 *   metadata      — { automationId, title, description } — the routine's name
 *                    changed: after every accepted builder_set_metadata, and
 *                    after the server named an untitled draft itself
 *                    (builderTools/deriveTitle.js, at finalize / auto-finalize
 *                    / turn end). The header refetches on it.
 *   builder_aborted — { reason, iterations, lastValidation, rejected? } — the
 *                    turn ended without finalizing: 'max_iterations' (budget
 *                    spent), 'repeated_rejection' (one step was refused three
 *                    times running — the repeat ladder in builderTools.js) or
 *                    'no_progress' (four rounds in which every call was
 *                    refused). The last two carry `rejected: { tool, error,
 *                    label }` and are followed by ONE `message` sentence for
 *                    the user.
 *   done / error
 */

const express = require('express');
const log = require('../../../telemetry/log');
const router = express.Router();

const automationStore = require('../../../stores/automationStore');
const configStore = require('../../../stores/configStore');
const { getProviderForModel, getAIConfig } = require('../../../core/aiAgent');
const { getAdapter } = require('../../../core/providers');
const { getUserTierMap } = require('../../../core/llm/modelResolver');
const { TOOL_SCHEMAS, applyToolCall, compactDryRunForModel, truncateToolResultJson } = require('../../../automation/builderTools');
const { tierAccessFor, tierRefusal, cheapestTier } = require('../../../core/entitlements/tierAccess');
const { summariseDefinition, renderAgentDraftState } = require('../../../automation/summarise');
// Lives in automation/ rather than here because the MCP surface
// (automation/mcpBuilder.js) needs the same catalog, and automation/ may not
// require routes/ (server/layering.test.js).
const { buildCatalogForUser } = require('../../../automation/builderCatalog');
const { validateDefinition } = require('../../../automation/validate');
const { getDeliverableEvents } = require('../../../automation/deliverableEvents');
const { getProfileForModel, effortForIteration, CORE_TOOL_NAMES } = require('../../../automation/builderModelProfiles');
const { projectToolSchemas } = require('../../../automation/builderTools/schemaProjection');
const { ensureDraftTitle, UNTITLED_AUTOMATION } = require('../../../automation/builderTools/deriveTitle');
const { applyBuilderTierFloor } = require('../builderShared');
const { startSseHeartbeat } = require('../../../core/http/sseHelpers');
const { builderRateLimit } = require('./rateLimits');
const { loadOrCreateDraft, persistDraftWrap } = require('./builderDraft');
const { runDelegationTool } = require('./layerDelegation');
const { streamWithRetry } = require('./modelStream');
const { inferPlanProgress } = require('./planProgress');
const { createThoughtNarrator } = require('./thoughtNarrator');
const { composeTurnMessages } = require('./turnMessages');
const { scanToolDraft, deriveDraftKey, makeDraftThrottle, makeProgressThrottle } = require('./toolDraft');
const { isLocalProviderType } = require('../../../core/providers/localModels');
const { HISTORY_EVICT_BLOCK } = require('../../../core/llm/historyWindow');
const { systemPrefixFingerprint, toolSetFingerprint, toolBytesFingerprint } = require('../../../core/llm/promptCacheStability');
const {
    parseToolArgs, mutates, accumulateUsage, renderValidationNote, providerErrorExcerpt,
    sanitizeHistory, collectAssistantTurn, applyPlanMarkDone, normalizePlanTodos,
    isTruncatedStop, truncationRetryMessages, emptyReplyRetryMessages, isBlankReply, recoverLeakedToolCalls, RECOVERED_CALL_HINT, REPAIRED_CALL_HINT,
} = require('./chatTurnLoop');

// requireAuth is the canonical gate from auth/permissions (verifies the
// user still exists in the DB, cached 5s, and destroys deleted-user sessions).
const { requireAuth } = require('../../../auth/permissions');
const { rankAppsForMessage, applyCatalogOrder, catalogOrderOf } = require('../../../automation/builderPrompt/rankApps');
const { validate } = require('../../../core/http/validate');
const { z, worded, bodyOf, queryOf, closedObject, choice, flag } = require('../../../core/http/schemaParts');

// ── What a turn may send ─────────────────────────────────────────────
// The keys the stream reads (see the header) and nothing else. The values
// stay as loose as the handler reads them — history and attachments are
// windowed and summarised downstream — but a misspelled key used to be a
// silent default under a 200 and a paid turn: `modelTeir` built on `auto`,
// `automationID` started a NEW draft beside the one on screen, and
// `webSearchEnabled: "false"` switched web search ON (`!!"false"`).
const text = (message) => worded(message).max(200, message);
const TurnBody = bodyOf({
    message: worded('message is the text of your turn.').nullish(),
    builderSessionId: text('builderSessionId is the id the previous turn handed back.').nullish(),
    automationId: text('automationId is the id of the routine being built.').nullish(),
    modelTier: text('modelTier is the name of a model tier.').nullish(),
    history: z.array(z.unknown(), { invalid_type_error: 'history is the list of earlier turns.' }).nullish(),
    attachments: z.array(z.unknown(), { invalid_type_error: 'attachments is a list of files.' }).nullish(),
    webSearchEnabled: flag('webSearchEnabled is true or false.').nullish(),
    disabledMedia: z.record(z.unknown(), { invalid_type_error: 'disabledMedia is an object of media kinds.' }).nullish(),
    timezone: text('timezone is a zone name, like Europe/Amsterdam.').nullish(),
    canvasScope: text('canvasScope is the key of the layer on screen.').nullish(),
    seedMetadata: closedObject({
        title: worded('seedMetadata.title is text.').optional(),
        description: worded('seedMetadata.description is text.').optional(),
    }, 'seedMetadata').nullish(),
}, 'A builder turn');
const TurnQuery = queryOf({
    resume: choice(['1', 'true'], 'resume is 1 when reconnecting; leave it out otherwise.').optional(),
}, 'The builder stream');

// The AI may need: propose_trigger → multiple add_*  → summarise → dry_run
// → fix → dry_run → finalize. This is a ceiling; the per-model profile
// (server/automation/builderModelProfiles.js) chooses its own budget within
// this ceiling — small / reasoning models get more headroom because they
// take more turns to converge.
const MAX_ITERATIONS = 24;

// ── Stopping a turn the model cannot finish ─────────────────────────
//
// Two stops besides the iteration budget. `repeated_rejection`: the repeat
// ladder (builderTools.js rejectionLadder) stamps `_stop` on the third
// identical rejection — measured 2026-09-12/13 with the fast local model,
// which resent one refused batch three rounds running and a refused
// builder_update_steps fifteen times, "stop retrying" in the hint included.
// `no_progress`: four rounds in which EVERY call was refused, with the
// calls differing just enough to dodge the ladder. Both end the turn with
// one sentence to the user; nothing after the stop runs, so a finalize in
// the same reply cannot save a draft the model was still fighting with.
const WASTED_ROUNDS_LIMIT = 4;
const STOP_ERROR_HEAD = 200;

/** What to call the step that kept failing: its label, its tool, its type. */
function rejectedCallLabel(name, args, result) {
    const steps = Array.isArray(args?.steps) ? args.steps : null;
    const entry = name === 'builder_add_steps' && steps && Number.isInteger(result?.failedIndex) ? steps[result.failedIndex] : null;
    const spec = entry ? (entry.spec && typeof entry.spec === 'object' ? entry.spec : {}) : (args && typeof args === 'object' ? args : {});
    const type = entry ? entry.type : name.replace(/^builder_(add_)?/, '');
    return [spec.label, spec.tool, type].find(v => typeof v === 'string' && v) || name;
}

/**
 * The 1-based position the user sees for the step that was refused: the
 * batch entry's index; else the step the call names (an update); else the
 * slot a new step would have taken.
 */
function rejectedStepPosition(def, args, entryIndex) {
    if (Number.isInteger(entryIndex)) return entryIndex + 1;
    const steps = Array.isArray(def?.steps) ? def.steps : [];
    const stepId = typeof args?.stepId === 'string' ? args.stepId : null;
    const at = stepId ? steps.findIndex(s => s && s.id === stepId) : -1;
    return at >= 0 ? at + 1 : steps.length + 1;
}

/** ONE sentence for the user, the same in the stream and in the stored turn. */
function stopSentence(stop, def) {
    const k = Array.isArray(def?.steps) ? def.steps.length : 0;
    const inPlace = `${k} step${k === 1 ? '' : 's'} ${k === 1 ? 'is' : 'are'} in place.`;
    if (stop.reason === 'no_progress') {
        return `I made no progress for four rounds — the builder rejected every step I tried. ${inPlace} Tell me how to proceed.`;
    }
    const err = String(stop.error || '').replace(/\s+/g, ' ').trim();
    const cut = err.length > STOP_ERROR_HEAD ? `${err.slice(0, STOP_ERROR_HEAD).trimEnd()}…` : err;
    const head = /[.!?…]$/.test(cut) ? cut : `${cut}.`;
    return `I could not build step ${stop.position} (${stop.label}): the builder kept rejecting it — ${head} ${inPlace} Tell me how to proceed, or fix that step on the canvas.`;
}

// Catalog ORDERING for profiles that ask for it — see
// automation/builderPrompt/rankApps.js. It used to be a catalog FILTER, and
// that is what put `nextcloud_calendar_list` into an invoice routine:
//
//   - the substring matcher returned true for all 17 apps (every app id
//     contains "nextcloud"; stop words like "the" match some description
//     everywhere), so `.slice(0, 8)` kept the first eight in REGISTRY order —
//     memory, routine-evolution, kb-ingest, nextcloud, calendar, contacts,
//     deck, talk. `nextcloud-notifications` and `nextcloud-tables` were cut
//     even when the brief named them, and stayed cut when the user replied
//     "use Nextcloud Notifications, not the calendar";
//   - a short reply ("ok", "yes", "fix it") matched NOTHING, so the prompt
//     told the model `_(user has no integrations connected)_` — on a turn
//     where forceFirstToolCall makes a tool call mandatory;
//   - and because the surviving set was derived from the message, the system
//     prompt mutated every turn, invalidating the prefix cache the comment
//     below promises (~21k tokens re-prefilled per turn on the local box).
//
// Relevance now orders the catalogue and never removes from it, so none of
// those failure modes has anywhere to live.

router.post('/stream', requireAuth, builderRateLimit, validate({ query: TurnQuery, body: TurnBody }), async (req, res) => {
    const userId = req.session.user.id;
    const {
        message,
        builderSessionId: clientSession,
        automationId,
        modelTier = 'auto',
        history = [],
        attachments = [],
        webSearchEnabled = true,
        disabledMedia = {},
        timezone,
        // WS2/WS3 — the canvas scope the user is currently drilled into
        // (a flowlet key, or absent for the root flow). Used purely as a
        // prompt hint so the model defaults its tool calls' `scope` there.
        canvasScope,
        // A host's name for the draft this request creates (see the header).
        seedMetadata = null,
    } = req.body || {};
    // ?resume=1 — caller is reconnecting and wants the latest snapshot
    // re-emitted before the new message is processed. Additive: the regular
    // SSE flow continues exactly as before once the resume event lands.
    const wantsResume = req.query?.resume === '1' || req.query?.resume === 'true';

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    // Push the SSE response headers to the wire immediately, then keep the
    // connection warm with 10s pings. A thinking model can go silent for
    // 30–60s (deep reasoning between tool calls); without a heartbeat an
    // upstream gateway (Nextcloud AppAPI proxy / HaRP / ingress, ~30–60s idle
    // timeout) drops the connection and the embedded app sees a false 504
    // while the agent is still building — and never receives the thinking
    // stream. Same class as the chat/notebook fix (BFSF-221). The heartbeat
    // auto-stops on res close/finish/error.
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    const stopHeartbeat = startSseHeartbeat(res);
    const sendRaw = (event, data) => {
        try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
    };
    // The build loop writes through `send`. When an admin has configured a
    // narration model it is swapped for the thought narrator's wrapper right
    // before the loop; `done` / `error` always leave through sendRaw AFTER the
    // narrator has closed, so a late summary can never land on a turn that
    // has already ended.
    let send = sendRaw;
    let narrator = null;

    try {
        // Feature gate: 'automations' is a per-org beta feature.
        // Admins toggle it from the admin dashboard → Security → Beta.
        // Super admins always have access.
        const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
        const hasFeature = await userHasBetaFeature(userId, 'automations', req.session);
        if (!hasFeature) {
            send('error', { error: 'The Automations beta is not enabled for your organisation. Ask an administrator to enable it under Security → Beta Features.' });
            return res.end();
        }
        // Code steps are offered wherever they can run: there is no switch,
        // only the sandbox being installed.
        const codeStepEnabled = require('../../../automation/codeSandbox').isAvailable();

        // The tiers this turn may run on, read before a draft is loaded so a
        // refused turn leaves nothing behind. The map is EU-aware base tiers
        // plus custom tiers, the same source direct chat resolves against;
        // WHICH of them this person may use is core/entitlements/tierAccess,
        // for automation: the list the builder's own dropdown offers. It used
        // to be the map alone, so an explicit tier outside the person's groups
        // ran, and `auto` and the floor could land on any configured tier.
        const userOrgForTiers = req.session?.user?.organizationId || null;
        const tiers = await getUserTierMap({ userOrgId: userOrgForTiers, userId });
        const tierAccess = await tierAccessFor({ userId, session: req.session, taskType: 'automation' });
        const requestedTier = modelTier || 'fast';
        const permittedTiers = tierAccess.narrow(tiers);
        // What `auto`, and the floor after it, may choose from.
        const { candidates: autoTiers, refused: autoRefused } = tierAccess.autoChoice(tiers);
        if (!tierAccess.allows(requestedTier) || (requestedTier === 'auto' && autoRefused)) {
            const refusal = tierRefusal(requestedTier);
            log.info(`[AutomationBuilder] Tier "${requestedTier}" is not available to this user — refused`);
            send('error', { error: refusal.error, code: refusal.code });
            return res.end();
        }

        // Resolve / load the draft.
        let draftWrap = await loadOrCreateDraft({ userId, builderSessionId: clientSession, automationId, seedMetadata });
        send('builder_session', { builderSessionId: draftWrap.builderSessionId, automationId: draftWrap.automationId });

        // The persisted builder session is read on EVERY turn of an existing
        // draft, not only on ?resume=1: it carries session state the prompt
        // must replay verbatim — the catalogue order chosen on the first turn
        // (see rankApps.applyCatalogOrder) and the to-do list. Before this the
        // to-do list was only seeded on a resume, so a normal second turn
        // started from an empty plan while the comment further down claimed
        // it "survives across turns".
        let snapshot = null;
        if (draftWrap.automationId) {
            try { snapshot = await automationStore.getBuilderSession(draftWrap.automationId, userId); }
            catch (_) { snapshot = null; /* non-fatal */ }
        }
        // Resume support — when the client asks (?resume=1), re-emit the
        // last persisted snapshot before processing the new turn. The
        // client uses this to rehydrate any chat history + draft +
        // validation state that was lost on a dropped SSE.
        if (wantsResume && snapshot) {
            send('resume', { snapshot });
            if (Array.isArray(snapshot.todos) && snapshot.todos.length) send('plan', { todos: snapshot.todos });
        }
        // Per-turn to-do list (builder_set_plan), carried across turns.
        draftWrap._todos = Array.isArray(snapshot?.todos) ? snapshot.todos : [];
        // Catalogue order fixed on this session's first turn; null until then.
        const storedCatalogOrder = Array.isArray(snapshot?.catalogOrder) ? snapshot.catalogOrder : null;

        // Build catalog for the prompt. (Prompt construction is deferred
        // until after the model is resolved, so we can pick full vs. lean
        // prompt + apply per-model catalog filtering — see Step 5 of the
        // multi-model optimization in the plan file.)
        const catalog = await buildCatalogForUser(userId, req.session);

        // §B progressive context: index every catalog action's input schema by
        // tool name so builder_inspect_tool can return exact params on demand
        // (the slim prompt catalog only advertises an input count), and the
        // add-action gate can require an inspect before binding non-trivial
        // params. `_inspectedTools` tracks what the agent inspected this turn.
        //
        // Built from the catalog's `actions`, which buildCatalogForUser has
        // already narrowed to what this user can RUN. It used to be built from
        // the full TOOL_REGISTRY, and that is what let `unknownToolError` read
        // "the catalog knows this tool's schema" as "the user has this tool".
        // The two lists must come from one source or they drift back apart.
        draftWrap._inputSchemasByTool = {};
        for (const app of (catalog?.apps || [])) {
            for (const act of (app.actions || [])) {
                if (act && act.name && act.inputSchema) draftWrap._inputSchemasByTool[act.name] = act.inputSchema;
            }
        }
        // The authorisation set, and deliberately NOT derived from `apps`: the
        // resolved set also carries MCP, org-custom, agent-callable-routine and
        // Step tools, which own no TOOL_REGISTRY entry and so never appear in
        // `apps`. Gating on `apps` would refuse tools the user really has.
        // Nor is `_inputSchemasByTool` the authority — it is keyed on tools
        // that HAVE an input schema, so a parameterless tool would vanish.
        draftWrap._availableToolNames = catalog?.toolNames instanceof Set ? catalog.toolNames : null;
        draftWrap._inspectedTools = new Set();
        // The datatables THIS user may address — rendered into the prompt as
        // the "Datatables you may use" block and read by builder_add_datatable
        // for its id/key/column check. Two absent shapes, two meanings:
        // null = could not tell (store outage) → permissive, the same posture
        // as `_availableToolNames`; [] = the user has none → a datatable step
        // is refused. Before this the prompt pointed at "the catalog" for
        // table ids and the catalog carried apps only, so the model invented
        // `tbl_…` ids on every invoice brief.
        try {
            const { buildDatatableCatalogForUser } = require('../../../automation/builderDatatableCatalog');
            draftWrap._datatables = await buildDatatableCatalogForUser(userId);
        } catch (e) {
            log.warn('[AutomationBuilder] datatable catalog unavailable:', e.message);
            draftWrap._datatables = null;
        }
        catalog.datatables = draftWrap._datatables;

        // The DESIGNED documents this user may fill — rendered as the
        // "Documents you may fill" block and read by builder_add_fill_document
        // for its id/placeholder check. Same two absent shapes, same meanings
        // as the datatable list above.
        draftWrap._documentDiscoveryRequired = true;
        try {
            const { buildDocumentCatalogForUser } = require('../../../automation/builderDocumentCatalog');
            draftWrap._documents = await buildDocumentCatalogForUser(userId);
        } catch (e) {
            log.warn('[AutomationBuilder] document catalog unavailable:', e.message);
            draftWrap._documents = null;
        }
        catalog.documents = draftWrap._documents;

        // Human-readable summary — seeds `lastSummary` (the "What this
        // automation does" panel + builder_session snapshot). User-facing, so
        // it stays prose without raw step IDs.
        const summary = summariseDefinition(draftWrap.def).summary;
        // Agent context: a structured, ID-bearing view of the WHOLE draft
        // (main flow + every flowlet) with each step's settings and input
        // bindings, so the model reads real step IDs + current wiring instead
        // of asking the user for them. Rebuilt each turn from the live draft.
        const agentDraftState = renderAgentDraftState(draftWrap.def);

        // Resolve model — mirrors the direct-chat flow (server/routes/ai/directChat.js)
        // so the builder honours the same tier dropdown, EU overrides, custom
        // tiers, and 'auto' classification the user sees in direct chat —
        // within the tiers this person may use (read above).

        // The tiers the builder AI may put on an ai_step's `modelTier`:
        // exactly what this user's dropdown offers (plus 'auto'), never
        // 'swarm' (chat-only). applyAddAi/applyUpdateStep validate against
        // this set so the model can't pick a tier the user doesn't have.
        draftWrap._allowedModelTiers = new Set(['auto', ...Object.keys(permittedTiers).filter(k => k !== 'swarm' && k !== 'standard')]);

        let resolvedTier = requestedTier;
        if (resolvedTier === 'auto') {
            // The classifier's own fallbacks answer `fast` whether or not that
            // tier is in the map it was handed, so its answer is kept only when
            // it is one of this person's; otherwise the cheapest that is.
            const cheapestOwn = cheapestTier(Object.keys(autoTiers)) || 'fast';
            try {
                const { classifyWithLLM } = require('../../../core/llm/promptClassifier');
                // Same exclusions direct chat applies (custom tiers and swarm
                // require explicit user choice and never win auto), over the
                // person's own configured tiers only.
                const result = await classifyWithLLM(message || '', autoTiers, { userOrgId: userOrgForTiers, userId });
                resolvedTier = autoTiers[result.tier] ? result.tier : cheapestOwn;
                log.info(`[AutomationBuilder] Auto: tier="${resolvedTier}" (${result.method}: ${result.reason}${resolvedTier === result.tier ? '' : `; "${result.tier}" is not this user's`})`);
            } catch (err) {
                log.info(`[AutomationBuilder] Auto classification failed: ${err.message}, using ${cheapestOwn}`);
                resolvedTier = cheapestOwn;
            }
        }

        let modelId;
        let cfg;
        let tier = {};
        {
            tier = tiers[resolvedTier] || {};
            modelId = tier.modelId;
            if (!modelId) {
                const globalConfig = await getAIConfig();
                modelId = globalConfig?.model || null;
            }
            if (!modelId) {
                send('error', { error: `No model configured for tier ${resolvedTier}` });
                return res.end();
            }

            // Capability floor: assembling a typed DAG is far harder than chat, so
            // when the user left the builder on 'auto' we must not run on a
            // small/fast model — those emit malformed bindings and loop to the
            // iteration cap. Bump up to the first non-small tier. An explicit user
            // tier choice is always honoured. See builderModelProfiles.js.
            // It bumps within the person's own tiers, never onto one their
            // groups do not allow.
            // (Skipped for the local override: that model is small by design.)
            if (modelTier === 'auto' || !modelTier) {
                const floored = applyBuilderTierFloor(resolvedTier, modelId, autoTiers);
                if (floored.modelId !== modelId) {
                    log.info(`[AutomationBuilder] Auto floor: bumped small "${resolvedTier}" → "${floored.tier}" (${floored.modelId})`);
                    resolvedTier = floored.tier;
                    modelId = floored.modelId;
                    // The tier object drives reasoningEffort / reasoningSummary
                    // below — re-point it at the tier we actually run on, or
                    // the floored model inherits the small tier's settings.
                    tier = tiers[resolvedTier] || tier;
                }
            }

            cfg = await getProviderForModel(modelId);
        }
        const adapter = getAdapter(cfg.providerType, cfg.url);

        // Mirror direct chat: only emit model_selected when the *user* picked
        // 'auto', so the message bubble can render "Auto → <real tier>".
        if (modelTier === 'auto') {
            send('model_selected', { tier: resolvedTier, modelId });
        }

        // Narrated thinking line: a small side model turns the reasoning
        // stream into one present-tense phrase for the canvas (see
        // thoughtNarrator.js). Off unless an admin set the key; read once per
        // turn like the tier config so a config change never lands mid-build,
        // and never fatal — the client has its own fallbacks.
        let narrationModelId = '';
        try {
            const raw = await configStore.getConfig('builder_narration_model');
            narrationModelId = typeof raw === 'string' ? raw.trim() : '';
        } catch (_) { narrationModelId = ''; }

        // Pick the capability profile for this model. Drives prompt
        // variant, tool surface, temperature, iteration budget,
        // first-turn toolChoice enforcement, catalogue filtering, and
        // few-shot count. See server/automation/builderModelProfiles.js.
        // Optional admin override map `builder_model_profiles`
        // ({ "<modelId>": "<band>" }) for models the regex classifier gets
        // wrong; an unknown band is ignored (see getProfileForModel).
        let profileOverrides = null;
        try {
            const raw = await configStore.getConfig('builder_model_profiles');
            profileOverrides = raw && typeof raw === 'object' ? raw
                : (typeof raw === 'string' && raw.trim() ? JSON.parse(raw) : null);
        } catch (_) { profileOverrides = null; }
        const profile = getProfileForModel(modelId, profileOverrides);
        log.info(`[AutomationBuilder] model=${modelId} profile=${JSON.stringify(profile)}`);
        // Result-echo detail: lean (small-model) profiles keep the full
        // structured `_draftSteps` echo on every mutation — they rely on it —
        // while capable models get the compact id line (see applyToolCall).
        draftWrap._resultDetail = profile.promptVariant === 'lean' ? 'full' : 'compact';

        // Flowlet sub-agents (builder_generate_layer[s]) run on the THINKING
        // tier regardless of which model is driving the main chat — building
        // a whole sub-flow benefits from reasoning — when this person may use
        // it. Otherwise, as flowletAgent.resolveLayerAgentModel orders it,
        // fast, then the chat model itself; all from the person's own tiers,
        // where resolveLayerAgentModel read the whole map.
        const thinkingModelId = permittedTiers.thinking?.modelId || permittedTiers.fast?.modelId || modelId;
        // The catalogue in the profile's order. 'filtered' is a misnomer kept
        // for the profile field: relevance ORDERS the catalogue, it never
        // removes anything from it (rankApps.js).
        //
        // The order is chosen ONCE per session and replayed. rankAppsForMessage
        // scores against THIS message and pins the apps the draft uses, so its
        // output changed on every reply and as steps were added — and the
        // catalogue is rendered into the system prompt, the front of the prompt
        // cache. A session with a stored order never consults the reranker
        // again; the first turn (no snapshot yet) still ranks, and the result is
        // persisted with the builder session below.
        const promptCatalog = profile.catalogMode !== 'filtered'
            ? catalog
            : storedCatalogOrder
                ? applyCatalogOrder(catalog, storedCatalogOrder)
                : await rankAppsForMessage(catalog, message, draftWrap.def);
        const catalogOrder = profile.catalogMode === 'filtered' ? catalogOrderOf(promptCatalog) : null;

        // Pre-inspected schemas for the tools relevant to this message/draft
        // (§WS8 — makes zero inspect rounds the common case). Part of the
        // per-turn dynamic message, never of the system prompt.
        const def0 = draftWrap.def || {};
        const draftIsEmpty = !def0.trigger
            && !(Array.isArray(def0.steps) && def0.steps.length)
            && !Object.keys(def0.layers || {}).length;
        let schemaPart = null;
        if (profile.schemaInjection) {
            try {
                // FULL catalog (permission-gated upstream by buildCatalogForUser),
                // not the small-profile filtered one.
                const { renderRelevantToolSchemas } = require('../../../automation/builderPrompt/catalogRender');
                const relevant = renderRelevantToolSchemas(catalog, message, draftWrap.def, { max: 10 });
                if (relevant) {
                    schemaPart = relevant.text;
                    for (const t of relevant.tools) draftWrap._inspectedTools.add(t);
                }
            } catch (e) { log.warn('[AutomationBuilder] schema injection skipped:', e.message); }
        }

        // Compose the turn: [system] [few-shots] [history window] [dyn] [user].
        // Everything before `dyn` is a pure function of session state, so the
        // prompt-prefix cache survives from one user turn to the next; the
        // draft state, pre-inspected schemas and this turn's preferences
        // (timezone, web search, disabled media, allowed tiers — all read per
        // request) ride in the late dynamic message. See turnMessages.js.
        const { sys, fewShotMessages, windowedHistory, messages } = composeTurnMessages({
            profile, modelId, promptCatalog, codeStepEnabled,
            history, message, attachments,
            agentDraftState, draftIsEmpty, canvasScope, schemaPart,
            // The draft-state message opens with the name, or with the fact
            // that there is none yet (renderDraftStateSystemMessage).
            title: draftWrap.title,
            turnPrefs: {
                userTimezone: timezone || 'Europe/Amsterdam',
                webSearchEnabled: !!webSearchEnabled,
                disabledMedia: disabledMedia || {},
                // The ONLY ai_step modelTier values this user has (validated
                // server-side by modelTierGateError as well).
                allowedModelTiers: [...draftWrap._allowedModelTiers],
            },
        });

        // Filter the tool schema set: by feature flag AND by profile.
        // The 'core' subset shrinks the tool menu from 26 to 13 for small
        // models. The five legacy array tools are still listed in full
        // mode so existing chat histories keep validating; core mode
        // hides them in favour of the unified builder_add_array_op.
        let tools = TOOL_SCHEMAS.filter(t => codeStepEnabled || t.function.name !== 'builder_add_code_step');
        if (profile.toolset === 'core') {
            tools = tools.filter(t => CORE_TOOL_NAMES.has(t.function.name));
        }
        // The band's schema variant: 'lean' (small) hands the model the diet
        // in builderTools/schemaProjection.js — shorter texts, shared params
        // once, four tools fewer; 'full' is the identity and keeps the very
        // objects the cloud bands' prompt caches hold.
        tools = projectToolSchemas(tools, { variant: profile.schemaVariant });

        // Inspection tools: if the user has the webpages beta, expose the
        // same surface the direct-chat AI uses (schema/query/exec, file
        // read/write/replace/patch, set metadata, create, list). The builder
        // calls them while designing the automation so it can read the real
        // table columns before drafting an INSERT, etc.
        let webpageInspectorEnabled = false;
        let webpageInspectorCtx = null;
        try {
            const { userHasBetaFeature } = require('../../../core/entitlements/betaFeatures');
            webpageInspectorEnabled = await userHasBetaFeature(userId, 'webpages', req.session);
        } catch (_) { /* default false */ }
        if (webpageInspectorEnabled) {
            const { WEBPAGE_AUTOMATION_TOOLS } = require('../../../integrations/webpageAutomationTools');
            const { resolveUserGroups } = require('../../../auth/audience');
            const { resolveUserOrgIds } = require('../../../auth/permissions');
            const userGroupIds = await resolveUserGroups(userId).catch(() => []);
            const orgIdsSet = await resolveUserOrgIds(req).catch(() => null);
            const userOrgIds = orgIdsSet instanceof Set ? [...orgIdsSet] : [];
            webpageInspectorCtx = {
                userId,
                organizationId: req.session?.user?.organizationId || null,
                userGroupIds,
                userOrgIds,
            };
            // Only for profiles carrying the FULL tool menu. This push happens
            // after the CORE_TOOL_NAMES filter above, so on a small model it
            // silently re-expanded a deliberately reduced menu with six tools
            // the LEAN prompt documents nowhere (the webpage guidance lives
            // only in buildFullSystemPrompt). Given undocumented database
            // tools, a small model uses them: a measured invoice build added
            // `webpages_list`, `webpage_db_schema` and `webpage_db_exec` steps
            // alongside the spreadsheet it had already been asked for.
            if (profile.toolset === 'full') {
                for (const tool of WEBPAGE_AUTOMATION_TOOLS) {
                    if (!tools.find(t => t.function.name === tool.function.name)) tools.push(tool);
                }
            } else {
                webpageInspectorEnabled = false;
            }
        }
        const { isWebpageAutomationTool, executeWebpageAutomationTool } = require('../../../integrations/webpageAutomationTools');
        // The webpage tools above are the org's own tools (the dispatcher's
        // webpage_db_query / webpage_file_read / ...), called here on behalf of
        // the builder's model. The Privacy Shield tool block lists ("Outside
        // tools" / "Own server") hold for them as in direct chat (BFSF-354):
        // the turn's shield, resolved on the first such call only. A failed
        // lookup leaves the lists unapplied, as a missing shield does.
        const toolPiiGate = require('../../../core/privacy/toolPiiGate');
        let shieldLookup = null; // started by the first webpage tool call
        const webpageToolGate = toolPiiGate.toolLoopGate({
            shield: () => (shieldLookup ??= toolPiiGate.resolveToolShield(
                () => require('../../../core/privacy/orgShield').resolveShieldFor({ orgId: userOrgForTiers, userId }), 'AutomationBuilder')),
            tag: 'AutomationBuilder',
            // This turn's attribution, read when the row is written.
            audit: (fields) => require('../../../stores/guardrailEventStore').logGuardrailEvent({
                organization_id: userOrgForTiers, user_id: userId, automation_id: draftWrap.automationId || null,
                ...fields, source: 'automation_builder', model: modelId || null,
            }),
        });

        // One line per turn to SEE prefix stability in the logs: two consecutive
        // turns of a session must print the same sys= / tools= / toolBytes= /
        // fewShots= digests — and on the small band (catalogPlacement
        // 'dynamic') two SESSIONS of two USERS must too, or the local runtime's
        // prompt cache is re-filled on every new build. tools= is the name
        // list, toolBytes= the serialised schemas the model reads.
        log.info(`[AutomationBuilder] prefix sys=${systemPrefixFingerprint(sys)} tools=${toolSetFingerprint(tools)} toolBytes=${toolBytesFingerprint(tools)} fewShots=${systemPrefixFingerprint(JSON.stringify(fewShotMessages))} n=${fewShotMessages.length} history=${windowedHistory.length}`);

        // What the routine is about, for the deterministic title fallback
        // (deriveTitle.js): the FIRST user message of the session — the brief
        // — when there is history, else this message.
        const firstUserTurn = Array.isArray(history) ? history.find(m => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim()) : null;
        const brief = firstUserTurn ? firstUserTurn.content : (message || '');
        /** The `metadata` event: the draft's name as it now stands. */
        const sendMetadata = () => send('metadata', { automationId: draftWrap.automationId, title: draftWrap.title, description: draftWrap.description || '' });

        // The profile sets a higher cap than the legacy MAX_ITERATIONS
        // when needed (e.g. small models that take more turns to
        // converge). Clamp to the hard ceiling so a bad profile can't
        // burn unbounded tokens.
        const iterationBudget = Math.min(profile.maxIterations || 16, MAX_ITERATIONS);

        // Stop the (multi-iteration, LLM-token-burning) build loop the moment
        // the client disconnects — otherwise a user who closes the tab or
        // navigates away leaves the agent looping, calling the model and tools,
        // running up cost with nowhere to send the output.
        let clientGone = false;
        // An AbortController as well as the flag: the flag is only read at the
        // TOP of the next iteration, so without this a closed tab still ran the
        // CURRENT round to the max_tokens cap — on a self-hosted box, on the
        // model's only slot. streamWithRetry forwards the signal to the adapter.
        const clientAbort = new AbortController();
        req.on('close', () => {
            clientGone = true;
            try { clientAbort.abort(); } catch (_) { /* already aborted */ }
        });

        let lastFinalized = false;
        let lastValidation = null;
        let lastSummary = summary || null;
        // Why the loop ended early, when it did: { reason, tool, error, label,
        // position } — see the stop block after the tool loop. Null means the
        // model finished or the budget ran out.
        let stopReason = null;
        // Rounds in a row in which every tool call was refused. Such a round
        // built nothing and taught the model one error message — it is
        // charged an extra iteration, and four of them end the turn.
        let wastedRounds = 0;
        // Per-turn token accounting (WS1). Purely observational — no budget
        // enforcement — but it makes every optimization below measurable and
        // surfaces regressions in prod logs.
        const usageTotals = { prompt: 0, completion: 0, cached: 0, cacheCreation: 0, rounds: 0 };
        // ONE reasoning effort for every round of the turn. The per-round
        // schedule (WS7: deeper on iteration 0 and after a failure signal,
        // lighter on continuation rounds) and the one-off "thinking off" retry
        // after a truncated reply are gone: on the local adapter the effort
        // level renders into the chat template's tail (enable_thinking,
        // reasoning_effort, temperature — local.js), so flipping it between
        // rounds re-rendered the template and cost a prefix re-read mid-build.
        // With a fixed level every round of the turn shares one template tail.
        //
        // The trade-off: a thinking tier that runs out of room while reasoning
        // now gets the same effort on its single retry, so it may truncate
        // twice and end with the existing error message instead of being
        // rescued by a thinking-off round. Accepted — on the demo box the Fast
        // tier is 'none' (effortForIteration honours the tier's own setting
        // over the schedule), and cloud tiers rarely hit 8192 tokens of
        // thinking before a tool call.
        const turnEffort = effortForIteration(0, false, profile, tier.reasoningEffort);
        let truncationRetries = 0;
        let emptyReplyRetries = 0;   // a round with neither a tool call nor text — one nudge, then a plain message
        // Repair rounds spent on unparseable tool arguments. Bounded: a model
        // that cannot write valid JSON twice will not manage it on the tenth
        // try, and each attempt costs a full round on a single-slot box.
        let invalidArgsRetries = 0;
        // One re-pin of tool_choice after a prose round on an empty draft.
        let repinToolChoice = false;
        let prosePinUsed = false;
        const INVALID_ARGS_MAX_RETRIES = 2;
        // Every event the loop emits from here on passes the narrator, which
        // observes only `thinking` / `thinking_stop` and forwards the rest
        // untouched. The wrap happens here, not at declaration, so the
        // pre-loop events (session, resume, model_selected) stay a plain write.
        if (narrationModelId) {
            narrator = createThoughtNarrator({ send: sendRaw, modelId: narrationModelId });
            send = narrator.wrap(sendRaw);
        }
        let iter = 0;
        for (iter = 0; iter < iterationBudget; iter++) {
            if (clientGone || res.writableEnded) {
                log.info('[automationBuilder/stream] client disconnected — aborting build loop');
                if (narrator) narrator.close();
                break;
            }
            // First iteration on small / reasoning profiles: force a
            // tool call so the model can't fall back to prose. From
            // iteration 2 onward it's 'auto' — the model legitimately
            // needs to emit text once it's done mutating the draft.
            // Forcing a specific tool is incompatible with extended thinking
            // (Anthropic rejects tool_choice other than auto/none when thinking
            // is on). It can't actually collide here — forceFirstToolCall is only
            // set on the 'small' profile, whose models aren't reasoning-capable so
            // buildThinking no-ops — but guard anyway for safety.
            // Pinned on round 0, and pinned AGAIN for one round when the model
            // answered in prose while the draft is still empty.
            //
            // `forceFirstToolCall` exists because these models drop to prose
            // instead of building; releasing the pin after a single round left
            // that failure wide open from round 1 on, and prose with any content
            // is read as "done" further down — so a build request could end,
            // silently and successfully, with an empty canvas. Re-pinning costs
            // one round and only happens when nothing has been built yet, so a
            // model that has already made progress can still stop and talk.
            // Verified on the demo box 2026-09-16: llama-server honours
            // tool_choice:'required' on later rounds, not just the first.
            const turnToolChoice = (profile.forceFirstToolCall && (iter === 0 || repinToolChoice))
                ? 'required'
                : 'auto';
            repinToolChoice = false;
            let response;
            try {
                // Announce the round before the model call. On the local box the
                // first round's prefill takes ~200 s and the client renders a
                // waiting card for it; it needs the prompt size to hint how long.
                // The narrator wrapper forwards unknown events; old clients
                // ignore it.
                send('round_start', {
                    iter, modelId, promptChars: JSON.stringify(messages).length, effort: turnEffort,
                    // Lets the client say "on this machine, nothing sent
                    // outside" and expect a prefill measurement.
                    local: isLocalProviderType(cfg.providerType),
                    providerType: cfg.providerType || null,
                });
                // Per-round gates for the two live visualisations. A new pair
                // each round: the first delta of a round always lands at once.
                const draftGate = makeDraftThrottle();
                const progressGate = makeProgressThrottle();
                // Stream the turn so the chat panel shows reasoning + text + tool
                // calls live (parity with direct/agent chat) instead of one
                // batched dump. reasoningEffort enables extended thinking on
                // capable models (Opus/Sonnet); the adapter no-ops it otherwise.
                response = await streamWithRetry(adapter, cfg, modelId, messages, {
                    // 8192 (was 4096): a complex turn can chain several tool
                    // calls whose JSON arguments don't fit in 4k — truncation
                    // there produces invalid tool-call JSON. The extra headroom
                    // makes that rare; the parse guard below catches the rest.
                    maxTokens: 8192,
                    temperature: typeof profile.temperature === 'number' ? profile.temperature : 0.2,
                    tools,
                    toolChoice: turnToolChoice,
                    reasoningEffort: turnEffort,
                    // OpenAI reasoning models stream NO thinking unless a
                    // summary is requested (buildReasoningParams) — without
                    // this the builder showed an empty "Thinking…" bubble on
                    // o-series/GPT-5 tiers. Honour the tier's own setting,
                    // default to 'auto' (visible thinking is a builder
                    // feature); Claude/Gemini ignore the option.
                    reasoningSummary: tier.reasoningSummary !== undefined ? tier.reasoningSummary : 'auto',
                    // OpenAI-only cache routing hint (_applyCacheHints); the
                    // other adapters ignore unknown options.
                    promptCacheKey: draftWrap.builderSessionId || undefined,
                    userId: String(userId),
                }, {
                    send,
                    signal: clientAbort.signal,
                    // The steps a tool call already describes while its
                    // arguments are still streaming (contract: tool_draft).
                    // Throttled to one per 250 ms, plus one at once whenever a
                    // derived field changes. The tool_call event that follows
                    // clears it on the client.
                    onToolArgsDelta: ({ name, partial }) => {
                        const text = typeof partial === 'string' ? partial : '';
                        const scan = scanToolDraft(name, text);
                        if (!draftGate(deriveDraftKey(scan))) return;
                        send('tool_draft', { iter, name, chars: text.length, count: scan.count, capped: !!scan.capped, steps: scan.steps, inspect: scan.inspect });
                    },
                    // llama-server prefill progress; ≤ 4/s, the completing
                    // chunk always passes.
                    onPromptProgress: ({ total, cache, processed, time_ms }) => {
                        const done = total > 0 && processed >= total;
                        if (!progressGate(done)) return;
                        send('prompt_progress', { iter, total, cache, processed, timeMs: time_ms });
                    },
                });
            } catch (chatErr) {
                // The draft is persisted after every mutation, so end the turn
                // gracefully either way. But say the TRUE thing: a 4xx other
                // than 429/408 is a permanent rejection — the same request fails
                // the same way, and "please send your message again" sends the
                // user into a loop. Measured 2026-09-11: a chat template that
                // refuses a mid-conversation system message returned 400 twice
                // while the UI called it temporary and the owner saw only a
                // build that died instantly.
                const status = Number(chatErr?.status || chatErr?.statusCode
                    || (/API error (\d{3})/.exec(String(chatErr?.message || '')) || [])[1]) || null;
                const permanent = !!status && status >= 400 && status < 500 && status !== 408 && status !== 429;
                log.error('[AutomationBuilder] chat failed after retries:', chatErr.message);
                if (permanent) {
                    send('error', {
                        error: `The AI model rejected the request (HTTP ${status}): ${providerErrorExcerpt(chatErr.message)} — Your draft is saved. Resending will not help; check the model or tier settings.`,
                        transient: false,
                    });
                } else {
                    send('error', { error: 'The AI provider had a temporary problem. Your draft is saved — please send your message again.', transient: true });
                }
                break;
            }

            // Assistant text + thinking already streamed live via streamWithRetry.

            // Token accounting: accumulate this round's usage and surface it
            // (additive SSE event — clients that don't know it ignore it).
            if (response.usage) {
                accumulateUsage(usageTotals, response.usage);
                send('usage', { iter, effort: turnEffort, ...response.usage, totals: { ...usageTotals } });
            }

            // Signed thinking blocks for replay: Anthropic requires the thinking
            // that preceded a turn's tool_use to be re-sent on the next request.
            //
            // On a self-hosted runtime that hands reasoning back as plain text
            // (adapter.surfacesRawReasoning() — providers/local.js), the
            // UNSIGNED parts are kept too, as {text} only: the local adapter
            // maps `thinking` on an assistant tool-call message to
            // `reasoning_content` when the request thinks, and Gemma 4 /
            // Qwen3 re-read the reasoning that led to a call in the same turn
            // instead of re-deriving it every round. Nothing else reads an
            // unsigned part (the Claude adapter drops them).
            const surfacesRawReasoning = typeof adapter.surfacesRawReasoning === 'function' && adapter.surfacesRawReasoning() === true;
            const thinkingForReplay = (response.thinkingParts || [])
                .filter(p => p.text && !p.redacted && (p.signature || surfacesRawReasoning))
                .map(p => (p.signature
                    ? { text: p.text, signature: p.signature, redacted: p.redacted || undefined }
                    : { text: p.text }));

            // A call the model WROTE instead of made — Gemma 4 puts it in its
            // thought channel in its own wire syntax, which the runtime's parser
            // does not read there, so the round arrives as reasoning text with
            // no tool call and stop='stop' (measured on the app builder
            // 2026-09-13; the same model drives this one). The grammar is small
            // and the call is right there: parse it and run it like any other,
            // and tell the model in the tool result (core/llm/leakedToolCalls).
            let recoveredRound = null;
            if (!response.toolCalls || !response.toolCalls.length) {
                const toolNameSet = new Set(tools.map(t => t && t.function && t.function.name).filter(Boolean));
                recoveredRound = recoverLeakedToolCalls(response, { toolNames: toolNameSet, iter });
                if (recoveredRound.toolCalls.length) {
                    log.warn(`[AutomationBuilder] round ${iter}: recovered ${recoveredRound.toolCalls.length} tool call(s) written as text in the model's ${recoveredRound.sources.join('/')} (${recoveredRound.toolCalls.map(tc => tc.function.name).join(', ')})`);
                    response.toolCalls = recoveredRound.toolCalls;
                    response.content = recoveredRound.content;
                }
            }

            if (response.toolCalls && response.toolCalls.length) {
                messages.push({
                    role: 'assistant',
                    content: response.content || null,
                    ...(thinkingForReplay.length ? { thinking: thinkingForReplay } : {}),
                    tool_calls: response.toolCalls.map(tc => ({
                        id: tc.id, type: 'function',
                        function: {
                            name: tc.function.name,
                            arguments: typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments),
                        },
                        _thought_signature: tc._thought_signature || undefined,
                        _raw_content_parts: tc._raw_content_parts || undefined,
                    })),
                });
                let mutatedThisIter = false;
                let testedThisIter = false;   // round included dry_run/finalize
                // The wasted-round charge: a round counts as wasted only when
                // it had calls and none of them was accepted.
                let acceptedThisIter = false;
                let refusedThisIter = false;
                // The first `_stop` a result carried this round, with what the
                // user needs to hear about it. Set once; never overwritten.
                let stopHit = null;
                // The last refusal of the round — what `no_progress` reports.
                let lastRefusal = null;
                for (const tc of response.toolCalls) {
                    const name = tc.function.name;
                    const { args, truncated } = parseToolArgs(tc.function.arguments, name);
                    let toolResult;
                    // Set when an org tool ran, so the model's copy of its
                    // result goes through the tool block lists (BFSF-354).
                    let shieldModelCopy = false;
                    if (stopHit) {
                        // The turn is over. The calls after the stop are not
                        // run — a finalize in the same reply would save a draft
                        // the model was still fighting with — but each still
                        // gets its tool message so the assistant turn stays
                        // well-formed in the stored session.
                        toolResult = {
                            error: `Not run: the build stopped before this call (${stopHit.reason}).`,
                            _fixHint: 'Reject reason: the build was stopped after a repeated rejection, so this call was not executed. Wait for the user.',
                            _skipped: true,
                        };
                        send('tool_call', { name, arguments: args, result: toolResult });
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
                        continue;
                    }
                    if (truncated) {
                        // Arguments didn't parse as JSON — almost always a
                        // mid-call truncation. Running the tool with empty args
                        // yields a confusing generic error and a blind retry;
                        // instead tell the model exactly what happened so it
                        // resends just this one call. Still push a tool message
                        // so the assistant turn stays well-formed.
                        toolResult = { error: `Your arguments for ${name} were not valid JSON (likely truncated mid-call). Resend just THIS single tool call with complete, valid JSON arguments.`, _truncated: true };
                        send('tool_call', { name, arguments: {}, result: toolResult });
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(toolResult) });
                        refusedThisIter = true;
                        lastRefusal = { tool: name, error: toolResult.error, label: name };
                        continue;
                    }
                    // ── Self-planning (route-handled, non-mutating): record the
                    //    agent's to-do list and surface it to the user. ──
                    if (name === 'builder_set_plan') {
                        // Full-list form replaces the plan; the cheap
                        // `markDone` diff form flips existing items so a
                        // progress update doesn't resend the whole list.
                        const todos = (Array.isArray(args.todos) && args.todos.length)
                            ? normalizePlanTodos(args.todos)
                            : applyPlanMarkDone(draftWrap._todos || [], args.markDone);
                        draftWrap._todos = todos;
                        // Echo the LIST, not a count. This is the model's only
                        // cross-round memory of its own plan: with {ok,count} it
                        // had nowhere to read the plan back from and re-derived
                        // it from the user's message on every round. `i` is
                        // load-bearing — markDone takes 0-based indices.
                        const planResult = {
                            ok: true,
                            todos: todos.map((t, i) => ({ i, text: t.text, done: !!t.done })),
                            next: (todos.find(t => !t.done) || {}).text || null,
                        };
                        send('plan', { todos });
                        send('tool_call', { name, arguments: args, result: planResult });
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(planResult) });
                        acceptedThisIter = true;
                        continue;
                    }
                    // ── Flowlet delegation (route-handled): spawn one or several
                    //    thinking-model sub-agents to build whole flowlet(s),
                    //    merge into the draft, persist + emit a draft snapshot,
                    //    and let the post-loop validator feed errors back. ──
                    if (name === 'builder_generate_layer' || name === 'builder_generate_layers') {
                        try {
                            toolResult = await runDelegationTool(name, args, {
                                draftWrap, thinkingModelId, userId,
                                userOrgId: userOrgForTiers, session: req.session,
                                catalog, send,
                            });
                        } catch (e) { toolResult = { error: e.message }; }
                        send('tool_call', { name, arguments: args, result: toolResult });
                        await persistDraftWrap(draftWrap);
                        send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
                        mutatedThisIter = true; // post-loop validation feedback runs
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: typeof toolResult === 'string' ? toolResult : truncateToolResultJson(toolResult) });
                        if (toolResult && typeof toolResult === 'object' && toolResult.error) {
                            refusedThisIter = true;
                            lastRefusal = { tool: name, error: String(toolResult.error), label: rejectedCallLabel(name, args, toolResult) };
                        } else {
                            acceptedThisIter = true;
                        }
                        continue;
                    }
                    // A finalize on an untitled draft names it first (persistDraft
                    // writes the title inside the finalize call, so this must run
                    // BEFORE it). The result then says so, and the model can still
                    // rename with builder_set_metadata.
                    const titleBefore = draftWrap.title;
                    const titled = name === 'builder_finalize' ? ensureDraftTitle(draftWrap, { brief }) : null;
                    try {
                        if (webpageInspectorEnabled && isWebpageAutomationTool(name)) {
                            const refusal = await webpageToolGate.refuse(name, args);
                            if (refusal) {
                                toolResult = { error: refusal.modelError };
                            } else {
                                toolResult = await executeWebpageAutomationTool(name, args, webpageInspectorCtx);
                                shieldModelCopy = true;
                            }
                        } else {
                            // Announce a dry run the moment it exists (see
                            // builderTools: builder_request_dry_run → onRunCreated).
                            if (name === 'builder_request_dry_run') {
                                draftWrap._onDryRunStarted = (created) => send('dryrun_started', {
                                    run: { id: created.id, status: created.status || 'running', startedAt: created.startedAt || new Date().toISOString() },
                                });
                            }
                            toolResult = await applyToolCall(name, args, draftWrap);
                        }
                    } catch (e) { toolResult = { error: e.message }; }
                    if (tc._recovered && toolResult && typeof toolResult === 'object') {
                        // The model never made this call — it wrote it. Say so
                        // where it reads: the result.
                        toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), RECOVERED_CALL_HINT];
                    }
                    if (tc._repaired && toolResult && typeof toolResult === 'object') {
                        // The adapter closed a cut-off argument string after
                        // its last complete entry (base.js). The model has no
                        // other way to learn that its tail never arrived.
                        toolResult._hints = [...(Array.isArray(toolResult._hints) ? toolResult._hints : []), REPAIRED_CALL_HINT];
                    }
                    if (titled && titled.derived && !toolResult?.automation) {
                        // The finalize threw before it persisted (an update or a
                        // trigger resync failed): the name exists in memory only.
                        // Put the default back, or the end-of-turn naming below —
                        // which reads draftWrap.title — takes the draft for named
                        // and the row keeps "Untitled automation" with no
                        // `metadata` event ever sent.
                        draftWrap.title = titleBefore;
                    }
                    if (name === 'builder_finalize' && toolResult?.automation) {
                        // Block finalization when the current draft has any
                        // structural errors. This keeps a half-formed graph
                        // from being saved as "ready" — the LLM gets the
                        // structured errors back and self-corrects.
                        //
                        // BEFORE the plan tick and the `tool_call` event: this
                        // swap used to run after them, so the wire carried
                        // `{automation, ok:false}` for a refused finalize —
                        // scripts/drive-builder.js (`maxFailedCalls`) counted
                        // it as a success, the UI card showed one, and the
                        // plan tick read `{automation}` as "the build is over".
                        const finalCheck = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
                        if (!finalCheck.ok) {
                            lastValidation = finalCheck;
                            send('validation_errors', { errors: finalCheck.errors, warnings: finalCheck.warnings });
                            // Replace the success result with a diagnostic so
                            // the LLM sees this attempt failed.
                            toolResult = {
                                error: 'Cannot finalize: definition has validation errors. Address the errors below and try again.',
                                validation: finalCheck,
                            };
                        } else {
                            send('finalized', { automationId: toolResult.automation.id });
                            lastFinalized = true;
                        }
                        if (titled && titled.derived && toolResult && typeof toolResult === 'object') {
                            toolResult._hint = `Named "${titled.title}" automatically — call builder_set_metadata to rename.`;
                            sendMetadata();
                        }
                    }
                    // Tick the plan from what the call DID (planProgress.js). The
                    // model is told to markDone with every build call; the small
                    // local ones never do, and the owner watched a fully built
                    // routine sit at 0/9. Additive only — the model's own
                    // markDone keeps working. `_plan` rides on the tool result
                    // so the model reads its progress instead of re-deriving it.
                    //
                    // A PARTIAL batch (builder_add_steps refused entry i after
                    // building 0..i-1) is an error result whose `added` steps
                    // are in the draft — they tick the plan like any other
                    // append. inferPlanProgress reads nothing off an error
                    // result, so it is handed the built part only: the added
                    // list and the entries that produced it.
                    const partialBatch = toolResult && typeof toolResult === 'object' && toolResult.error
                        && Array.isArray(toolResult.added) && toolResult.added.length > 0;
                    if (Array.isArray(draftWrap._todos) && draftWrap._todos.length
                        && toolResult && typeof toolResult === 'object' && (!toolResult.error || partialBatch)) {
                        const evidence = partialBatch
                            ? {
                                name,
                                args: Array.isArray(args?.steps) && Number.isInteger(toolResult.failedIndex)
                                    ? { ...args, steps: args.steps.slice(0, toolResult.failedIndex) }
                                    : args,
                                result: { added: toolResult.added },
                            }
                            : { name, args, result: toolResult };
                        const ticked = inferPlanProgress(draftWrap._todos, evidence);
                        if (ticked.length) {
                            draftWrap._todos = applyPlanMarkDone(draftWrap._todos, ticked);
                            send('plan', { todos: draftWrap._todos });
                            toolResult._plan = {
                                markedDone: ticked,
                                next: (draftWrap._todos.find(t => !t.done) || {}).text || null,
                            };
                        }
                    }
                    send('tool_call', { name, arguments: args, result: toolResult });
                    // A rejected call, with the arguments that were rejected.
                    // The stored session keeps only the summary, so without
                    // this line a screenshot of the panel is all that survives
                    // of what the model actually sent (2026-09-12: two loops
                    // diagnosed from the picture, the third not at all).
                    //
                    // `repeat=` is the ladder rung the rejection sat on and
                    // `failedIndex=` the batch entry it named ('-' outside a
                    // batch), so a loop can be read off the log without
                    // replaying it. The cap is 20000 chars: at 4000 a full
                    // invoice batch was cut every time, and a cut line cannot
                    // become a fixture (scripts/builder-trace-from-log.mjs
                    // refuses both markers rather than replay half a call).
                    if (toolResult && typeof toolResult === 'object' && toolResult.error && mutates(name)) {
                        let shown = '';
                        try { shown = JSON.stringify(args); } catch (_) { shown = '[unserialisable]'; }
                        if (shown.length > 20000) shown = shown.slice(0, 20000) + '…[truncated]';
                        log.info(`[AutomationBuilder] rejected ${name} session=${draftWrap.builderSessionId}: repeat=${toolResult._repeated || 1} failedIndex=${toolResult.failedIndex ?? '-'} ${String(toolResult.error).slice(0, 400)} args=${shown}`);
                    }
                    // The ladder's third rung: the same call, refused three
                    // times. Remembered here; acted on after this call's
                    // bookkeeping (persist, validation) has run.
                    if (toolResult && typeof toolResult === 'object' && toolResult._stop && !stopHit) {
                        const s = toolResult._stop;
                        stopHit = {
                            reason: s.reason || 'repeated_rejection',
                            tool: s.tool || name,
                            error: String(s.error || toolResult.error || ''),
                            label: s.label || rejectedCallLabel(name, args, toolResult),
                            position: rejectedStepPosition(draftWrap.def, args, s.entryIndex),
                        };
                    }

                    // After every mutation, persist + emit a draft snapshot.
                    if (mutates(name)) {
                        await persistDraftWrap(draftWrap);
                        send('draft', { definition: draftWrap.def, automationId: draftWrap.automationId });
                        mutatedThisIter = true;
                    }
                    // The name changed — after the persist, so the event carries
                    // the id a first mutation just minted.
                    if (name === 'builder_set_metadata' && toolResult && typeof toolResult === 'object' && !toolResult.error) {
                        sendMetadata();
                    }
                    if (name === 'builder_summarise') {
                        send('summary', toolResult);
                        if (toolResult && typeof toolResult.summary === 'string') {
                            lastSummary = toolResult.summary;
                        }
                    }
                    if (name === 'builder_request_dry_run' && toolResult?.run) {
                        send('dryrun', { run: toolResult.run, steps: toolResult.steps || [] });
                    }
                    if (name === 'builder_request_dry_run') draftWrap._onDryRunStarted = null;
                    if (name === 'builder_request_dry_run' || name === 'builder_finalize') {
                        testedThisIter = true;
                    }

                    // Model-facing message: dry-run results get the compact
                    // projection (the client already received the full rows
                    // via the `dryrun` SSE event above); everything else goes
                    // through the JSON-safe truncation.
                    const modelResult = (name === 'builder_request_dry_run' && toolResult?.run)
                        ? compactDryRunForModel(toolResult)
                        : toolResult;
                    const modelContent = typeof modelResult === 'string' ? modelResult : truncateToolResultJson(modelResult);
                    messages.push({
                        role: 'tool',
                        tool_call_id: tc.id,
                        // An org tool's result with the categories its class
                        // forbids stripped out; the panel got the full result.
                        content: shieldModelCopy ? await webpageToolGate.forModel(modelContent, name) : modelContent,
                    });
                    // Counted on the result as it finally stands (a finalize
                    // refused for validation errors is a refusal). A PARTIAL
                    // batch is both: entry i was refused, but entries 0..i-1
                    // are in the draft — measured: four such rounds in a row,
                    // each landing steps, ended the turn as `no_progress`
                    // ("rejected every step I tried") and were charged the
                    // wasted-round iteration each time. `reused` entries are
                    // a resend of steps built earlier this turn, not progress.
                    if (toolResult && typeof toolResult === 'object' && toolResult.error) {
                        refusedThisIter = true;
                        lastRefusal = { tool: name, error: String(toolResult.error), label: rejectedCallLabel(name, args, toolResult) };
                        if (partialBatch && toolResult.added.some(a => !a?.reused)) acceptedThisIter = true;
                    } else {
                        acceptedThisIter = true;
                    }
                }

                // Validation feedback loop: after any mutation, validate the
                // draft and feed the structured records back to the LLM. This
                // is what lets the model self-correct on specific failures
                // (e.g. "you wired a condition with no edges") instead of
                // looping on prose.
                //
                // The note is a role:'user' message, NOT role:'system': the
                // Claude adapter hoists every system message into the
                // top-level system array (claude.js extractSystem), which
                // grew the system block mid-turn and invalidated the
                // message-tier cache breakpoints on every round after a
                // mutation; Google concatenates system messages into its
                // cache-keyed systemInstruction with the same effect. A
                // clearly-framed user message stays in chronological position
                // on every provider.
                //
                // Token gating: the model only NEEDS the full report when
                // there are errors. Warnings on a half-built graph are mostly
                // expected incompleteness (unwired branches, missing outputs)
                // and used to trigger premature "fix" rounds — so they ride
                // along as one compact codes line, and surface on their own
                // only on a dry-run/finalize round (the pre-flight moment
                // where completeness genuinely matters). The client SSE event
                // stays unfiltered — user-facing behaviour is unchanged.
                if (mutatedThisIter || testedThisIter) {
                    lastValidation = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
                    send('validation_errors', { errors: lastValidation.errors, warnings: lastValidation.warnings });
                    const note = renderValidationNote(lastValidation, { tested: testedThisIter });
                    if (note) messages.push({ role: 'user', content: note });
                }

                // ── Is this turn still going anywhere? ──
                // The ladder's stop wins. Otherwise a round in which every
                // call was refused is charged twice (iter += 1: it built
                // nothing, and the next round starts from the same draft with
                // one more error message), and the fourth such round in a row
                // is the stop — the model is changing its calls just enough
                // to dodge the ladder and not enough to land one. Any
                // accepted call resets the count: progress is progress.
                if (stopHit && !lastFinalized) {
                    stopReason = stopHit;
                } else if (refusedThisIter && !acceptedThisIter) {
                    wastedRounds += 1;
                    iter += 1;
                    if (wastedRounds >= WASTED_ROUNDS_LIMIT) {
                        stopReason = { reason: 'no_progress', ...(lastRefusal || { tool: null, error: '', label: null }) };
                    }
                } else if (acceptedThisIter) {
                    wastedRounds = 0;
                }
                if (stopReason) {
                    // ONE sentence, the same on the wire and in the stored
                    // turn (collectAssistantTurn reads the assistant message's
                    // content into the session snapshot — without this the
                    // next visit shows a build that just stopped talking).
                    const sentence = stopSentence(stopReason, draftWrap.def);
                    log.warn(`[AutomationBuilder] stopped session=${draftWrap.builderSessionId} reason=${stopReason.reason} tool=${stopReason.tool || '-'} iterations=${iter + 1}: ${sentence}`);
                    send('builder_aborted', {
                        reason: stopReason.reason,
                        iterations: iter + 1,
                        lastValidation: lastValidation || null,
                        rejected: { tool: stopReason.tool || null, error: stopReason.error || '', label: stopReason.label || null },
                    });
                    send('message', { content: `${response.content ? '\n\n' : ''}${sentence}` });
                    for (let i = messages.length - 1; i >= 0; i--) {
                        if (messages[i]?.role !== 'assistant') continue;
                        const a = messages[i];
                        a.content = [typeof a.content === 'string' ? a.content : '', sentence].filter(Boolean).join('\n\n');
                        break;
                    }
                    break;
                }

                if (lastFinalized) break;
                continue;
            }

            // No tool calls. Either the assistant produced its final message —
            // or it was cut off at max_tokens before getting to a tool call,
            // which on a thinking model means reasoning that never converged
            // (four such rounds in one evening on the demo box, 8192 tokens of
            // <think> each). The two look identical without the stop reason;
            // with it, retry ONCE — same effort level, see turnEffort above,
            // with a note telling the model to answer with the tool call
            // directly — instead of ending the turn in silence, and tell the
            // user plainly if that fails too.
            if (isTruncatedStop(response.finishReason)) {
                if (truncationRetries < 1) {
                    truncationRetries++;
                    messages.push(...truncationRetryMessages(response.content, thinkingForReplay));
                    log.warn(`[AutomationBuilder] round ${iter} hit max_tokens with no tool call (stop=${response.finishReason}); retrying once with a direct-answer note`);
                    continue;
                }
                send('error', { error: 'The model ran out of room while reasoning and never got to building. Switch the builder to a tier with thinking off, or shorten the request.', transient: false });
                break;
            }
            // A call the model DID make but wrote with broken JSON arguments.
            // The adapter cannot hand it up (base.js: echoing a half-written
            // call back is a 400 or a spin loop), so the round arrives looking
            // empty. Naming the tool and asking for that one call again is a
            // repair the model can actually perform — the blank-reply nudge
            // below is not, because it does not know what went wrong.
            if (!response.toolCalls && Array.isArray(response.invalidToolCalls) && response.invalidToolCalls.length
                && invalidArgsRetries < INVALID_ARGS_MAX_RETRIES) {
                invalidArgsRetries++;
                const names = response.invalidToolCalls.map(c => c.name).filter(Boolean);
                const label = names.length ? names.join(', ') : 'a tool';
                log.warn(`[AutomationBuilder] round ${iter}: ${response.invalidToolCalls.length} call(s) had unparseable arguments (${label}) — asking for a resend`);
                messages.push({
                    role: 'user',
                    content: `[Instructions from the system — not written by the user]\nYour arguments for ${label} were not valid JSON, so the call could not be run. Send just THAT call again, with complete, valid JSON arguments and nothing else. Keep it small: if the call was long, split it into two smaller calls.`,
                });
                continue;
            }
            // Neither a tool call nor a word for the user is not "done" either:
            // it is the round above with a call the server could NOT parse (an
            // unknown name, broken arguments), or a model that simply stopped.
            // Nudge once, naming what was seen; the second time tell the user
            // plainly instead of ending on a silent `done`.
            const emptyReply = isBlankReply(response.content);
            const rejectedLeaks = recoveredRound ? recoveredRound.rejected : [];
            if (emptyReply || rejectedLeaks.length) {
                if (emptyReplyRetries < 1) {
                    emptyReplyRetries++;
                    log.warn(`[AutomationBuilder] round ${iter} produced no tool call and no text${rejectedLeaks.length ? ` (${rejectedLeaks.length} call(s) written as text could not be recovered: ${rejectedLeaks.map(r => `${r.name || '?'}:${r.reason}`).join(', ')})` : ''} — nudging once`);
                    messages.push(...emptyReplyRetryMessages(response.content, thinkingForReplay, rejectedLeaks));
                    continue;
                }
                send('error', { error: 'The model stopped twice without calling a tool or saying anything — it wrote its next step as text instead of a call. Your draft is saved; send the message again, or switch the builder to another tier.', transient: false });
                break;
            }
            // Prose while the draft is still empty is not "done" — it is the
            // model talking about the build instead of doing it. Pin the next
            // round to a tool call once; if it talks again, let it through so a
            // genuine question or refusal can still reach the user.
            const draftHasSteps = Array.isArray(draftWrap?.def?.steps) && draftWrap.def.steps.length > 0;
            if (!prosePinUsed && profile.forceFirstToolCall && !draftHasSteps) {
                prosePinUsed = true;
                repinToolChoice = true;
                log.warn(`[AutomationBuilder] round ${iter} answered in prose with an empty draft — pinning one round to a tool call`);
                messages.push({ role: 'assistant', content: response.content });
                messages.push({
                    role: 'user',
                    content: '[Instructions from the system — not written by the user]\nNothing has been built yet. Make the next change by CALLING A TOOL now — do not describe it.',
                });
                continue;
            }
            // Assistant produced a final message; we're done with this turn.
            break;
        }

        // If the model exhausted its iteration budget without finalizing,
        // try to auto-finalize when the draft is structurally complete.
        // Small models sometimes run out of conversational turns AFTER
        // they've already produced a valid graph — abandoning the work
        // would force the user to start over, even though the routine
        // is ready. We only fall back when:
        //   - the draft passes validateDefinition,
        //   - it has a trigger and at least one step (non-empty), and
        //   - the model didn't itself call builder_finalize already.
        //
        // Never after a stop: a turn that ended because one step was refused
        // three times has a draft the model could not finish, and "your draft
        // validates — finalising as-is" would contradict the sentence the
        // user just read. (A wasted round is charged an extra iteration, so a
        // no_progress stop can land exactly on the budget.)
        // `iter >= iterationBudget` used to gate this too, so the net only
        // caught a build that ran OUT of rounds. Every other exit — a final
        // assistant message, a truncation give-up, two empty replies — left
        // `is_draft = true`, and the most common small-model ending is exactly
        // that: four good steps, a clean dry run, then "Your automation is
        // ready" with no builder_finalize. The playbook then read the turn as
        // unfinished and the presenter pressed Mark as done on stage.
        // The draft still has to pass validateDefinition and have a trigger and
        // a real step, so nothing half-built is finalised by this.
        if (!lastFinalized && !stopReason) {
            const finalCheck = validateDefinition(draftWrap.def, { deliverableEvents: getDeliverableEvents() });
            const def = draftWrap.def;
            const hasTrigger = !!def?.trigger;
            // A note (BFSF-411) is a canvas annotation, not a step the
            // routine runs — a draft the model only ever left a sticky note
            // on (never adding real work) must not read as "has a step" and
            // get auto-finalized as if it were a working routine.
            const hasStep = Array.isArray(def?.steps) && def.steps.some((s) => s?.type !== 'note');
            if (finalCheck.ok && hasTrigger && hasStep) {
                // Same rule as the model's own finalize: a routine never
                // ships as "Untitled automation".
                const titleBefore = draftWrap.title;
                const titled = ensureDraftTitle(draftWrap, { brief });
                try {
                    const finalized = await applyToolCall('builder_finalize', {}, draftWrap);
                    if (finalized?.automation) {
                        send('finalized', { automationId: finalized.automation.id, autoFinalized: true });
                        if (titled.derived) sendMetadata();
                        send('message', { content: 'I ran out of conversational turns but your draft validates — finalising as-is. Activate when ready.' });
                        lastFinalized = true;
                    }
                } catch (e) {
                    log.warn('[AutomationBuilder] auto-finalize failed:', e.message);
                }
                // Same as after the model's finalize: a name the failed call
                // never wrote goes back to the default, so the block below
                // persists it.
                if (titled.derived && !lastFinalized) draftWrap.title = titleBefore;
            }
            if (!lastFinalized) {
                send('builder_aborted', {
                    reason: 'max_iterations',
                    iterations: iterationBudget,
                    lastValidation: lastValidation || finalCheck || null,
                });
            }
        }

        // A draft that exists and is still untitled at the end of the turn —
        // not finalized, so neither path above named it (or tried and threw,
        // and put the default back) — gets its name now, so the list, the
        // header and the playbook rail never show the default. Only a
        // persisted draft: a turn that built nothing has no row to name.
        if (draftWrap.automationId && (!draftWrap.title || draftWrap.title === UNTITLED_AUTOMATION)) {
            try {
                const titled = ensureDraftTitle(draftWrap, { brief });
                if (titled.derived) {
                    await persistDraftWrap(draftWrap);
                    sendMetadata();
                }
            } catch (e) {
                log.warn('[AutomationBuilder] naming the draft failed:', e.message);
            }
        }

        // Snapshot for SSE-resume and for the next turn's prompt. Captures the
        // conversation so far (unsliced — the head-anchored window at compose
        // time bounds what the model sees), the assistant's reply with its
        // tool calls, the latest draft, the structured validation, any
        // summary, the to-do list, and the catalogue order this session
        // renders its system prompt in. The store trims oldest tool results
        // and then oldest messages past 64KB, in blocks of HISTORY_EVICT_BLOCK
        // so its trim lands on the same boundaries as the prompt window.
        if (draftWrap.automationId) {
            try {
                const lastUserMessage = { role: 'user', content: message || '' };
                const assistantOut = collectAssistantTurn(messages);
                await automationStore.setBuilderSession(draftWrap.automationId, userId, {
                    sessionId: draftWrap.builderSessionId,
                    draft: draftWrap.def,
                    lastValidation: lastValidation || null,
                    summary: lastSummary || null,
                    conversation: [
                        ...sanitizeHistory(history),
                        lastUserMessage,
                        ...(assistantOut ? [assistantOut] : []),
                    ],
                    todos: Array.isArray(draftWrap._todos) ? draftWrap._todos : [],
                    ...(catalogOrder ? { catalogOrder } : {}),
                    updatedAt: new Date().toISOString(),
                }, { trimBlock: HISTORY_EVICT_BLOCK });
            } catch (_) { /* non-fatal */ }
        }

        if (usageTotals.rounds > 0) {
            log.info(`[AutomationBuilder] usage session=${draftWrap.builderSessionId} model=${modelId} rounds=${usageTotals.rounds} in=${usageTotals.prompt} cached=${usageTotals.cached} cacheWrite=${usageTotals.cacheCreation} out=${usageTotals.completion}`);
        }
        if (narrator) narrator.close();
        sendRaw('done', { automationId: draftWrap.automationId, finalized: lastFinalized, iterations: iter, usage: usageTotals });
        stopHeartbeat();
        res.end();
    } catch (e) {
        log.error('[automationBuilder/stream] error:', e);
        if (narrator) narrator.close();
        sendRaw('error', { error: e.message });
        stopHeartbeat();
        res.end();
    }
});

module.exports = router;
