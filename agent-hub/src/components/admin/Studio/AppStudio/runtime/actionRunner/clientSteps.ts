/**
 * The CLIENT step kinds of a sequence — the ones that run in the browser:
 * navigate, toast, open_url, open/close_modal, reset_form, download_file,
 * confirm, set_variable and refresh. Control flow (condition/switch/loop)
 * lives with the coordinator in ./sequence.ts.
 */
import toast from '@/components/shared/Toast';
import { closeAppModal, openAppModal } from '../components/AppModal';
import { resetAppForm } from '../formContext';
import { resolveBinding } from '../resolveBinding';
import type { ResolveResult } from '../resolveBinding.types';
import { attachmentUrl, getAuthed } from '@/api/actionHttp';
import { SEQ_ABORT, defaultConfirm, resolveNavParams, showToast } from './core';
import type { RunStep } from './core';
import type { RunnerContext } from './runnerContext';
import type { SeqState } from './serverSteps';

/** The resolveBinding bag ({ actionState, dataState, scope }) for the sequence's current state. */
export type LiveBag = (st: SeqState) => { actionState: unknown; dataState: unknown; scope: unknown };

export interface ClientStepEnv {
    ctx: RunnerContext;
    liveBag: LiveBag;
}

type ClientStepHandler = (env: ClientStepEnv, step: RunStep, st: SeqState) => void | Promise<void>;

interface FileRef {
    fileId?: string;
    name?: string;
}

// Client-side on purpose: the bytes go straight to the user's disk and never
// through the action's result, so a generated CSV needs no file_preview
// parked on the screen to be reachable. Same attachment route file_preview
// fetches, so the viewer's access is checked identically.
async function downloadFile({ ctx, liveBag }: ClientStepEnv, step: RunStep, st: SeqState): Promise<void> {
    const { value: entry } = resolveBinding(step.file, liveBag(st)) as ResolveResult<FileRef | null>;
    if (!entry || typeof entry !== 'object' || !entry.fileId) return;
    const { value: nameOverride } = step.fileName
        ? resolveBinding(step.fileName, liveBag(st))
        : { value: null };
    const name = String(nameOverride || entry.name || 'download').trim() || 'download';
    const href = attachmentUrl(ctx.appId, entry.fileId);
    // authFetch, not a bare <a href>: the route is authenticated,
    // and a plain link would navigate to a 401 instead of saving.
    const res = await getAuthed(href);
    if (!res.ok) {
        toast.error(ctx.tr('studio_apps_runtime.actions.download_failed', 'That file could not be downloaded.'));
        return;
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoked on the next tick: revoking synchronously races the
    // browser's own read of the blob in Safari.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
}

// Narrow to the source that changed when the author said which one. Passing
// nothing keeps the original "reload everything" behaviour, which is what a
// v2.0 definition (whose only field was the ignored actionId) still gets.
async function refreshStep({ ctx }: ClientStepEnv, step: RunStep): Promise<void> {
    const onRefresh = ctx.live.current.onRefresh;
    if (!onRefresh) return;
    // AWAITED on purpose. Fire-and-forget made "refresh, then read what I
    // just wrote" a race the read always lost: a loop over rows an earlier
    // step created resolved its source against the stale cache and ran zero
    // times. The only reliable workaround was to split such a flow over two
    // button presses and let the human be the barrier. invalidateQueries
    // resolves once the refetch has landed; the extra macrotask lets React
    // commit the new data so the live dataState is the fresh one by the next
    // step.
    await onRefresh(
        (step.tableId || step.datasetId)
            ? { tableId: step.tableId || null, datasetId: step.datasetId || null }
            : undefined,
    );
    await new Promise((resolve) => { setTimeout(resolve, 0); });
}

const CLIENT_STEPS: Record<string, ClientStepHandler> = {
    navigate: ({ ctx, liveBag }, step, st) => {
        const onNavigate = ctx.live.current.onNavigate;
        if (onNavigate) onNavigate(step.screenId as string, resolveNavParams(step.params, liveBag(st).scope));
    },
    toast: (_env, step) => { showToast(step.tone, step.message); },
    open_url: (_env, step) => {
        const url = String(step.url || '').trim();
        if (url.toLowerCase().startsWith('https://')) {
            window.open(url, step.newTab === false ? '_self' : '_blank', 'noopener,noreferrer');
        }
    },
    open_modal: (_env, step) => { if (step.modalId) openAppModal(step.modalId); },
    close_modal: (_env, step) => { if (step.modalId) closeAppModal(step.modalId); },
    reset_form: (_env, step) => { if (typeof step.form === 'string' && step.form) resetAppForm(step.form); },
    download_file: downloadFile,
    confirm: async ({ ctx }, step) => {
        const ask = ctx.live.current.confirm || ((st2: RunStep) => defaultConfirm(st2, ctx.tr));
        const ok = await ask(step);
        if (!ok) throw SEQ_ABORT;
    },
    set_variable: ({ ctx, liveBag }, step, st) => {
        if (typeof step.name === 'string' && step.name) {
            const { value } = resolveBinding(step.value, liveBag(st));
            st.vars = { ...st.vars, [step.name]: value };
            ctx.setVar(step.name, value); // persist beyond this sequence
        }
    },
    refresh: refreshStep,
};

/** Runs a client step kind. False when the kind is not a client kind. */
export async function runClientStep(env: ClientStepEnv, step: RunStep, st: SeqState): Promise<boolean> {
    const handler = Object.prototype.hasOwnProperty.call(CLIENT_STEPS, step.kind as string)
        ? CLIENT_STEPS[step.kind as string]
        : null;
    if (!handler) return false;
    await handler(env, step, st);
    return true;
}
