/**
 * runAction's dispatch: a v2 sequence goes to the coordinator, a bare v1
 * action keeps its exact legacy behaviour so existing call sites and
 * semantics are unchanged.
 */
import { closeAppModal, openAppModal } from '../components/AppModal';
import { buildScope } from '../RuntimeContext';
import { runAutomationAction } from './automationBridge';
import { resolveNavParams, showToast } from './core';
import type { RunOpts, RunnableAction } from './core';
import type { RunnerContext } from './runnerContext';
import { runSequence } from './sequence';
import { slotActionIds } from '@shared/appDefinition/clientTriggers.mjs';
import type { ActionSlot } from './core';

function navigate(ctx: RunnerContext, action: RunnableAction, opts: RunOpts): void {
    const live = ctx.live.current;
    if (!live.onNavigate) return;
    const scope = buildScope({
        actionState: live.actionState,
        dataState: live.dataState || {},
        form: opts.formValues || {},
        forms: live.forms || {},
        screen: live.screen || {},
        vars: live.vars || {},
        item: opts.item,
        index: opts.index,
        value: opts.value,
        currentUser: live.currentUser || null,
    });
    live.onNavigate(action.screenId as string, resolveNavParams(action.params, scope));
}

// NEVER SILENT. This used to be `return`, so an action of a kind this build
// has no case for did nothing at all: no request, no toast, no error state.
// The control looked like it had worked and the person went on believing the
// row was written. useActionRunner.actionKinds.test.jsx drives every kind in
// the server catalog through here and fails on silence.
function reportUnsupported(ctx: RunnerContext, actionId: string, action: RunnableAction): void {
    const message = ctx.tr('studio_apps_runtime.actions.unsupported_action', 'This app uses an action ("{kind}") this version cannot run. Update the app, or ask the person who built it.', { kind: String(action.kind) });
    ctx.setEntry(actionId, { status: 'error', result: undefined, error: message });
    showToast('danger', message);
}

/** The actions that finish in the browser, without a request. True when `action` was one of them. */
function runInlineAction(ctx: RunnerContext, action: RunnableAction, opts: RunOpts): boolean {
    switch (action.kind) {
        case 'navigate':
            navigate(ctx, action, opts);
            return true;
        case 'toast':
            showToast(action.tone, action.message);
            return true;
        case 'open_url': {
            const url = String(action.url || '').trim();
            if (!url.toLowerCase().startsWith('https://')) return true;
            window.open(url, action.newTab === false ? '_self' : '_blank', 'noopener,noreferrer');
            return true;
        }
        case 'open_modal':
            if (action.modalId) openAppModal(action.modalId);
            return true;
        case 'close_modal':
            if (action.modalId) closeAppModal(action.modalId);
            return true;
        default:
            return false;
    }
}

// Native AI and email actions are server steps — run them through the
// sequence coordinator (a bare action normalizes to a 1-step
// sequence, which dispatches to /step and threads the result into
// resultVar).
// create_record joined this group when it became an ACTION kind as
// well as a step kind ("add a row" is one of the four things a
// button most often does). The /step endpoint resolves a bare
// action through the same normalizeSequence the client uses, so it
// needed no path of its own — only this one line. Without it, the
// button was a silent no-op.
// call_action runs here too: the coordinator walks the called action's steps.
const SERVER_STEP_KINDS = new Set(['ai_extract', 'ai_generate', 'kb_query', 'send_email', 'create_record', 'call_action']);

/**
 * `ctx` with a setEntry that remembers the last status written for `actionId`: how the
 * runners that report through actionState (an automation, a background job) say whether
 * they ran. Started (running) or done (success) counts as having run.
 */
function observed(ctx: RunnerContext, actionId: string): { ctx: RunnerContext; ran: () => boolean } {
    let last: string | null = null;
    const setEntry: RunnerContext['setEntry'] = (id, entry) => {
        if (id === actionId) last = entry.status;
        ctx.setEntry(id, entry);
    };
    return { ctx: { ...ctx, setEntry }, ran: () => last === 'success' || last === 'running' };
}

/**
 * Run one action. Resolves true when it ran to the end (or, for a background job, started),
 * false when it failed, was declined or did not start: an event slot that lists several
 * actions stops there (runActionSlot).
 */
async function runActionById(ctx: RunnerContext, actionId: string, opts: RunOpts = {}): Promise<boolean> {
    const action = ctx.live.current.definition?.actions?.[actionId];
    if (!action) return false;

    // A background sequence runs as a server job the browser follows. Loaded on first use:
    // most apps never run one, and the public entry budget counts every static import.
    if (action.kind === 'sequence' && action.background === true) {
        const { runBackgroundAction } = await import('./backgroundRun');
        const watch = observed(ctx, actionId);
        await runBackgroundAction(watch.ctx, actionId, action, opts);
        return watch.ran();
    }
    // A sequence with runOn: 'server' (schema 3) is one server run too; the click waits for it.
    // A public page never gets here: it receives the action without its run options.
    if (action.kind === 'sequence' && action.runOn === 'server') {
        const { runServerAction } = await import('./backgroundRun');
        const watch = observed(ctx, actionId);
        await runServerAction(watch.ctx, actionId, action, opts);
        return watch.ran();
    }
    // v2 sequences use the coordinator; bare v1 actions keep their exact
    // legacy behaviour so existing call sites and semantics are unchanged.
    if (action.kind === 'sequence' || SERVER_STEP_KINDS.has(action.kind as string)) {
        return runSequence(ctx, actionId, action, opts);
    }
    if (runInlineAction(ctx, action, opts)) return true;
    if (action.kind === 'run_automation') {
        const watch = observed(ctx, actionId);
        await runAutomationAction(watch.ctx, actionId, action, opts);
        return watch.ran();
    }
    reportUnsupported(ctx, actionId, action);
    return false;
}

/**
 * An event slot: one action id, or (schema 3) a list of them run one after the other,
 * stopping at the first that does not run to the end. Resolves like runActionById.
 */
export async function runActionSlot(ctx: RunnerContext, slot: ActionSlot, opts: RunOpts = {}): Promise<boolean> {
    if (typeof slot === 'string') return runActionById(ctx, slot, opts);
    for (const actionId of slotActionIds(slot)) {
        if (!ctx.alive.current || !(await runActionById(ctx, actionId, opts))) return false;
    }
    return true;
}
