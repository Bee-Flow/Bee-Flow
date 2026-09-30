/**
 * The form contract against server/automation/formTriggerContract.js.
 *
 * TEXTUAL: the field types and every limit are read out of the server's
 * source (and the two it borrows). DIFFERENTIAL: forms are rendered by the
 * server's own renderFormConfig, read by the phone's reader, answered, and
 * then checked twice — by the phone's validateAnswers and by the server's
 * coerceSubmission on exactly the body the phone would send. Both must refuse
 * the same questions; an empty page must carry the server's empty values.
 *
 * When this fails, the server changed. Update the port; don't loosen the test.
 */

import {
    answersBody,
    DATE_RE,
    DEFAULT_UPLOAD_MB,
    DISPLAY_FIELD_TYPES,
    EMAIL_RE,
    FIELD_TYPES,
    FILE_FIELD_TYPES,
    initialValues,
    MAX_FIELDS,
    MAX_LABEL_LEN,
    MAX_OPTION_LEN,
    MAX_OPTIONS,
    MAX_PICKS,
    MAX_STRING_VALUE,
    MAX_TEXT_LEN,
    MAX_TEXTAREA_LEN,
    MAX_UPLOAD_MB,
    validateAnswers,
} from './contract';
import type { Answers } from './fillTypes';
import { readFillForm } from '../api/fillReaders';
import { constText, readServer, requireServer } from '../testing/sources';

interface ServerContract {
    FIELD_TYPES: readonly string[];
    DISPLAY_FIELD_TYPES: readonly string[];
    FILE_FIELD_TYPES: readonly string[];
    MAX_FIELDS: number;
    MAX_UPLOAD_MB: number;
    DEFAULT_UPLOAD_MB: number;
    renderFormConfig: (form: unknown) => unknown;
    normalizeFields: (form: unknown) => unknown[];
    coerceSubmission: (fields: unknown[], body: unknown) => { values: Record<string, unknown>; errors: { field: string }[] };
    emptyFormValues: (form: unknown) => Record<string, unknown>;
}

const contract = requireServer<ServerContract>('automation/formTriggerContract.js');
const pickSources = requireServer<{ SOURCE_IDS: readonly string[] }>('automation/formPickSources.js');
const src = readServer('automation/formTriggerContract.js');
const num = (text: string, name: string) => Number(constText(text, name));

describe('the field types and limits', () => {
    it('declares the server’s field types, in its order', () => {
        expect([...FIELD_TYPES]).toEqual([...contract.FIELD_TYPES]);
        expect([...DISPLAY_FIELD_TYPES]).toEqual([...contract.DISPLAY_FIELD_TYPES]);
        expect([...FILE_FIELD_TYPES]).toEqual([...contract.FILE_FIELD_TYPES]);
    });

    it('keeps every limit the server enforces', () => {
        expect(MAX_FIELDS).toBe(contract.MAX_FIELDS);
        expect(MAX_FIELDS).toBe(40);
        expect(MAX_UPLOAD_MB).toBe(contract.MAX_UPLOAD_MB);
        expect(MAX_UPLOAD_MB).toBe(25);
        expect(DEFAULT_UPLOAD_MB).toBe(contract.DEFAULT_UPLOAD_MB);
        expect(MAX_OPTIONS).toBe(num(src, 'MAX_OPTIONS'));
        expect(MAX_OPTIONS).toBe(50);
        expect(MAX_OPTION_LEN).toBe(num(src, 'MAX_OPTION_LEN'));
        expect(MAX_LABEL_LEN).toBe(num(src, 'MAX_LABEL_LEN'));
        expect(MAX_TEXT_LEN).toBe(num(src, 'MAX_TEXT_LEN'));
        expect(MAX_TEXTAREA_LEN).toBe(num(src, 'MAX_TEXTAREA_LEN'));
        expect(MAX_STRING_VALUE).toBe(num(readServer('automation/appTriggerContract.js'), 'MAX_STRING_VALUE'));
        expect(MAX_PICKS).toBe(num(readServer('automation/formPickSources.js'), 'MAX_PICKS'));
    });

    it('checks emails and dates with the server’s own patterns', () => {
        expect(EMAIL_RE.toString()).toBe(constText(src, 'EMAIL_RE'));
        expect(DATE_RE.toString()).toBe(constText(src, 'DATE_RE'));
    });
});

const SOURCE = pickSources.SOURCE_IDS[0] as string;

const FORM = {
    title: 'Intake',
    fields: [
        { name: 'full_name', type: 'text', label: 'Your name', required: true },
        { name: 'email', type: 'email', label: 'Email', required: true },
        { name: 'age', type: 'number', label: 'Age' },
        { name: 'start', type: 'date', label: 'Start' },
        { name: 'team', type: 'select', label: 'Team', options: ['Sales', { value: 'support', label: 'Support' }] },
        { name: 'agree', type: 'checkbox', label: 'I agree', required: true },
        { name: 'notes', type: 'textarea', label: 'Notes' },
        { name: 'cv', type: 'file', label: 'CV', maxSizeMb: 5 },
        { name: 'calls', type: 'app_pick', label: 'Calls', source: SOURCE, multiple: true, maxItems: 2 },
        { name: 'one_call', type: 'app_pick', label: 'One call', source: SOURCE, required: true },
    ],
};

const pick = (recordId: string) => ({ kind: 'app_pick' as const, source: SOURCE, recordId, title: recordId });

const ANSWERS: [string, Answers][] = [
    ['nothing answered', {}],
    [
        'everything answered well',
        {
            full_name: 'Anna', email: 'anna@example.org', age: '41', start: '2026-09-30', team: 'support', agree: true, notes: 'hi',
            cv: { kind: 'form_upload', fileId: 'f1', filename: 'cv.pdf', size: 10 }, calls: [pick('r1')], one_call: pick('r2'),
        },
    ],
    ['a bad email, number and date', { full_name: 'A', email: 'anna@', age: 'forty', start: '30-09-2026', agree: true, one_call: pick('r1') }],
    ['an off-list choice', { full_name: 'A', email: 'a@b.co', team: 'Marketing', agree: true, one_call: pick('r1') }],
    ['blank strings where required', { full_name: '   ', email: '', agree: false, one_call: null }],
    ['too many picks', { full_name: 'A', email: 'a@b.co', agree: true, calls: [pick('r1'), pick('r2'), pick('r3')], one_call: pick('r4') }],
    ['an optional number left empty', { full_name: 'A', email: 'a@b.co', age: '  ', agree: true, one_call: pick('r1') }],
    // The phone reads one decimal comma as a decimal and sends it with a dot, so the server accepts it too.
    ['a number with a decimal comma', { full_name: 'A', email: 'a@b.co', age: '41,5', agree: true, one_call: pick('r1') }],
    ['a number with a comma and a dot', { full_name: 'A', email: 'a@b.co', age: '1.000,5', agree: true, one_call: pick('r1') }],
];

describe('validation, beside the server’s coerceSubmission', () => {
    const rendered = readFillForm(contract.renderFormConfig(FORM));
    const serverFields = contract.normalizeFields(FORM);

    it('reads every rendered field', () => {
        expect(rendered.fields.map((f) => f.name)).toEqual(FORM.fields.map((f) => f.name));
    });

    it.each(ANSWERS)('refuses the same questions: %s', (_label, answers) => {
        const values = { ...initialValues(rendered.fields), ...answers };
        const mine = Object.keys(validateAnswers(rendered.fields, values)).sort();
        const theirs = contract.coerceSubmission(serverFields, answersBody(rendered.fields, values)).errors.map((e) => e.field).sort();
        expect(mine).toEqual(theirs);
    });

    it('starts a page with the server’s empty answers', () => {
        const mine = answersBody(rendered.fields, initialValues(rendered.fields));
        const empty = contract.emptyFormValues(FORM);
        // An unanswered number and pick travel as "left out" (null), which the server turns into its empty value.
        const theirs = contract.coerceSubmission(serverFields, mine).values;
        expect({ ...theirs }).toEqual({ ...empty });
    });

    it('never sends a display field', () => {
        const withDownload = readFillForm(contract.renderFormConfig({ fields: [{ name: 'doc', type: 'download', fileId: 'x' }, { name: 'a', type: 'text' }] }));
        expect(Object.keys(answersBody(withDownload.fields, initialValues(withDownload.fields)))).toEqual(['a']);
    });
});
