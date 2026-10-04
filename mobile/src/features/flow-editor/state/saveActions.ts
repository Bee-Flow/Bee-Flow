/**
 * The draft store's save pipeline: one attempt at a time (scheduler.ts decides
 * when), always sending the NEWEST definition, and booking the answer.
 *
 * On success the sent definition becomes the baseline — never the server's
 * echo: the definition on screen may have moved on while the request was
 * out, and adopting the echo would undo those edits (the web's rule, see
 * BuilderShell's adoptPersistedDefinition). The save's warnings replace the
 * previous save's; a 400's `details` do the same as errors.
 *
 * An automation that does not exist yet is CREATED by its first save (the web's
 * ensureAutomationCreated): one create at a time, shared by every caller that
 * needs the row, so a flurry of edits cannot leave two drafts behind. A create
 * that failed without the server's answer is not retried by the scheduler, and
 * later edits do not send it either: it may have landed, and a second POST is
 * a second automation. `retry()` and `ensureCreated()` (both a person's action)
 * send it again.
 */

import { translate } from '@/core/i18n';

import { scheduleSave, type DraftContext, type GetDraft, type SetDraft } from './context';
import { issuesByStepFor, mergeIssues } from './issues';
import { classifySaveError } from './saveErrors';
import { SaveScheduler, type SaveOutcome } from './scheduler';
import type { DraftActions, IssueSources } from './types';
import type { SaveResult } from '../api/types';
import { sameDraft } from '../model/history';
import type { FlowDefinition } from '../model/types';

export const SAVE_DELAY_MS = 900;
export const RETRY_DELAYS_MS: readonly number[] = [1000, 3000, 8000];

type SaveActions = Pick<DraftActions, 'flush' | 'retry' | 'ensureCreated' | 'dispose'>;

function notReady(): Error {
    return new Error(translate('mobile.flow.not_loaded', 'This automation has not finished loading.'));
}

function bookkeeping(set: SetDraft, get: GetDraft, ctx: DraftContext) {
    const withSaveIssues = (issueSources: IssueSources) => {
        const issues = mergeIssues(issueSources);
        return { issueSources, issues, issuesByStep: issuesByStepFor(issues, get().definition) };
    };

    const succeeded = (sent: FlowDefinition, epoch: number, result: SaveResult) => {
        if (ctx.lastApplied === result) return;
        ctx.lastApplied = result;
        const s = get();
        const baseline = epoch === ctx.epoch ? sent : s.baseline;
        const dirty = !sameDraft(s.definition, baseline);
        set({
            automationId: s.automationId ?? result.automation?.id ?? null,
            baseline,
            dirty,
            version: result.automation?.version ?? s.version,
            lastSavedAt: ctx.now(),
            saveError: null,
            status: dirty ? 'pending' : 'saved',
            ...withSaveIssues({ ...s.issueSources, save: { errors: [], warnings: result.warnings } }),
        });
        ctx.deps.onSaved?.(result);
        if (dirty && epoch !== ctx.epoch) scheduleSave(ctx);
    };

    const failed = (err: unknown): SaveOutcome => {
        const failure = classifySaveError(err);
        const s = get();
        set({
            status: 'error',
            saveError: { kind: failure.kind, error: err, status: failure.status, code: failure.code, willRetry: false },
            ...(failure.details.length ? withSaveIssues({ ...s.issueSources, save: { errors: failure.details, warnings: [] } }) : {}),
        });
        return failure.kind;
    };

    return { succeeded, failed };
}

/** The one create in flight, shared by everyone who needs the row. */
function sharedCreate(set: SetDraft, ctx: DraftContext) {
    return (definition: FlowDefinition) => {
        ctx.createInFlight ??= ctx.deps
            .create({ title: ctx.title, definition })
            .then((result) => {
                const row = result.automation;
                if (!row?.id) throw new Error(translate('mobile.flow.create_failed', 'The automation could not be created.'));
                set({ automationId: row.id });
                ctx.deps.onCreated?.(row);
                return { result, sent: definition };
            })
            .finally(() => {
                ctx.createInFlight = null;
            });
        return ctx.createInFlight;
    };
}

export function saveActions(set: SetDraft, get: GetDraft, ctx: DraftContext): SaveActions {
    const book = bookkeeping(set, get, ctx);
    const createShared = sharedCreate(set, ctx);

    /** Send the newest definition once; the outcome tells the scheduler what next. */
    const saveOnce = async (): Promise<SaveOutcome> => {
        const s = get();
        if (!s.ready || !s.definition || !s.dirty) {
            if (s.saveError && !s.dirty) set({ saveError: null, status: 'saved' });
            return 'done';
        }
        // The last create may have landed: wait for the person to say "try again".
        if (!s.automationId && ctx.createUnsure) {
            set({ status: 'error' });
            return 'permanent';
        }
        const epoch = ctx.epoch;
        const sent = s.definition;
        set({ status: 'saving' });
        try {
            if (s.automationId) book.succeeded(sent, epoch, await ctx.deps.save(s.automationId, sent));
            else {
                const created = await createShared(sent);
                book.succeeded(created.sent, epoch, created.result);
            }
            return 'done';
        } catch (err) {
            const outcome = book.failed(err);
            if (s.automationId || outcome !== 'transient') return outcome;
            // A create is never retried on its own (automations' createAutomation says why).
            ctx.createUnsure = true;
            return 'permanent';
        }
    };

    const scheduler = new SaveScheduler(saveOnce, {
        delayMs: ctx.deps.delayMs ?? SAVE_DELAY_MS,
        retryDelaysMs: ctx.deps.retryDelaysMs ?? RETRY_DELAYS_MS,
        onRetry: (willRetry) => {
            const error = get().saveError;
            if (error && error.willRetry !== willRetry) set({ saveError: { ...error, willRetry } });
        },
    });
    ctx.scheduler = scheduler;

    const flush = async () => {
        await scheduler.flush();
        return !get().dirty;
    };

    return {
        flush,
        retry: () => {
            ctx.createUnsure = false;
            return flush();
        },
        ensureCreated: async () => {
            const s = get();
            if (s.automationId) return s.automationId;
            if (!s.ready || !s.definition) throw notReady();
            const epoch = ctx.epoch;
            ctx.createUnsure = false;
            try {
                const created = await createShared(s.definition);
                book.succeeded(created.sent, epoch, created.result);
            } catch (err) {
                book.failed(err);
                throw err;
            }
            const id = get().automationId;
            if (!id) throw notReady();
            return id;
        },
        dispose: () => scheduler.dispose(),
    };
}
