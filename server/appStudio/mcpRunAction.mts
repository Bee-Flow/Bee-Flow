/**
 * app_run_action over the Studio MCP: run one action of an app on the server to TEST it,
 * with a per-step report. Steps go through the same executor a button click uses
 * (actionExecutor.executeDataStep), as the app owner, so row access, quotas and the AI
 * budget behave as they do there.
 *
 * Because it runs as the owner (their mailbox, connectors and AI budget), the rules are tight:
 *   - WHO: only when the caller IS the owner. An editor with write access is refused: running
 *     as the owner would hand them the owner's mailbox and budget without the owner acting.
 *     The access decision (canWriteStudioApp, then owner) is taken at call time.
 *   - dryRun (the default): nothing is written, nothing is sent. Record writes, file writers,
 *     automations and approvals are reported as "would ..." and skipped; send_email is never
 *     executed; the AI steps (ai_extract, ai_generate, kb_query, dataset_query) do run, without
 *     their writeTo, and cost the owner's AI budget like a click. Client steps are skipped.
 *   - dryRun false: the steps run for real, except those that reach people or need a viewer:
 *     send_email only with mode "draft" (a draft in the mailbox, never a send), and never inside
 *     a loop; run_automation, request_approval, ai_browse and copy_document are refused.
 *   - ONE choke point: every step reaches the executor through runGuarded(), which re-checks
 *     the send_email rule on the step it is about to run. Branches, switch cases and loops all
 *     recurse into the same walker, so nesting cannot bypass it.
 *   - caps: a per-user rate limit, a step count, a loop-iteration cap, a time budget, a
 *     trimmed report (no big payloads, secret-looking keys redacted).
 */

import { createRequire } from 'node:module';
import {
    CONTROL_KINDS, MAX_ERROR_CHARS, MAX_LOOP_ITERATIONS, MAX_REPORT_STEPS, MAX_SCOPE_BYTES,
    decideStep, isObject, resetRunWindows, runLimits, short, takeRunBudget, trimResult, trimValue,
} from './mcpRunActionPolicy.mts';
import type { Obj, RunLimits, Step } from './mcpRunActionPolicy.mts';

export { resetRunWindows, takeRunBudget, trimValue };

const nodeRequire = createRequire(import.meta.url);

type App = { id: string; userId: string; name?: string | null; organizationId?: string | null; definition?: unknown; definitionVersion?: number | null };
type StepResult = { ok: boolean; result?: unknown; error?: string };

export type StepStatus = 'ok' | 'skipped' | 'refused' | 'error';
export type StepReport = { path: string; kind: string; status: StepStatus; result?: unknown; error?: string };
export type RunReport = {
    ok: boolean; dryRun: boolean; actionId: string; definitionVersion?: number; steps: StepReport[]; vars?: unknown;
    stopped?: string; truncated?: boolean; notes: string[];
};
export type RunOutcome = RunReport | { error: string; _fixHint?: string };

export type RunDeps = {
    getApp: (appId: string) => Promise<App | null>;
    canWrite: (app: App, userId: string) => boolean;
    getDataModel: (appId: string, ownerId: string) => Promise<unknown>;
    executeStep: (app: App, model: unknown, step: Step, ctx: Obj) => Promise<StepResult>;
    evaluate: (expr: string, scope: unknown) => unknown;
    buildScope: (ctx: Obj) => unknown;
    resolveBinding: (binding: unknown, ctx: Obj, scope: unknown) => unknown;
    takeBudget: (userId: string, now: number) => boolean;
    audit: (entry: Obj, app: App, userId: string) => Promise<void>;
    log: { warn: (...a: unknown[]) => void };
    now: () => number;
    limits: () => RunLimits;
};


// ── The walk ────────────────────────────────────────────────────────────────

type Run = {
    app: App; model: unknown; def: Obj; actionId: string; userId: string; dryRun: boolean;
    vars: Obj; form: Obj; item: unknown; index: unknown;
    reports: StepReport[]; executed: number; deadline: number; maxExecuted: number;
    stopped: string | null; truncated: boolean; failed: boolean; notes: Set<string>;
    deps: RunDeps;
};

function ctxFor(run: Run): Obj {
    const { app, def } = run;
    return {
        viewerId: app.userId, actionId: run.actionId, viewerName: null, viewerEmail: null,
        role: 'owner', orgId: app.organizationId || null,
        formValues: run.form, vars: run.vars,
        variables: Array.isArray(def.variables) ? def.variables : null,
        item: run.item, index: run.index,
        viewer: { id: app.userId, role: 'owner', organizationId: app.organizationId || null },
    };
}

function report(run: Run, entry: StepReport): void {
    if (run.reports.length >= MAX_REPORT_STEPS) { run.truncated = true; return; }
    run.reports.push(entry);
}

const same = (a: unknown, b: unknown): boolean => a === b || (a != null && b != null && String(a) === String(b));

/** The only place a step reaches the executor. Re-checks the send_email rule on what it is about to run. */
async function runGuarded(run: Run, step: Step, inLoop: boolean): Promise<StepResult> {
    if (step.kind === 'send_email' && (run.dryRun || inLoop || step.mode !== 'draft')) {
        return { ok: false, error: 'send_email is not allowed here' };
    }
    return run.deps.executeStep(run.app, run.model, step, ctxFor(run));
}

function wouldSendOf(run: Run, step: Step): Obj {
    const ctx = ctxFor(run);
    const scope = run.deps.buildScope(ctx);
    const read = (b: unknown): unknown => {
        if (b === undefined || b === null) return null;
        try { return run.deps.resolveBinding(b, ctx, scope); } catch { return null; }
    };
    const to = read(step.to);
    return {
        to: Array.isArray(to) ? to.slice(0, 10).map((v) => short(v, 120)) : short(to, 200),
        subject: short(read(step.subject), 200),
        mode: step.mode === 'draft' ? 'draft' : 'send',
    };
}

async function execLeaf(run: Run, step: Step, path: string, inLoop: boolean): Promise<void> {
    const kind = String(step.kind);
    if (kind === 'set_variable') {
        const name = typeof step.name === 'string' ? step.name : '';
        if (!name) { report(run, { path, kind, status: 'error', error: 'set_variable has no name' }); run.failed = true; return; }
        const ctx = ctxFor(run);
        const value = run.deps.resolveBinding(step.value, ctx, run.deps.buildScope(ctx));
        run.vars = { ...run.vars, [name]: value };
        report(run, { path, kind, status: 'ok', result: trimResult({ [name]: value }) });
        return;
    }
    const decision = decideStep(step, run.dryRun, inLoop, kind === 'send_email' ? wouldSendOf(run, step) : undefined);
    if (!decision.run) {
        report(run, { path, kind, status: decision.status, error: decision.reason, ...(decision.result !== undefined ? { result: trimResult(decision.result) } : {}) });
        return;
    }
    run.executed += 1;
    let res: StepResult;
    try {
        res = await runGuarded(run, decision.step, inLoop);
    } catch (e) {
        res = { ok: false, error: (e as Error)?.message || 'Step failed' };
    }
    if (!res || res.ok !== true) {
        run.failed = true;
        run.stopped = `${path} failed`;
        report(run, { path, kind, status: 'error', error: String(res?.error || 'Step failed').slice(0, MAX_ERROR_CHARS) });
        return;
    }
    if (typeof step.resultVar === 'string' && step.resultVar) run.vars = { ...run.vars, [step.resultVar]: res.result ?? null };
    report(run, { path, kind, status: 'ok', result: trimResult(res.result ?? null), ...(decision.note ? { error: decision.note } : {}) });
}

function overBudget(run: Run): string | null {
    if (run.deadline && run.deps.now() > run.deadline) return 'time budget used up';
    if (run.maxExecuted && run.executed >= run.maxExecuted) return `step limit of ${run.maxExecuted} executed steps reached`;
    return null;
}

async function walkSteps(run: Run, list: unknown, base: string, inLoop: boolean): Promise<void> {
    const steps = Array.isArray(list) ? list : [];
    for (let i = 0; i < steps.length; i += 1) {
        if (run.stopped) return;
        const stop = overBudget(run);
        if (stop) { run.stopped = stop; run.truncated = true; return; }
        const step = steps[i] as Step | null;
        const path = `${base}[${i}]`;
        if (!isObject(step) || typeof step.kind !== 'string') {
            report(run, { path, kind: '(invalid)', status: 'error', error: 'Not a step object' });
            run.failed = true; run.stopped = `${path} is not a step`;
            return;
        }
        await walkStep(run, step as Step, path, inLoop);
    }
}

async function walkStep(run: Run, step: Step, path: string, inLoop: boolean): Promise<void> {
    const kind = String(step.kind);
    if (!CONTROL_KINDS.includes(kind)) return execLeaf(run, step, path, inLoop);
    const ctx = ctxFor(run);
    const scope = run.deps.buildScope(ctx);
    if (kind === 'condition') {
        const value = run.deps.evaluate(String(step.expr ?? ''), scope);
        report(run, { path, kind, status: 'ok', result: { branch: value ? 'then' : 'else' } });
        return walkSteps(run, value ? step.then : step.else, `${path}.${value ? 'then' : 'else'}`, inLoop);
    }
    if (kind === 'switch') {
        const value = run.deps.evaluate(String(step.expr ?? ''), scope);
        const cases = Array.isArray(step.cases) ? step.cases as Array<{ value?: unknown; steps?: unknown }> : [];
        const at = cases.findIndex((c) => c && same(c.value, value));
        report(run, { path, kind, status: 'ok', result: { case: at >= 0 ? at : 'default' } });
        return walkSteps(run, at >= 0 ? cases[at].steps : step.default, at >= 0 ? `${path}.cases[${at}].steps` : `${path}.default`, inLoop);
    }
    return walkLoop(run, step, path, scope, ctx);
}

async function walkLoop(run: Run, step: Step, path: string, scope: unknown, ctx: Obj): Promise<void> {
    const source = run.deps.resolveBinding(step.source, ctx, scope);
    if (!Array.isArray(source)) {
        run.notes.add(`${path}: the loop source did not resolve to a list on the server (table and record bindings are not available here); pass the rows in scope.vars and bind the loop to them.`);
        report(run, { path, kind: 'loop', status: 'skipped', error: 'source did not resolve to a list', result: { iterations: 0 } });
        return;
    }
    const own = typeof step.maxIterations === 'number' && step.maxIterations > 0 ? step.maxIterations : MAX_LOOP_ITERATIONS;
    const cap = Math.min(own, MAX_LOOP_ITERATIONS);
    const count = Math.min(source.length, cap);
    if (source.length > count) run.notes.add(`${path}: looped ${count} of ${source.length} rows (cap ${cap}).`);
    report(run, { path, kind: 'loop', status: 'ok', result: { iterations: count } });
    const outer = { vars: run.vars, item: run.item, index: run.index };
    for (let n = 0; n < count && !run.stopped; n += 1) {
        run.item = source[n];
        run.index = n;
        const bound: Obj = {};
        if (typeof step.itemVar === 'string' && step.itemVar) bound[step.itemVar] = source[n];
        if (typeof step.indexVar === 'string' && step.indexVar) bound[step.indexVar] = n;
        run.vars = { ...run.vars, ...bound };
        await walkSteps(run, step.steps, `${path}.steps`, true);
    }
    // itemVar/indexVar are iteration-scoped, as in the browser; other writes carry on.
    const carried: Obj = { ...run.vars };
    for (const name of [step.itemVar, step.indexVar]) {
        if (typeof name !== 'string' || !name) continue;
        if (Object.hasOwn(outer.vars, name)) carried[name] = outer.vars[name]; else delete carried[name];
    }
    run.vars = carried;
    run.item = outer.item;
    run.index = outer.index;
}

// ── Entry ───────────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

function readScope(raw: unknown): { vars: Obj; form: Obj; item: unknown } | { error: string } {
    if (raw === undefined || raw === null) return { vars: {}, form: {}, item: undefined };
    if (!isObject(raw)) return { error: 'scope must be an object { vars?, form?, item? }.' };
    const bag = (v: unknown, name: string): Obj | string => {
        if (v === undefined || v === null) return {};
        if (!isObject(v)) return `scope.${name} must be an object.`;
        return v;
    };
    const vars = bag(raw.vars, 'vars');
    const form = bag(raw.form, 'form');
    if (typeof vars === 'string') return { error: vars };
    if (typeof form === 'string') return { error: form };
    if (JSON.stringify(raw).length > MAX_SCOPE_BYTES) return { error: `scope is larger than ${MAX_SCOPE_BYTES / 1024} KB.` };
    return { vars: { ...vars }, form: { ...form }, item: raw.item };
}

/** The access decision, taken now: write access (resolution failure = deny), then ownership. */
async function authorize(deps: RunDeps, appId: string, userId: string): Promise<{ app: App } | { error: string; _fixHint?: string }> {
    let app: App | null = null;
    try { app = await deps.getApp(appId); } catch { app = null; }
    if (!app || !deps.canWrite(app, userId)) {
        return { error: `App "${appId}" not found, or this token's user cannot edit it. Call studio_list_apps for the ids you own.` };
    }
    if (app.userId !== userId) {
        return {
            error: 'app_run_action runs as the app owner and is only available to the owner. You can edit this app, but running an action would use the owner\'s mailbox, connectors and AI budget without the owner acting.',
            _fixHint: 'Ask the owner to run it (their token), or test the pieces with app_dry_run.',
        };
    }
    return { app };
}

export async function runAction(args: unknown, userId: string, deps: RunDeps = defaultDeps()): Promise<RunOutcome> {
    const a = isObject(args) ? args : {};
    const appId = typeof a.appId === 'string' ? a.appId.trim() : '';
    const actionId = typeof a.actionId === 'string' ? a.actionId : '';
    if (!appId) return { error: 'app_run_action needs an appId.' };
    if (!ID_RE.test(actionId)) return { error: 'app_run_action needs the actionId of an action of the app.' };
    const dryRun = a.dryRun !== false;
    const scope = readScope(a.scope);
    if ('error' in scope) return { error: scope.error };

    const auth = await authorize(deps, appId, userId);
    if ('error' in auth) return auth;
    const { app } = auth;

    const limits = deps.limits();
    if (!deps.takeBudget(userId, deps.now())) {
        return { error: `Too many app_run_action calls (limit ${limits.perMinute} per minute per user). Wait a minute and run fewer.` };
    }

    const def = (isObject(app.definition) ? app.definition : {}) as Obj;
    const actions = isObject(def.actions) ? def.actions : {};
    const action = Object.hasOwn(actions, actionId) ? actions[actionId] : null;
    if (!isObject(action)) {
        return { error: `The app has no action "${actionId}".`, _fixHint: `Actions: ${Object.keys(actions).slice(0, 50).join(', ') || '(none)'}.` };
    }

    let model: unknown = null;
    try { model = (await deps.getDataModel(app.id, app.userId) as { model?: unknown } | null)?.model ?? null; } catch { model = null; }

    const run: Run = {
        app, model, def, actionId, userId, dryRun,
        vars: scope.vars, form: scope.form, item: scope.item, index: undefined,
        reports: [], executed: 0, deadline: limits.budgetMs ? deps.now() + limits.budgetMs : 0, maxExecuted: limits.maxExecuted,
        stopped: null, truncated: false, failed: false, notes: new Set(), deps,
    };
    const top = action.kind === 'sequence' ? action.steps : [action];
    await walkSteps(run, top, action.kind === 'sequence' ? 'steps' : 'action', false);

    await deps.audit({ actionId, dryRun, executed: run.executed, steps: run.reports.length, failed: run.failed }, app, userId);
    const out: RunReport = {
        ok: !run.failed && !(run.stopped && run.truncated),
        dryRun, actionId, steps: run.reports,
        // The saved version the run read, read fresh from the store: compare it with app_set_action's `version`.
        ...(typeof app.definitionVersion === 'number' ? { definitionVersion: app.definitionVersion } : {}),
        vars: trimValue(run.vars),
        notes: [...run.notes, ...(dryRun ? ['dryRun: nothing was written or sent. AI steps ran and cost the owner\'s AI budget like a click.'] : [])],
    };
    if (run.stopped) out.stopped = run.stopped;
    if (run.truncated) out.truncated = true;
    return out;
}

function defaultDeps(): RunDeps {
    return {
        getApp: (appId) => nodeRequire('../stores/studioAppStore').getStudioApp(appId),
        canWrite: (app, userId) => nodeRequire('../stores/studioAppStore').canWriteStudioApp(app, userId),
        getDataModel: (appId, ownerId) => nodeRequire('../stores/studioAppDataStore').getDataModel(appId, ownerId),
        executeStep: (app, model, step, ctx) => nodeRequire('./actionExecutor').executeDataStep(app, model, step, ctx),
        evaluate: (expr, scope) => nodeRequire('../shared/expr/index.mjs').tryEvaluate(expr, scope)?.value,
        buildScope: (ctx) => nodeRequire('./actionExecutor/shared').buildServerScope(ctx),
        resolveBinding: (binding, ctx, scope) => nodeRequire('./actionExecutor/shared').resolveBinding(binding, ctx, scope),
        takeBudget: (userId, now) => takeRunBudget(userId, now, runLimits().perMinute),
        audit: async (entry, app, userId) => {
            try {
                await nodeRequire('../stores/userStore').logAccessAudit(
                    `studio_app_mcp_run_action_${entry.dryRun ? 'dry' : 'live'}`, 'studio_app', app.id, userId, null,
                    { appName: app.name || null, ...entry }, app.organizationId || null,
                );
            } catch (e) {
                nodeRequire('../telemetry/log').warn(`[studio-mcp] could not record a run: ${(e as Error)?.message}`);
            }
        },
        log: nodeRequire('../telemetry/log'),
        now: () => Date.now(),
        limits: () => runLimits(),
    };
}
