// @typecheck
'use strict';
/**
 * Start a real run of an automation over MCP: `automations_run`.
 *
 * ── ONE EXECUTION PATH ──────────────────────────────────────────────────────
 * The run is started by `core/automationRunner.executeAutomation`, the function
 * behind the product's "Run now" (routes/automation/runs.js, POST /:id/run), with
 * the same options: a live, manual, non-test run of the copy the product runs
 * (`automationForRun`), `startedByUserId` the caller. Who may start it is the
 * product's own question too: `makeAutomationAccess().roleFor(...)` must give
 * `run` or better (the owner, an org admin, or a share with the run role).
 * The runs it starts are therefore the same rows, in the same history, that
 * automations_list_runs and automations_get_run_steps read.
 *
 * ── ACTIVATION STAYS A HUMAN DECISION ───────────────────────────────────────
 * The product's button also works on an automation nobody has switched on. Over
 * MCP that is a different thing: an agent that can start whatever it can reach
 * would send real mail and write to real systems from a draft nobody approved.
 * So this tool starts only an automation a person has already ACTIVATED, and
 * it never activates, publishes or edits anything. An inactive automation is
 * refused with a sentence that says so.
 *
 * ── GATES, in order ─────────────────────────────────────────────────────────
 *   1. the token's scope: `automations.run` (auth/mcpAccess/scopes.js), which
 *      no token has unless it was minted with it;
 *   2. arguments: the input is an object under a size cap;
 *   3. the automation exists, is an automation (not a reusable Step), belongs to
 *      an organisation the caller is in, and the caller holds `run` on it
 *      (anything else answers 404: whether it exists is not told); a `view`
 *      share sees it but may not start it (403 automation_run_forbidden);
 *   4. it is active, and the definition the run would execute validates (an
 *      automation without a published copy runs its working copy, which the
 *      builder tools save even when it is not yet valid: such a copy is
 *      refused with its validationErrors, never run with holes in it);
 *   5. the "runs with your own connections" notice, when it applies to a
 *      caller who is not the owner, has been acknowledged in the product;
 *   6. the rate limits (per user and per automation);
 *   7. the audit row, written BEFORE the run starts.
 *
 * ── CAPS (environment variables; 0 = unlimited) ─────────────────────────────
 *   AUTOMATION_MCP_RUN_INPUT_MAX_BYTES        JSON size of `input`                 (65536)
 *   AUTOMATION_MCP_RUN_PER_MINUTE_USER        starts per user per minute           (20)
 *   AUTOMATION_MCP_RUN_PER_MINUTE_AUTOMATION  starts per automation per minute     (10)
 *   AUTOMATION_MCP_RUN_WAIT_MAX_SECONDS       longest `wait` the tool will hold    (55)
 *
 * `input` is the trigger payload and may carry personal data: it is never
 * logged or audited (size and key count only).
 *
 * Collaborators are injected (makeRunNow) so the tests hand in their own; the
 * module requires nothing from the database layer at load time.
 */

const { HttpError } = require('../core/http/errors');
const log = require('../telemetry/log');
const { fallback } = require('../utils/bestEffort');
const { envCap } = require('./mcpRunReadCaps');

const RUN_NOW_AUDIT_ACTION = 'mcp.automation.run';
const MAX_ID_CHARS = 200;
const DEFAULT_INPUT_MAX = 64 * 1024;
const DEFAULT_PER_MINUTE_USER = 20;
const DEFAULT_PER_MINUTE_AUTOMATION = 10;
const DEFAULT_WAIT_MAX_SECONDS = 55;
// How many validation errors a refusal lists.
const MAX_VALIDATION_ERRORS = 20;

/** @type {any[]} */
const RUN_NOW_TOOLS = [
    {
        name: 'automations_run',
        description: 'Start a real run of an automation that a person has ALREADY ACTIVATED, as if they pressed "Run now". It really sends mail and writes to real systems. Needs the run permission on this token. It never activates or edits anything: an automation that is not active is refused (a human activates it in the product). Returns the runId; follow it with automations_get_run_steps. Optional `input` is the trigger payload (a JSON object); `wait: true` holds for the final status for up to waitSeconds.',
        parameters: {
            type: 'object',
            properties: {
                input: { type: 'object', description: 'The trigger payload, a JSON object. Size-capped (the error text names the cap).' },
                wait: { type: 'boolean', description: 'Wait for the run to finish and return its final status. Default false: return the runId at once.' },
                waitSeconds: { type: 'integer', description: 'With wait: how long to hold, in seconds (default and maximum: the instance cap, 55 unless the operator changed it). A run that is still going comes back as status "running" with waitTimedOut: true; it keeps running.' },
            },
        },
    },
];

const RUN_NOW_TOOL_NAMES = new Set(RUN_NOW_TOOLS.map((t) => t.name));

const caps = () => ({
    input: envCap('AUTOMATION_MCP_RUN_INPUT_MAX_BYTES', DEFAULT_INPUT_MAX),
    perUser: envCap('AUTOMATION_MCP_RUN_PER_MINUTE_USER', DEFAULT_PER_MINUTE_USER),
    perAutomation: envCap('AUTOMATION_MCP_RUN_PER_MINUTE_AUTOMATION', DEFAULT_PER_MINUTE_AUTOMATION),
    waitMax: envCap('AUTOMATION_MCP_RUN_WAIT_MAX_SECONDS', DEFAULT_WAIT_MAX_SECONDS),
});

/** A short section for the guide automations_get_guide returns. */
function guideSection() {
    return [
        '## Starting a run (needs the run permission)',
        '',
        '- automations_run { automationId, input?, wait?, waitSeconds? }: starts a REAL run, as the product\'s "Run now" does, and returns the runId (read it with automations_get_run_steps). `input` is the trigger payload.',
        'Activation is still a human decision: automations_run starts only an automation a person has already activated in the product. It never activates, publishes or edits anything, and an automation that is a draft or switched off is refused. Build and verify with the builder tools and the dry run, then ask the person to activate; only then can it be run from here.',
        'The token needs the "run" permission (automations.run), which is off unless the person who made the token ticked it. A run is audited with the token that started it.',
    ].join('\n');
}

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * @param {{
 *   store?: any,
 *   access?: { roleFor: Function },
 *   roleSatisfies?: (role: any, need: string) => boolean,
 *   getUser?: (id: string) => Promise<any>,
 *   resolveOrgs?: (user: any) => Promise<{ all: string[] }>,
 *   runner?: { executeAutomation: Function },
 *   automationForRun?: Function,
 *   entry?: { entryDefinitionOf: Function, resolveTriggerStepId: Function },
 *   describeNoticeFor?: Function,
 *   charge?: (name: string, key: string, cost: number, max: number) => Promise<{ ok: boolean, retryAfter?: number }>,
 *   audit?: (action: string, targetType: string, targetId: string, actorId: string|null, before: any, after: any, orgId: string|null) => Promise<any>,
 *   validate?: (definition: any) => { ok: boolean, errors?: any[] },
 * }} [overrides]
 */
function makeRunNow(overrides = {}) {
    const store = () => overrides.store || require('../stores/automationStore');
    const access = () => overrides.access || require('./access').makeAutomationAccess({ store: store() });
    const roleSatisfies = overrides.roleSatisfies || ((role, need) => require('./access').roleSatisfies(role, need));
    const mayStartRun = (found) => require('./access').mayStartRun(found);
    const runStartForbidden = () => require('./access').runStartForbidden();
    const getUser = overrides.getUser || ((id) => require('../stores/userStore').getUser(id));
    const resolveOrgs = overrides.resolveOrgs || ((user) => require('../auth/mcpAccess/orgResolve').resolveMcpOrgs(user));
    const runner = () => overrides.runner || require('../core/automationRunner');
    const automationForRun = overrides.automationForRun || ((a, o) => require('../core/automationRunner/definitionForRun').automationForRun(a, o));
    const entry = () => overrides.entry || require('../core/automationRunner/entryPoint');
    const describeNoticeFor = overrides.describeNoticeFor || ((o) => require('../core/automationRunner/callerNotice').describeNoticeFor(o));
    const charge = overrides.charge || ((name, key, cost, max) => require('../auth/mcpAccess/gate').checkLimiter({ name, max }, key, cost));
    const audit = overrides.audit || ((...a) => require('../stores/userStore').logAccessAudit(...a));
    // The pure pass at the activate stage (every rule blocks), as finalize and go-live use it.
    const validate = overrides.validate || ((def) => require('./validate').validateDefinition(def, {
        deliverableEvents: require('./deliverableEvents').getDeliverableEvents(),
    }));

    const notFound = () => new HttpError(404, 'not_found', 'Automation not found, or this account may not run it. Call automations_list for the automations you own.');

    /**
     * The automation if this caller may start it, else 404.
     * @param {string} automationId
     * @param {string} userId
     */
    async function loadRunnable(automationId, userId) {
        const stored = await store().getAutomation(automationId).catch((e) => fallback('automation/mcpRunNow:load automation', e, null));
        if (!stored) throw notFound();
        if ((stored.kind || 'automation') !== 'automation') throw notFound();
        const user = await getUser(userId).catch((e) => fallback('automation/mcpRunNow:load user', e, null));
        if (!user) throw notFound();
        // The automation's organisation must be one of the caller's (home or through a
        // group). A resolution that fails is a refusal, never "no org, no check".
        if (stored.organizationId) {
            /** @type {{ all: string[]; }} */
            let orgs;
            try { orgs = await resolveOrgs(user); } catch { throw notFound(); }
            if (!orgs.all.includes(stored.organizationId)) throw notFound();
        }
        const found = await access().roleFor(stored, userId);
        const { role } = found;
        if (!roleSatisfies(role, 'run')) throw notFound();
        // A viewer knows it exists, so this one is a plain refusal, not a 404.
        if (!mayStartRun(found)) throw runStartForbidden();
        return { stored, role, orgId: stored.organizationId || user.organizationId || null };
    }

    /** @returns {Promise<any>} */
    async function run(userId, args, ctx) {
        const id = text(args.automationId);
        if (!id || id.length > MAX_ID_CHARS) throw new HttpError(400, 'invalid_automation_id', 'automationId is required (an id from automations_list).');
        const c = caps();

        let input = null;
        if (args.input !== undefined && args.input !== null) {
            if (!isPlainObject(args.input)) throw new HttpError(400, 'invalid_input', 'input must be a JSON object.');
            /** @type {number} */
            let bytes;
            try { bytes = Buffer.byteLength(JSON.stringify(args.input), 'utf8'); } catch { bytes = Infinity; }
            if (c.input > 0 && bytes > c.input) throw new HttpError(413, 'input_too_large', `input is larger than ${c.input} bytes; send less.`);
            input = args.input;
        }
        if (args.wait !== undefined && typeof args.wait !== 'boolean') throw new HttpError(400, 'invalid_wait', 'wait is true or false.');
        let waitMs = 0;
        if (args.wait === true) {
            const wanted = args.waitSeconds === undefined ? c.waitMax : Number(args.waitSeconds);
            if (!Number.isFinite(wanted) || wanted < 1) throw new HttpError(400, 'invalid_wait', 'waitSeconds is a whole number of seconds, 1 or more.');
            waitMs = Math.floor(c.waitMax > 0 ? Math.min(wanted, c.waitMax) : wanted) * 1000;
        }

        const { stored, role, orgId } = await loadRunnable(id, userId);

        // Activation is a human decision (see the header): refused, not repaired.
        if (stored.isActive !== true) {
            throw new HttpError(409, 'automation_not_active', 'This automation is not active. Activating is a human decision made in the product; ask the owner to activate it, then run it again. This tool never activates or edits an automation.');
        }

        let a;
        try {
            a = automationForRun(stored, { mode: 'live', triggerKind: 'manual', isTest: false });
        } catch (e) {
            if (e instanceof HttpError) throw e;
            throw new HttpError(409, 'not_runnable', 'This automation cannot be run in its current state.');
        }
        if (!a) throw notFound();

        // The copy this run executes must validate. An automation without a
        // published copy runs its working copy, and the builder saves that copy even
        // when it carries validationErrors; running it would send whatever its
        // broken bindings resolve to. Refused with the errors, so the caller can fix them.
        const checked = validate(a.definition || {});
        if (!checked.ok) {
            const errors = (checked.errors || []).slice(0, MAX_VALIDATION_ERRORS)
                .map((e) => ({ code: e.code, path: e.path, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }));
            throw new HttpError(409, 'automation_invalid',
                'This automation does not validate, so it is not run. Fix the validationErrors with the builder tools (builder_request_dry_run, builder_finalize) and try again.',
                { validationErrors: errors });
        }

        const notice = await describeNoticeFor({ automation: stored, userId, store: store(), canEdit: roleSatisfies(role, 'edit') });
        if (notice.applies && !notice.seen) {
            throw new HttpError(409, 'caller_notice_required', 'This automation runs with your own connections. Open it once in the product and confirm the notice, then try again.');
        }

        const entered = entry().resolveTriggerStepId(await entry().entryDefinitionOf(a), undefined);
        if (entered.error) throw new HttpError(400, 'invalid_trigger', 'This automation has no trigger to start from.');
        const trig = entered.trigger;
        const needsSample = trig?.kind === 'app_event'
            && ((trig.appEvent?.provider === 'gmail' && trig.appEvent?.event === 'mail.new') || trig.appEvent?.provider === 'nextcloud');
        if (needsSample && !input) {
            throw new HttpError(400, 'input_required', 'This automation starts from an app event, so a run needs the event as `input` (the product synthesises a sample for its button; there is none here).');
        }

        // Rate limits, per user and per automation, charged only once the call is authorised.
        if (c.perUser > 0) {
            const r = await charge('mcp-run-user', `user:${userId}`, 1, c.perUser);
            if (!r.ok) throw new HttpError(429, 'rate_limited', `Too many runs started by this account; try again in ${r.retryAfter || 60} seconds.`);
        }
        if (c.perAutomation > 0) {
            const r = await charge('mcp-run-automation', `automation:${stored.id}`, 1, c.perAutomation);
            if (!r.ok) throw new HttpError(429, 'rate_limited', `This automation was started too often; try again in ${r.retryAfter || 60} seconds.`);
        }

        // Who started which run through MCP: written before the run starts, so a run
        // that was started always has its row. Ids, flags and sizes; never the input.
        await audit(RUN_NOW_AUDIT_ACTION, 'automation', stored.id, userId, null, {
            via: 'mcp',
            tokenId: ctx.tokenId || null,
            version: a.version ?? null,
            wait: waitMs > 0,
            inputKeys: input ? Object.keys(input).length : 0,
        }, orgId);

        /** @type {(run: any) => void} */
        let onCreated = () => {};
        const created = new Promise((resolve) => { onCreated = resolve; });
        const finished = Promise.resolve(runner().executeAutomation(a, {
            triggerKind: 'manual',
            triggerPayload: input,
            mode: 'live',
            rootStepId: entered.rootStepId,
            isTest: false,
            startedByUserId: userId,
            onRunCreated: onCreated,
        })).then((r) => ({ run: r }), (err) => ({ err }));

        const first = await Promise.race([created.then((r) => ({ run: r, created: true })), finished]);
        if ('err' in first && first.err) {
            if (first.err instanceof HttpError) throw first.err;
            log.error(`[automations-mcp] automations_run failed to start automation=${stored.id}: ${first.err.message}`);
            throw new HttpError(500, 'start_failed', 'The run could not be started.');
        }
        const runId = /** @type {{ run?: { id?: string } }} */ (first).run?.id;
        if (!runId) throw new HttpError(500, 'start_failed', 'The run could not be started.');
        log.info(`[automations-mcp] automations_run user=${userId} automation=${stored.id} run=${runId} token=${ctx.tokenId || 'legacy'}`);

        // Past this point the run is the product's: it finishes on its own.
        finished.then((r) => {
            if ('err' in r && r.err) log.warn(`[automations-mcp] run ${runId} ended with an error: ${r.err.message}`);
        });

        const base = { runId, automationId: stored.id };
        if (waitMs <= 0) return { ...base, status: 'started', hint: 'Follow it with automations_get_run_steps { runId }.' };

        /** @type {ReturnType<typeof setTimeout>|undefined} */
        let timer;
        const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), waitMs); });
        const end = await Promise.race([finished, timeout]);
        clearTimeout(timer);
        if ('timedOut' in end) return { ...base, status: 'running', waitTimedOut: true, hint: 'Still running; read it with automations_get_run_steps { runId }.' };
        if ('err' in end && end.err) return { ...base, status: 'error', errorClass: end.err.errorClass || 'run_failed' };
        return {
            ...base,
            status: end.run?.status || 'unknown',
            ...(end.run?.errorClass ? { errorClass: end.run.errorClass } : {}),
            hint: 'Read what it did with automations_get_run_steps { runId }.',
        };
    }

    /**
     * Run the tool. Never throws: a refusal comes back as `{ error, code }`.
     * @param {string} name @param {Record<string, unknown>} args @param {{ userId: string, tokenId?: string|null }} ctx
     */
    async function call(name, args, ctx) {
        if (!RUN_NOW_TOOL_NAMES.has(name)) return { error: `Unknown tool: ${name}` };
        try {
            return await run(ctx.userId, args && typeof args === 'object' ? args : {}, ctx);
        } catch (e) {
            if (e instanceof HttpError) return { ...(e.details && typeof e.details === 'object' ? e.details : {}), error: /** @type {Error} */ (e).message, code: e.code };
            log.error(`[automations-mcp] ${name} failed: ${e instanceof Error ? /** @type {Error} */ (e).message : e}`);
            return { error: `${name} failed.`, code: 'internal_error' };
        }
    }

    return { call };
}

let shared = null;
/** The production instance, built on first use. */
const call = (name, args, ctx) => (shared || (shared = makeRunNow())).call(name, args, ctx);

module.exports = { RUN_NOW_TOOLS, RUN_NOW_TOOL_NAMES, RUN_NOW_AUDIT_ACTION, makeRunNow, call, guideSection, caps };
