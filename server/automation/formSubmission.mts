/**
 * One way in for a form's first page, whoever submits it (critic gap 3):
 *
 *   the public form        POST /form/:token                  (formPublic/submit.js)
 *   a test link            POST /form/:token on a test row    (same route, found.test)
 *   the builder's overlay  POST /api/automation/:id/form-test (routes/automation/formTest.js)
 *
 * acceptSubmission does what a real submission always did, in the same order:
 * type and check the answers against the trigger's fields (coerceSubmission),
 * claim every uploaded file (once, for this page only) and read its text, read
 * every picked app record AS THE FILLER, bump the page's counter, refuse a
 * caller who has not confirmed the "your own connections" notice, write the
 * answers-table row, stamp the trigger headers and open the visitor session.
 * So a binding to trigger.headers.*, a pick's .text, a typed number or a file's
 * text resolves the same in a test as in production.
 *
 * What the profile changes, and nothing else:
 *   production  the counter, the answers row, a production run (formQueue)
 *   test        no counter, no answers row (the Answers dashboard never sees a
 *               test), headers.test = true, an is_test session, and a TEST run
 *               of the working copy started as the submitter (who holds the
 *               sandbox approval seat; the owner may decide too)
 *   dry         as test, and the run is a dry run that pauses for real at
 *               approvals and form pages (the builder's default)
 * The caller-notice gate applies to all three: a tester meets what a real
 * submitter meets (critic gap 7). Test answers stay in the run row only.
 *
 * queueSubmission hands the work to the per-automation form queue and answers
 * 202 { accepted, sessionId } (the visitor page polls the session);
 * startSubmission starts the same run at once, for a caller that follows it by
 * id (the builder, through startCapped).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Row = Record<string, any>;

export type SubmissionKind = 'production' | 'test' | 'dry';
export type SubmissionOrigin = 'trigger' | 'test_link' | 'builder';
export interface SubmissionProfile { kind: SubmissionKind; origin: SubmissionOrigin }

export const PUBLIC_SUBMISSION: SubmissionProfile = Object.freeze({ kind: 'production', origin: 'trigger' });
export const TEST_LINK_SUBMISSION: SubmissionProfile = Object.freeze({ kind: 'test', origin: 'test_link' });
export const BUILDER_LIVE_SUBMISSION: SubmissionProfile = Object.freeze({ kind: 'test', origin: 'builder' });
export const BUILDER_DRY_SUBMISSION: SubmissionProfile = Object.freeze({ kind: 'dry', origin: 'builder' });

/** What formPublic/access.js loadForm (or the builder route) resolved the request to. */
export interface FoundForm {
    token: string;
    page: { triggerStepId?: string | null };
    automation: Row;
    definition: Row;
    test?: boolean;
}

/**
 * Who submits: the signed-in person (null for an anonymous visitor), their
 * browser, and how to read the app records they picked AS THEM
 * (routes/automation/formPublic/picks.js resolvePicks, bound to the request).
 */
export interface SubmissionCaller {
    userId: string | null;
    userAgent?: string;
    readPicks: (picks: unknown[], values: Row) => Promise<void>;
    /** A public form is a system start: the submitter is not the run's starter. */
    publicForm?: boolean;
}

/** What sits in the session's pending_work (formQueueWork.js submitThunk). */
export interface SubmitWork {
    kind: 'submit';
    payload: Row;
    submitterId: string | null;
    publicForm: boolean;
    isTest?: true;
    origin?: SubmissionOrigin;
    mode?: 'dry_run';
}

/** Refused (400, the fields that need attention) or accepted (the session and the work to run). */
export type Accepted =
    | { ok: false; status: 400; body: { error: string; fields: unknown[] }; session?: undefined; work?: undefined }
    | { ok: true; session: Row; work: SubmitWork; status?: undefined; body?: undefined };

/** The dependencies, injectable for a test; the defaults are the real modules. */
export interface SubmissionDeps {
    store: Row;
    formTriggerFields: (definition: Row) => Row[];
    coerceSubmission: (fields: Row[], body: Row) => { values: Row; files: { field: string; fileId: string }[]; picks: unknown[]; errors: unknown[] };
    describeClaimedUpload: (claimed: Row) => Promise<unknown>;
    assertFormStartAllowed: (args: { automation: Row; submitterId: string | null; store: Row }) => Promise<void>;
    collectEnabled: (definition: Row) => boolean;
    recordSubmission: (args: { automation: Row; definition: Row; values: Row; submitterId: string | null }) => Promise<{ rowId: string; datatableId: string } | null>;
    bestEffort: (where: string, e: unknown) => void;
    now: () => Date;
}

function defaultDeps(): SubmissionDeps {
    const contract = nodeRequire('./formTriggerContract');
    return {
        store: nodeRequire('../stores/automationStore'),
        formTriggerFields: contract.formTriggerFields,
        coerceSubmission: contract.coerceSubmission,
        describeClaimedUpload: nodeRequire('./formUploadText').describeClaimedUpload,
        assertFormStartAllowed: nodeRequire('./formCallerNotice').assertFormStartAllowed,
        collectEnabled: nodeRequire('./formAnswers/derive').collectEnabled,
        recordSubmission: (args) => nodeRequire('./formAnswers').write.recordSubmission(args),
        bestEffort: nodeRequire('../utils/bestEffort').bestEffort,
        now: () => new Date(),
    };
}

const refused = (fields: unknown[]): Accepted => ({ ok: false, status: 400, body: { error: 'Some answers need attention', fields } });

/** The profile a loaded form submits with: a test link's row is a test, anything else production. */
export function profileForFound(found: Pick<FoundForm, 'test'>): SubmissionProfile {
    return found.test ? TEST_LINK_SUBMISSION : PUBLIC_SUBMISSION;
}

/**
 * Page one's answers, accepted (or refused with the fields that need
 * attention). Throws the caller-notice refusal (409) like the route always did.
 */
export async function acceptSubmission(found: FoundForm, body: Row, caller: SubmissionCaller, profile: SubmissionProfile, deps: SubmissionDeps = defaultDeps()): Promise<Accepted> {
    const { store } = deps;
    const production = profile.kind === 'production';
    const fields = deps.formTriggerFields(found.definition);
    const { values, files, picks, errors } = deps.coerceSubmission(fields, body);
    if (errors.length) return refused(errors);

    // Claim every referenced upload, atomically, so a replayed submission
    // cannot re-attach the same file, and a file uploaded through another
    // form cannot be attached to this one. The descriptor carries the file's
    // TEXT as well as its receipt; never throws.
    for (const { field, fileId } of files) {
        const claimed = await store.claimFormUpload(fileId, found.token);
        if (!claimed) return refused([{ field, message: 'That file is no longer available — please attach it again.' }]);
        values[field] = await deps.describeClaimedUpload(claimed);
    }

    // Records picked from an app the FILLER can reach.
    await caller.readPicks(picks, values);

    // The page's counter counts real submissions only.
    if (production) await store.touchFormPage(found.token).catch((e: unknown) => deps.bestEffort('automation/formSubmission:touch', e));

    const submitterId = caller.userId || null;
    const publicForm = production && caller.publicForm === true;
    // A public form is a system start; only a members-only form (and every
    // test) has its submitter as the starter, who must have seen the notice.
    await deps.assertFormStartAllowed({ automation: found.automation, submitterId: publicForm ? null : submitterId, store });

    // The answers TABLE gets its row first, before the run is even queued, so
    // the owner sees the submission whatever the run does. Never for a test.
    const answers = production && deps.collectEnabled(found.definition)
        ? await deps.recordSubmission({ automation: found.automation, definition: found.definition, values, submitterId })
        : null;

    // Metadata rides on trigger.headers, never inside trigger.output: a field
    // called `submitted_at` must not be shadowed by ours. The answers row id
    // rides here too, so every later page of the journey finds its row.
    const triggerHeaders: Row = {
        submitted_at: deps.now().toISOString(),
        form_page_id: found.token,
        user_agent: String(caller.userAgent || '').slice(0, 300),
        ...(answers ? { answers_row_id: answers.rowId, answers_datatable_id: answers.datatableId } : {}),
        ...(production ? {} : { test: true }),
    };

    // Every submission gets a session, even a single-page form's: it is how
    // the browser learns whether the run paused for another page, finished
    // with a summary, or failed. Stored BEFORE the run starts.
    const session = await store.createFormSession(found.token, found.automation.id, {
        rootStepId: found.page.triggerStepId || null, triggerHeaders, isTest: !production,
    });

    const work: SubmitWork = {
        kind: 'submit',
        payload: { ...values },
        submitterId,
        publicForm,
        ...(production ? {} : { isTest: true as const, origin: profile.origin }),
        ...(profile.kind === 'dry' ? { mode: 'dry_run' as const } : {}),
    };
    return { ok: true, session, work };
}

/**
 * Persist the accepted work on its session, answer 202 { accepted, sessionId },
 * then run it through the per-automation form queue (automation/formQueue.js).
 */
export async function queueSubmission(found: FoundForm, accepted: { session: Row; work: SubmitWork }, res: unknown, formQueue: Row = nodeRequire('./formQueue')): Promise<void> {
    await formQueue.accept({ automation: found.automation, session: accepted.session, work: accepted.work }, res, { sessionId: accepted.session.id });
}

/**
 * Start the accepted work now (no queue: a test run holds no running marker,
 * so it cannot lose a race to another submission). The same run options as
 * the queue's (formQueueWork.js submitThunk); `onRunCreated` hears of the run
 * the moment its row exists (startCapped).
 */
export function startSubmission(found: FoundForm, accepted: { session: Row; work: SubmitWork }, onRunCreated: ((run: Row) => void) | null = null, formWork: Row = defaultFormWork()): Promise<Row | null> {
    return formWork.submitThunk(found.automation, accepted.session, accepted.work, { onRunCreated })();
}

function defaultFormWork(): Row {
    const { createFormWork } = nodeRequire('./formQueueWork');
    return createFormWork({
        automationStore: nodeRequire('../stores/automationStore'),
        runner: () => nodeRequire('../core/automationRunner'),
        formAnswers: () => nodeRequire('./formAnswers').write,
    });
}
