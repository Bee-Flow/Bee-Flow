/**
 * formJourney.mts: what a form journey needs when its run PAUSES (WI-12, D4c),
 * reached from core/automationRunner/runFinalize.js through the runner port
 * `formJourney` (automation/runnerPorts.js; core may not require automation/).
 *
 * paused({ run, status, expiresAt, automation, resumedFromStepId }) is called
 * after the paused run's outcome is written, for production AND test runs:
 *
 *   1. Every visitor session of the journey stays valid until
 *      max(now + SESSION_TTL_MS, pause deadline + 1 h). An approval can take
 *      days while the session idled out after 8 h, so the visitor's resumable
 *      link (/f/<token>?s=<sid>) died before page 2 was ever due. The session
 *      id is a credential: this widens how long it is valid, and the pause
 *      deadline bounds it (a pause without a deadline holds it at most
 *      NO_DEADLINE_HOLD_MS). An expired session is never revived, and a longer
 *      one is never shortened (stores/automationStore/formJourneyStore.mts).
 *   2. A form page that becomes due in the leg that continued from an APPROVAL
 *      (the visitor was told "you can close this page") is announced to the
 *      person who submitted the form: ONE in-app bell and ONE e-mail, to them
 *      only, saying "<form title>: the next page is ready" with the link. No
 *      answers, no approver, no reason: personal data leaves Bee Flow only by
 *      e-mail to the person themselves, and this mail carries none beyond the
 *      link to their own journey. Once per paused leg (the ledger row in
 *      automation_notification_events is the claim). Nothing for page 1 or any
 *      page right after another page (the visitor is still there), nothing
 *      without a session (a builder run), nothing without a known submitter
 *      (an anonymous public form), nothing for a builder or dry run.
 *
 * Never throws into the run: a failure is logged and the pause stands.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
// Which leg continued from an approval: the runner's own rule (formWait.mts imports nothing).
const { continuesFromApproval } = nodeRequire('../core/automationRunner/formWait.mts') as typeof import('../core/automationRunner/formWait.mts');

type Row = Record<string, any>;

/** How long past the pause deadline a session stays valid: time to open the mail and submit. */
export const SESSION_GRACE_MS = 60 * 60 * 1000;
/** A pause without a deadline (approval expiry switched off) holds the session at most this long. */
export const NO_DEADLINE_HOLD_MS = 30 * 24 * 60 * 60 * 1000;

/** Run origins whose submitter is a person waiting for the next page (production form, test link). */
const NOTIFY_ORIGINS: ReadonlySet<string> = new Set(['trigger', 'test_link']);

export interface JourneySession { id: string; formPageId: string; isTest: boolean; expiresAt: string | null }

export interface PausedInput {
    run: Row;
    status: string;
    expiresAt?: string | null;
    automation: Row;
    /** The step this leg continued from (a resume), or null for a first leg. */
    resumedFromStepId?: string | null;
}

export interface FormJourneyDeps {
    now: () => number;
    sessionTtlMs: number;
    sessionsOfJourney: (runId: string) => Promise<JourneySession[]>;
    extendSessionUntil: (id: string, until: Date) => Promise<unknown>;
    getRun: (id: string) => Promise<Row | null>;
    profileOf: (run: Row) => { kind?: string; origin?: string };
    claimNotice: (p: { automationId: string; runId: string; recipient: string }) => Promise<string | null>;
    settleNotice: (claimId: string, r: { bell: boolean; email: boolean | null }) => Promise<unknown>;
    bell: (p: { userId: string; title: string; message: string; link: string }) => Promise<unknown>;
    email: (p: { userId: string; subject: string; text: string }) => Promise<boolean | null>;
    absoluteUrl: (path: string) => string;
    warn: (message: string) => void;
}

export interface PausedResult { extended: number; notified: boolean }

/** Until when a session of a journey paused until `expiresAt` stays valid. */
export function sessionUntil(now: number, sessionTtlMs: number, expiresAt: string | null | undefined): Date {
    const deadline = expiresAt ? Date.parse(expiresAt) : Number.NaN;
    const hold = Number.isFinite(deadline) ? deadline + SESSION_GRACE_MS : now + NO_DEADLINE_HOLD_MS;
    return new Date(Math.max(now + sessionTtlMs, hold));
}

/** The visitor's resumable address: the form page and their session. */
export function formPageLink(token: string, sid: string): string {
    return `/f/${encodeURIComponent(token)}?s=${encodeURIComponent(sid)}`;
}

/** The form's own title (the trigger the run entered through), else the automation's. */
export function formTitleOf(automation: Row, rootStepId: string | null | undefined): string {
    const def = automation?.definition || {};
    const triggers = [def.trigger, ...(Array.isArray(def.triggers) ? def.triggers : [])].filter(Boolean);
    const entered = (rootStepId && triggers.find((t: Row) => t.id === rootStepId)) || def.trigger || null;
    const title = typeof entered?.form?.title === 'string' ? entered.form.title.trim() : '';
    if (title) return title.slice(0, 120);
    const fallback = typeof automation?.title === 'string' ? automation.title.trim() : '';
    return (fallback || 'Your form').slice(0, 120);
}

export function makeFormJourney(deps: FormJourneyDeps) {
    async function extendSessions(sessions: JourneySession[], expiresAt: string | null | undefined): Promise<number> {
        const until = sessionUntil(deps.now(), deps.sessionTtlMs, expiresAt);
        let extended = 0;
        for (const s of sessions) {
            try {
                await deps.extendSessionUntil(s.id, until);
                extended += 1;
            } catch (e) {
                deps.warn(`[formJourney] could not extend form session for run: ${(e as Error).message}`);
            }
        }
        return extended;
    }

    /** The submitter to tell, or null when nobody should hear about this page. */
    async function submitterToTell(input: PausedInput): Promise<{ userId: string; rootRun: Row } | null> {
        const { run, status, automation, resumedFromStepId } = input;
        if (status !== 'awaiting_form' || !run?.parentRunId) return null;
        if (!continuesFromApproval({ resumedFromStepId, definition: automation?.definition })) return null;
        const profile = deps.profileOf(run);
        if (profile.kind === 'dry' || !NOTIFY_ORIGINS.has(String(profile.origin || ''))) return null;
        const rootId = run.rootRunId || run.id;
        const rootRun = rootId === run.id ? run : await deps.getRun(rootId);
        const userId = rootRun?.submittedByUserId;
        return typeof userId === 'string' && userId ? { userId, rootRun } : null;
    }

    async function announce(input: PausedInput, session: JourneySession, to: { userId: string; rootRun: Row }): Promise<boolean> {
        const { run, automation } = input;
        const claim = await deps.claimNotice({ automationId: String(automation.id || run.automationId), runId: String(run.id), recipient: to.userId });
        if (!claim) return false;
        const title = `${formTitleOf(automation, to.rootRun?.rootStepId ?? run.rootStepId)}: the next page is ready`;
        const link = formPageLink(session.formPageId, session.id);
        let bell = false;
        try {
            await deps.bell({ userId: to.userId, title, message: 'Open the form to continue where you left off.', link });
            bell = true;
        } catch (e) {
            deps.warn(`[formJourney] bell failed for run ${run.id}: ${(e as Error).message}`);
        }
        let email: boolean | null = null;
        try {
            email = await deps.email({ userId: to.userId, subject: title, text: `${title}.\n\nContinue here: ${deps.absoluteUrl(link)}` });
        } catch (e) {
            email = false;
            deps.warn(`[formJourney] e-mail failed for run ${run.id}: ${(e as Error).message}`);
        }
        await deps.settleNotice(claim, { bell, email });
        return true;
    }

    async function paused(input: PausedInput): Promise<PausedResult> {
        const result: PausedResult = { extended: 0, notified: false };
        const { run, status } = input;
        if (!run?.id || (status !== 'awaiting_form' && status !== 'awaiting_approval')) return result;
        try {
            const sessions = await deps.sessionsOfJourney(String(run.id));
            if (!sessions.length) return result;
            result.extended = await extendSessions(sessions, input.expiresAt);
            const to = await submitterToTell(input);
            // One journey has one visitor session (a second is never expected, and
            // is not told twice); a link that no longer opens is not sent at all.
            const live = sessions.find((s) => !s.expiresAt || Date.parse(s.expiresAt) > deps.now());
            if (to && live) result.notified = await announce(input, live, to);
        } catch (e) {
            deps.warn(`[formJourney] pause bookkeeping failed for run ${run.id}: ${(e as Error).message}`);
        }
        return result;
    }

    return { paused };
}

/**
 * The product's wiring: every row through the automationStore facade (a test
 * that mocks the store gets its mock, never a stray database), the bell and
 * the service mailbox.
 */
export function defaultFormJourneyDeps(): FormJourneyDeps {
    const store = () => nodeRequire('../stores/automationStore');
    const log = nodeRequire('../telemetry/log');
    return {
        now: () => Date.now(),
        sessionTtlMs: Number(store().SESSION_TTL_MS) || 8 * 60 * 60 * 1000,
        // A stand-in store without form sessions (a runner unit test) has no journey to hold.
        sessionsOfJourney: async (runId) => {
            const read = store().formSessionsOfJourney;
            return typeof read === 'function' ? read(runId) : [];
        },
        extendSessionUntil: (id, until) => store().extendFormSessionUntil(id, until),
        getRun: (id) => store().getRun(id),
        profileOf: (run) => nodeRequire('../core/automationModel/runProfile.mts').profileOfRun(run),
        claimNotice: (p) => store().claimFormPageNotice(p),
        settleNotice: (claimId, r) => store().settleFormPageNotice(claimId, r),
        bell: ({ userId, title, message, link }) => nodeRequire('../stores/notificationStore').createNotification({
            userId, category: 'heads_up', title, message, link,
        }),
        email: async ({ userId, subject, text }) => {
            const mail = nodeRequire('../utils/emailService');
            const config = await mail.getServiceEmailConfig();
            if (!config?.configured) return null;
            const user = await nodeRequire('../stores/userStore').getUser(userId);
            if (!user?.email) return null;
            const sent = await mail.sendServiceEmail({ to: user.email, subject, text });
            return !(sent && sent.success === false);
        },
        absoluteUrl: (path) => {
            try { return `${nodeRequire('../utils/publicUrl').resolvePublicBaseUrl()}${path}`; } catch { return path; }
        },
        warn: (message) => log.warn(message),
    };
}

let instance: ReturnType<typeof makeFormJourney> | null = null;

/** The port's entry: the default instance, built on first use. */
export function paused(input: PausedInput): Promise<PausedResult> {
    if (!instance) instance = makeFormJourney(defaultFormJourneyDeps());
    return instance.paused(input);
}
