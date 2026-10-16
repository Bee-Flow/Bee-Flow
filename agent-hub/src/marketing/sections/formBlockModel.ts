// The pure half of the website form block: what a field is, how answers are
// collected and what a submission looks like on the wire. The server
// (server/core/cms/websiteForms.js) is the authority; this only spares the
// visitor a round trip for the obvious mistakes.

export type FormFieldType = 'text' | 'email' | 'textarea' | 'select' | 'checkbox';

export interface FormFieldOption {
    value: string;
    label?: string;
}

export interface FormField {
    id: string;
    type: FormFieldType;
    label?: string;
    placeholder?: string;
    required?: boolean;
    options?: FormFieldOption[];
}

export type FormAnswers = Record<string, string | boolean>;
export type FormErrors = Record<string, string>;

export const FORM_FIELD_TYPES: readonly FormFieldType[] = ['text', 'email', 'textarea', 'select', 'checkbox'];

const FIELD_ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,59}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The fields the renderer shows: well-formed, a known type, unique ids. */
export function usableFields(raw: unknown): FormField[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: FormField[] = [];
    for (const f of raw) {
        if (!isRecord(f) || typeof f.id !== 'string' || !FIELD_ID_RE.test(f.id) || seen.has(f.id)) continue;
        if (!FORM_FIELD_TYPES.includes(f.type as FormFieldType)) continue;
        seen.add(f.id);
        out.push({
            id: f.id,
            type: f.type as FormFieldType,
            label: typeof f.label === 'string' ? f.label : undefined,
            placeholder: typeof f.placeholder === 'string' ? f.placeholder : undefined,
            required: f.required === true,
            options: Array.isArray(f.options)
                ? f.options.filter(isRecord).filter(o => typeof o.value === 'string' && o.value !== '')
                    .map(o => ({ value: String(o.value), label: typeof o.label === 'string' ? o.label : undefined }))
                : undefined,
        });
    }
    return out;
}

export function emptyAnswers(fields: FormField[]): FormAnswers {
    const out: FormAnswers = {};
    for (const f of fields) out[f.id] = f.type === 'checkbox' ? false : '';
    return out;
}

/** The mistakes a person can fix before sending: required and email shape. */
export function checkAnswers(
    fields: FormField[],
    answers: FormAnswers,
    messages: { required: string; email: string },
): FormErrors {
    const errors: FormErrors = {};
    for (const f of fields) {
        const v = answers[f.id];
        const blank = f.type === 'checkbox' ? v !== true : typeof v !== 'string' || v.trim() === '';
        if (f.required && blank) errors[f.id] = messages.required;
        else if (f.type === 'email' && typeof v === 'string' && v.trim() !== '' && !EMAIL_RE.test(v.trim())) errors[f.id] = messages.email;
    }
    return errors;
}

/**
 * The honeypot's field name. Neutral on purpose (autofill fills "website");
 * keep in step with HONEYPOT_FIELD in server/routes/cmsForms.js.
 */
export const HONEYPOT_FIELD = 'ref_code_2';

/** The server refuses a submission younger than this (MIN_FORM_AGE_MS there). */
export const MIN_FORM_AGE_MS = 2000;

export interface SubmitPayload {
    token: string;
    issuedAt: number;
    nonce: string;
    locale?: string;
    [HONEYPOT_FIELD]: string;
    consent?: boolean;
    answers: Record<string, string | boolean>;
}

/** The request body. Text is trimmed; only the declared fields go out. */
export function buildPayload(
    fields: FormField[],
    answers: FormAnswers,
    token: { token: string; issuedAt: number },
    extras: { nonce: string; honeypot: string; consent: boolean | undefined; locale?: string },
): SubmitPayload {
    const sent: Record<string, string | boolean> = {};
    for (const f of fields) {
        const v = answers[f.id];
        sent[f.id] = typeof v === 'string' ? v.trim() : v === true;
    }
    return {
        token: token.token,
        issuedAt: token.issuedAt,
        nonce: extras.nonce,
        ...(extras.locale ? { locale: extras.locale } : {}),
        [HONEYPOT_FIELD]: extras.honeypot,
        ...(extras.consent === undefined ? {} : { consent: extras.consent }),
        answers: sent,
    };
}

/** Per-field messages out of the server's 400 body (`details.fields`), keyed by field id. */
export function fieldErrorsFromResponse(body: unknown): FormErrors {
    const out: FormErrors = {};
    const details = isRecord(body) && isRecord(body.details) ? body.details : null;
    const list = details && Array.isArray(details.fields) ? details.fields : [];
    for (const item of list) {
        if (isRecord(item) && typeof item.field === 'string' && typeof item.message === 'string') out[item.field] = item.message;
    }
    return out;
}

/**
 * The language the visitor's page is in: the locale prefix of the path
 * (`/nl/...`), else the document language. The server records the consent
 * wording it holds for that locale.
 */
export function pageLocale(pathname: string, documentLang: string, known: ReadonlySet<string>): string | undefined {
    const seg = (pathname.split('/')[1] || '').toLowerCase();
    if (known.has(seg)) return seg;
    const lang = documentLang.toLowerCase().split('-')[0];
    return /^[a-z]{2,3}$/.test(lang) ? lang : undefined;
}
