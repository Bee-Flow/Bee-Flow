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
const SERVER_STEP_KINDS = new Set(['ai_extract', 'ai_generate', 'kb_query', 'send_email', 'create_record']);

export async function runActionById(ctx: RunnerContext, actionId: string, opts: RunOpts = {}): Promise<void> {
    const action = ctx.live.current.definition?.actions?.[actionId];
    if (!action) return;

    // v2 sequences use the coordinator; bare v1 actions keep their exact
    // legacy behaviour so existing call sites and semantics are unchanged.
    if (action.kind === 'sequence' || SERVER_STEP_KINDS.has(action.kind as string)) {
        return runSequence(ctx, actionId, action, opts);
    }
    if (runInlineAction(ctx, action, opts)) return;
    if (action.kind === 'run_automation') return runAutomationAction(ctx, actionId, action, opts);
    reportUnsupported(ctx, actionId, action);
}
