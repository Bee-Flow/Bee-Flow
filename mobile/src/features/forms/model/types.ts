/**
 * Form shapes, as the server sends them:
 *
 *   FormSummary  server/routes/automation/crud.js GET /forms (assembled in the
 *                handler, NOT a store row — it merges the page row with the
 *                form trigger out of the automation definition)
 *   FormDetail   the same file, GET /forms/:automationId — one form for the
 *                Form page, with its questions, its later pages and, for the
 *                owner only, the routine's definition
 *
 * The answers dashboard's shapes are in answerTypes.ts, the filling screen's
 * in fillTypes.ts.
 */

import type { FillField } from './fillTypes';

/**
 * Who may fill a form in (automation/formAudience.js publicAudience): the whole
 * organisation, or only the people and groups the owner listed. The lists are
 * the owner's to see; everyone else gets the mode alone (empty lists here).
 */
export interface FormAudience {
    mode: 'org' | 'restricted';
    groups: string[];
    users: string[];
}

/** The last write into the answers table that failed, as the Form page shows it. */
export interface AnswersWriteError {
    code: string | null;
    message: string | null;
}

/**
 * The answers table behind a form, with THIS caller's grade on it — what
 * decides whether the Answers dashboard is theirs to open. `datatableId` is
 * null when the caller has no grade on the table, or when a form that collects
 * has no table yet (provisioning failed).
 */
export interface FormAnswersInfo {
    collecting: boolean;
    datatableId: string | null;
    grade: string | null;
    rowCount: number | null;
    linked: boolean;
    lastWriteError: AnswersWriteError | null;
}

/**
 * A hosted form, as GET /api/automation/forms assembles it.
 *
 * `id` is the form PAGE id — the token in the /f/<id> address and its only
 * credential — not the automation's. Everything the Form page does is keyed by
 * the routine behind it (`automationId`); the token only ever travels to the
 * filling screen and into a shared link, never into a Form page route.
 *
 * `url` arrives as the bare path `/f/<id>`; publicFormUrl() in api/endpoints.ts
 * makes it absolute.
 */
export interface FormSummary {
    id: string;
    url: string;
    automationId: string;
    triggerStepId: string | null;
    title: string;
    description: string | null;
    /** `isActive && !isDraft` — both have to hold or the link answers "not found". */
    live: boolean;
    submissions: number;
    lastSeenAt: string | null;
    createdAt: string | null;
    /** Whether the caller owns the routine. The automation endpoints are per-user. */
    mine: boolean;
    /** Whether the caller may FILL IT IN: the visitor gate's own verdict. */
    canOpen: boolean;
    audience: FormAudience;
    answers: FormAnswersInfo | null;
}

/** The trigger's form as the Form page reads it: normalised fields, raw theme. */
export interface FormQuestions {
    title: string;
    description: string;
    submitLabel: string;
    successMessage: string;
    collect: boolean;
    fields: FillField[];
    theme: Record<string, unknown> | null;
}

/** A later page of the form: a `form_page` step in the routine. */
export interface FormPageSummary {
    stepId: string;
    label: string;
    fields: FillField[];
}

/** GET /api/automation/forms/:automationId → `{ form }`. */
export interface FormDetail extends FormSummary {
    isActive: boolean;
    isDraft: boolean;
    questions: FormQuestions;
    pages: FormPageSummary[];
    /** The routine's definition — present for the owner only. */
    definition: Record<string, unknown> | null;
    routineTitle: string;
}

/** "Build it with AI" — POST /forms/ai/draft → `{ draft: { form, notes } }`. */
export interface AiFormDraft {
    /** The drafted form declaration; nothing is stored until the person saves it. */
    form: Record<string, unknown> & { fields: unknown[] };
    notes: string | null;
}
