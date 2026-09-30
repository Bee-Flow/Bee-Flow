/**
 * What filling a form in exchanges with the server
 * (server/routes/automation/formPublic.js, all under /api/automation/form):
 *
 *   GET  /form/:token            → { form: renderConfig + multiPage, csrf, issuedAt }
 *   POST /form/:token            → 202 { accepted, sessionId } | 400 { fields: [{field, message}] }
 *   POST /form/:token/upload     → { fileId, filename, size, mimeType }
 *   POST /form/:token/pick       → { results: [{ id, title, subtitle }], error? }
 *   GET  /form/:token/s/:sid     → working | form | done | expired | error
 *   POST /form/:token/s/:sid     → the answers to page N
 *
 * The field shapes are formTriggerContract.js's normalizeFields: every field
 * the page shows has already been cleaned by the server, so this side reads
 * what it is sent rather than repairing it.
 */

/** One choice of a dropdown: a closed vocabulary, checked on the server. */
export interface FillOption {
    value: string;
    label: string;
}

/** One question (or, on a later page, a file handed over) as the server renders it. */
export interface FillField {
    name: string;
    type: string;
    label: string;
    required: boolean;
    placeholder: string;
    help: string;
    options: FillOption[];
    /** file: accepted types (an `accept` attribute) and the size cap. */
    accept: string;
    maxSizeMb: number;
    /** app_pick: the source the question searches, as the server resolved it. */
    source: string;
    app: string;
    sourceLabel: string;
    searchHint: string;
    multiple: boolean;
    maxItems: number;
    /** download / notebook: the generated file, resolved against THIS journey. */
    fileId: string;
    filename: string;
    mimeType: string;
    size: number | null;
}

/** A page of the form: the trigger's (page one), a later one, or the closing one. */
export interface FillForm {
    title: string;
    description: string;
    submitLabel: string;
    successMessage: string;
    theme: Record<string, unknown> | null;
    fields: FillField[];
    /** Page one only: whether the routine may pause for another page. */
    multiPage: boolean;
}

/** The first page, with the CSRF token bound to this form's token. */
export interface FillStart {
    form: FillForm;
    csrf: string;
    issuedAt: number;
}

/** Where a submitted journey is — the poll's answer. */
export type FillSession =
    | { state: 'working'; progress: string[]; progressNote: string | null }
    | { state: 'form'; stepId: string; form: FillForm; csrf: string; issuedAt: number }
    | { state: 'done'; ending: FillForm | null }
    | { state: 'expired' }
    | { state: 'error' };

/** A submit the server took: a session to follow, or a silent duplicate. */
export interface FillAck {
    accepted: boolean;
    sessionId: string | null;
    duplicate: boolean;
}

/** A file the upload call stored and scanned; only this descriptor travels with the answers. */
export interface UploadedFile {
    fileId: string;
    filename: string;
    size: number | null;
    mimeType: string;
}

/** A file on the device, picked for a file question. */
export interface FillUploadFile {
    uri: string;
    name: string;
    mimeType: string;
    /** From the picker; 0 when unknown (the cap is then the server's). */
    size: number;
}

/** One record an `app_pick` question's search found, in the FILLER's own account. */
export interface PickRow {
    id: string;
    title: string;
    subtitle: string;
}

export interface PickResults {
    results: PickRow[];
    /** "Not connected for your account" — a reason to print, not a failure. */
    error: string | null;
}

/** An answer the filling screen holds, per field type (see contract.ts emptyValue). */
export type FileAnswer = { kind: 'form_upload'; fileId: string; filename: string; size: number | null };
export type PickAnswer = { kind: 'app_pick'; source: string; recordId: string; title: string };
export type Answer = string | boolean | FileAnswer | PickAnswer | PickAnswer[] | null;
export type Answers = Record<string, Answer>;
