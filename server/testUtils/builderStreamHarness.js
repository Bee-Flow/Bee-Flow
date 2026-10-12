/**
 * Drive one whole turn of the Automation Builder's SSE endpoint
 * (routes/ai/automationBuilder/chatStream.js) in a unit test.
 *
 * That route is ~1400 lines of loop: a model round, a tool dispatch, a
 * persist, a validation note, a ladder, an auto-finalize, a naming pass. Its
 * test files used to read the file and pin those seams with regexes over the
 * source, because reaching the `send()` inside the loop means standing up the
 * whole turn — the feature gate, the draft store, the catalogs, a model round
 * and the tool dispatch. This is that scaffolding, once, so the seams can be
 * asserted on the events the client would actually receive.
 *
 * What is REAL: the route, the prompt composition (turnMessages/builderPrompt),
 * the tool menu and its lean projection, `mutates()`, validateDefinition,
 * deriveTitle/ensureDraftTitle, the draft load-or-create, the leaked-tool-call
 * recovery, planProgress, the thought narrator and the whole streaming shell
 * (builderShared → modelStream), including its thinking assembly and its two
 * visualisation hooks.
 *
 * What is SCRIPTED: the model (an adapter replaying a per-round event list),
 * the tool results (a name → handler map), the draft store, the config store
 * and the beta-feature gate. Everything a unit test has no business reaching.
 *
 *   const h = createBuilderStream();
 *   after(() => h.restore());
 *
 *   const run = await h.run({
 *       message: 'Bouw een factuurautomatisering',
 *       rounds: [ { toolCalls: [call('builder_add_steps', { steps: [] })] },
 *                 { text: 'Klaar.' } ],
 *       tools: { builder_add_steps: () => ({ ok: true, added: [] }) },
 *   });
 *   run.dataOf('metadata');     // every metadata event's payload
 *   run.roundMessages(0);       // the messages the first model round was given
 *
 * The stubs go into `require.cache` wholesale rather than through a
 * `Module._resolveFilename` patch: Node caches a relative resolution per
 * (directory, request), so a resolver patch reaches only whichever module in a
 * directory required a collaborator FIRST — and several modules in
 * routes/ai/automationBuilder/ share the same relative paths.
 */

'use strict';

const path = require('node:path');

const SERVER_DIR = path.join(__dirname, '..');
const resolveInServer = (rel) => require.resolve(path.join(SERVER_DIR, rel));

/** A deep, structured copy — the route mutates the arrays it hands around. */
const snapshot = (value) => (value === undefined ? undefined : structuredClone(value));

/** An adapter/tool-facing tool call, the shape the model's round produces. */
function call(name, args = {}, extra = {}) {
    return { name, args, ...extra };
}

/**
 * A db double for the stores that load anyway. Nothing in a builder turn
 * reaches SQL once the stores below are stubbed; this only keeps a store that
 * initialises at require time from opening a pool to a Postgres that is not
 * there.
 */
function silentDb() {
    const empty = { rows: [], rowCount: 0 };
    const client = { query: async () => empty, release: () => {} };
    return {
        pool: { query: async () => empty, on: () => {}, end: async () => {}, totalCount: 0, idleCount: 0, waitingCount: 0 },
        getRedis: async () => null,
        redisHealthy: () => false,
        disconnectRedis: async () => {},
        run: async () => empty,
        getOne: async () => null,
        getAll: async () => [],
        exec: async () => empty,
        getClient: async () => client,
        withTransaction: async (fn) => fn(client),
        makeStoreInit: () => async () => {},
        isSqlStateError: () => false,
        getPoolStats: () => ({ total: 0, idle: 0, waiting: 0 }),
        _runTransaction: async (fn) => fn(client),
        _instrumentClient: (c) => c,
    };
}

/**
 * Stand the route up with every collaborator a test needs to steer.
 * @returns {{ run: Function, restore: Function, router: Function }}
 */
function createBuilderStream() {
    // The stubs below are `require.cache` entries, so anything that already
    // captured the real module keeps it. A test file that requires one of the
    // route's own collaborators ABOVE its createBuilderStream() call therefore
    // hands the route a live database pool — and the only symptom is a turn
    // that never reaches its first model round, thirty seconds later. Say so
    // instead.
    const storeFile = resolveInServer('stores/automationStore');
    if (Object.prototype.hasOwnProperty.call(require.cache, storeFile)) {
        throw new Error('createBuilderStream() must run before the test file requires anything that loads stores/automationStore — move the call above those requires');
    }
    const undo = [];
    /** Replace a module's exports for the lifetime of this harness. */
    const swap = (rel, exports) => {
        const file = resolveInServer(rel);
        const had = Object.prototype.hasOwnProperty.call(require.cache, file);
        const prev = require.cache[file];
        require.cache[file] = { id: file, filename: file, loaded: true, exports, children: [], paths: [] };
        undo.push(() => { if (had) require.cache[file] = prev; else delete require.cache[file]; });
        return file;
    };

    // Per-run script; every stub below reads it, so the route is required once.
    let script = null;

    swap('db', silentDb());
    // The create-access check reads the principal, permissions and training
    // state; a turn here answers from the script instead (`datatableAccess`).
    // Swapped before anything that destructures it is loaded.
    swap('automation/builderTools/datatableCreateAccess', { async checkDatatableCreate() { return script.datatableAccess; } });

    const automationStore = {
        async getAutomation(id) { return script.automations[id] || null; },
        async getBuilderSession() { return script.builderSession; },
        async setBuilderSession(automationId, userId, payload, opts) {
            script.storedSessions.push({ automationId, userId, payload: snapshot(payload), opts });
        },
        async getRunSteps() { return []; },
    };
    swap('stores/automationStore', automationStore);
    swap('stores/configStore', { async getConfig(key) { return script.config[key]; } });

    swap('core/entitlements/betaFeatures', {
        async userHasBetaFeature(_userId, feature) { return script.betaFeatures.includes(feature); },
    });
    swap('core/aiAgent', {
        async getProviderForModel() { return script.providerConfig; },
        async getAIConfig() { return { model: script.modelId }; },
    });
    swap('core/llm/modelResolver', { async getUserTierMap() { return script.tiers; } });
    // chatStream destructures getAdapter at require time, so the seam has to
    // be one stable function that reads the run's adapter.
    swap('core/providers', { getAdapter: () => script.adapter });
    swap('automation/builderCatalog', { async buildCatalogForUser() { return snapshot(script.catalog); } });
    swap('automation/builderDatatableCatalog', { async buildDatatableCatalogForUser() { return script.datatables; } });
    swap('automation/builderDocumentCatalog', { async buildDocumentCatalogForUser() { return script.documents; } });
    // Agents / knowledge bases / app_event providers: scripted per run (`pickers`),
    // empty by default so a turn never reaches the agent or knowledge stores.
    swap('automation/builderPickerCatalog', { async buildPickerCatalogsForUser() { return snapshot(script.pickers) || {}; } });
    swap('automation/flowletAgent', { async resolveLayerAgentModel() { return script.thinkingModelId; } });
    // The delegation ctx rides along as the handler's third argument: it is
    // where the route says which model a flowlet sub-agent runs on.
    swap('routes/ai/automationBuilder/layerDelegation', {
        async runDelegationTool(name, args, ctx) { return script.dispatch(name, args, ctx.draftWrap, ctx); },
    });
    // A 10s ping interval would outlive the turn and hold the test process.
    swap('core/http/sseHelpers', { startSseHeartbeat: () => () => {} });
    swap('routes/ai/automationBuilder/rateLimits', { builderRateLimit: (_req, _res, next) => next() });

    // The real gate verifies the session against the database; the harness
    // owns req.session, so it only has to step aside.
    const realPermissions = require(resolveInServer('auth/permissions'));
    swap('auth/permissions', {
        ...realPermissions,
        requireAuth: (_req, _res, next) => next(),
        async resolveUserOrgIds() { return new Set(script.userOrgIds); },
    });

    // The tool menu, `mutates()` and the result truncation stay real; only the
    // dispatch is scripted.
    const realBuilderTools = require(resolveInServer('automation/builderTools'));
    swap('automation/builderTools', {
        ...realBuilderTools,
        async applyToolCall(name, args, draftWrap) { return script.dispatch(name, args, draftWrap); },
    });

    // load-or-create stays real (it is where seedMetadata lands); the persist
    // is the one step that would write SQL.
    const realDraft = require(resolveInServer('routes/ai/automationBuilder/builderDraft'));
    swap('routes/ai/automationBuilder/builderDraft', {
        ...realDraft,
        async persistDraftWrap(draftWrap) {
            if (!draftWrap.automationId) draftWrap.automationId = script.mintedAutomationId;
            script.persists.push({ automationId: draftWrap.automationId, title: draftWrap.title, def: snapshot(draftWrap.def) });
        },
    });

    const router = require(resolveInServer('routes/ai/automationBuilder/chatStream'));

    /**
     * One POST /stream, start to finish.
     *
     * @param {object} p
     * @param {string} [p.message]      the user's turn
     * @param {Array}  [p.rounds]       one entry per model round; see toEvents()
     * @param {object} [p.tools]        tool name → (args, draftWrap) => result
     * @param {object} [p.body]         extra request-body fields (seedMetadata, history, …)
     * @param {object} [p.draft]        the automations row an automationId resolves to
     * @param {object} [p.tiers]        the user's tier map
     * @param {object} [p.providerConfig]
     * @param {object} [p.catalog]
     * @param {object} [p.pickers]      what buildPickerCatalogsForUser answers (agents, knowledgeBases, appEventProviders, …)
     * @param {object} [p.config]       configStore answers
     */
    async function run({
        message = 'Bouw een automation',
        rounds = [{ text: 'Klaar.' }],
        tools = {},
        onTool = null,
        body = {},
        draft = null,
        builderSession = null,
        betaFeatures = ['automations'],
        tiers,
        modelId = 'claude-sonnet-4-5',
        providerConfig = { apiKey: 'k', url: 'https://example.invalid', providerType: 'claude' },
        surfacesRawReasoning = false,
        catalog,
        config = {},
        datatables = null,
        // What checkDatatableCreate answers (see above). Default: may create an org table.
        datatableAccess = { ok: true, scope: { kind: 'org', id: 'org1' }, principal: { userId: 'u1' }, hasManage: true },
        documents = null,
        pickers = null,
        mintedAutomationId = 'auto_minted',
        userId = 'u1',
        userOrgId = 'org1',
        userOrgIds = [],
        query = {},
    } = {}) {
        const modelRounds = [];
        const toolCalls = [];

        script = {
            automations: draft ? { [draft.id]: draft } : {},
            builderSession,
            storedSessions: [],
            persists: [],
            config: { ...config },
            betaFeatures,
            modelId,
            providerConfig,
            tiers: tiers || { fast: { modelId }, standard: { modelId } },
            catalog: catalog || { apps: [], toolNames: null, triggerOutputs: {} },
            datatables,
            datatableAccess,
            documents,
            pickers,
            thinkingModelId: modelId,
            mintedAutomationId,
            userOrgIds,
            dispatch: async (name, args, draftWrap, delegation) => {
                toolCalls.push({ name, args: snapshot(args) });
                const handler = onTool || tools[name];
                if (!handler) throw new Error(`the harness has no handler for tool ${name}`);
                return onTool ? onTool(name, args, draftWrap, delegation) : handler(args, draftWrap, delegation);
            },
        };

        const adapter = {
            surfacesRawReasoning: () => surfacesRawReasoning,
            async stream(_apiKey, _url, _modelId, messages, options, onEvent) {
                const spec = modelRounds.length < rounds.length ? rounds[modelRounds.length] : { text: 'Klaar.' };
                modelRounds.push({ messages: snapshot(messages), options: { ...options, tools: options.tools } });
                if (typeof spec === 'function') { await spec(onEvent, { messages, options }); return; }
                if (spec.throws) throw spec.throws;
                for (const [type, data] of toEvents(spec)) onEvent(type, data);
            },
        };
        script.adapter = adapter;

        const { req, res, done } = fakeExchange({ body: { message, ...body }, query, userId, userOrgId });
        let routerError = null;
        router(req, res, (err) => {
            routerError = err || new Error('POST /stream fell through the router');
            res.end();
        });
        await done;
        if (routerError) throw routerError;

        const events = parseSse(res.written.join(''));
        return {
            events,
            names: events.map((e) => e.event),
            dataOf: (name) => events.filter((e) => e.event === name).map((e) => e.data),
            first: (name) => (events.find((e) => e.event === name) || {}).data,
            last: (name) => [...events].reverse().find((e) => e.event === name)?.data,
            has: (name) => events.some((e) => e.event === name),
            toolCalls,
            rounds: modelRounds,
            roundMessages: (i) => modelRounds[i].messages,
            roundOptions: (i) => modelRounds[i].options,
            persists: script.persists,
            storedSessions: script.storedSessions,
        };
    }

    return {
        run,
        router,
        // The real dispatch, for a test that wants the real tool rules (gate,
        // staging) behind an `onTool` handler: onTool: (n, a, w) => h.realApplyToolCall(n, a, w).
        realApplyToolCall: realBuilderTools.applyToolCall,
        restore() { while (undo.length) undo.pop()(); },
    };
}

/**
 * A round spec → the adapter event list.
 * `{ thinking, text, toolCalls, events, finishReason, usage }`, where
 * `events` is spliced in before the tool calls for the exotic ones
 * (tool_args_delta, prompt_progress, tool_use_invalid).
 */
function toEvents(spec) {
    const out = [];
    let partSeq = 0;
    for (const part of spec.thinking || []) {
        const partId = part.partId || `t${partSeq++}`;
        out.push(['thinking_start', { partId, redacted: part.redacted }]);
        out.push(['thinking', { partId, text: part.text || '' }]);
        if (part.signature) out.push(['thinking_signature', { partId, signature: part.signature }]);
        out.push(['thinking_stop', { partId, redacted: part.redacted }]);
    }
    if (spec.text) out.push(['text', { text: spec.text }]);
    for (const e of spec.events || []) out.push(e);
    (spec.toolCalls || []).forEach((tc, i) => {
        out.push(['tool_use', {
            id: tc.id || `call_${i}`,
            name: tc.name,
            input: tc.args || {},
            thought_signature: tc.thoughtSignature,
            _repaired: tc.repaired,
        }]);
    });
    out.push(['done', { stop_reason: spec.finishReason || 'stop', ...(spec.usage || {}) }]);
    return out;
}

/** A request/response pair the Express router can serve, minus the socket. */
function fakeExchange({ body, query, userId, userOrgId }) {
    const written = [];
    const closeHandlers = [];
    let resolveDone;
    const done = new Promise((r) => { resolveDone = r; });

    const req = {
        method: 'POST',
        url: '/stream',
        originalUrl: '/api/automation/builder/stream',
        baseUrl: '',
        headers: {},
        body,
        query,
        session: { user: { id: userId, organizationId: userOrgId } },
        on(event, cb) { if (event === 'close') closeHandlers.push(cb); return req; },
    };

    const res = {
        written,
        writableEnded: false,
        headersSent: false,
        statusCode: 200,
        writeHead(code, headers) { this.statusCode = code; this.headers = headers; this.headersSent = true; return this; },
        flushHeaders() {},
        write(chunk) { written.push(String(chunk)); return true; },
        end(chunk) {
            if (chunk) written.push(String(chunk));
            this.writableEnded = true;
            for (const cb of closeHandlers) cb();
            resolveDone();
            return this;
        },
        setHeader() { return this; },
        getHeader() { return undefined; },
        on() { return this; },
        once() { return this; },
        emit() { return false; },
    };

    return { req, res, done };
}

/** The SSE frames the client would parse back out of the written stream. */
function parseSse(raw) {
    const out = [];
    for (const frame of raw.split('\n\n')) {
        const m = /^event: (.+)\ndata: ([\s\S]*)$/.exec(frame.trim());
        if (!m) continue;
        let data;
        try { data = JSON.parse(m[2]); } catch (_) { data = m[2]; }
        out.push({ event: m[1], data });
    }
    return out;
}

module.exports = { createBuilderStream, call, parseSse };
