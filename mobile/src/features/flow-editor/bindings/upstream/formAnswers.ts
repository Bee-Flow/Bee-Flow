/**
 * What an ANSWERED form field looks like as a sample — shared by the form
 * trigger and a form page midway through the run. Port of agent-hub
 * `Builder/mapping/upstream/formAnswers.js`.
 */

import { translate as t } from '@/core/i18n';

import { pickSourceById } from '../flowDeps/pickSources';
import type { FlowNode, FormFieldDecl, VariableGroup } from '../types';

// Example payload values (data, not copy): what a picked record reads like.
const PICK_EXAMPLE = {
    recordId: 'rec_123',
    recordTitle: 'Kickoff with Acme',
    recordText: 'The text of the record — the transcript, the email body, the note.',
};

/**
 * An `app_pick` answer: the reference chosen, the text read from it, and the
 * record's own structured `data` from the server's registry — never a shape
 * invented here. A multiple-choice question yields a LIST of these.
 */
export function pickSample(field: FormFieldDecl): unknown {
    const source = pickSourceById(field.source);
    const data = source?.sampleData;
    const one = {
        kind: 'app_pick',
        source: field.source || '',
        app: source?.app || field.app || '',
        recordId: PICK_EXAMPLE.recordId,
        title: PICK_EXAMPLE.recordTitle,
        text: PICK_EXAMPLE.recordText,
        ...(data && Object.keys(data).length ? { data } : {}),
    };
    return field.multiple ? [one] : one;
}

/** A typed example answer for one declared form field. */
export function answerSample(f: FormFieldDecl): unknown {
    switch (f.type) {
        case 'checkbox':
            return true;
        case 'number':
            return 42;
        case 'date':
            return '2026-01-31';
        case 'file':
            return { kind: 'form_upload', filename: 'attachment.pdf' };
        case 'app_pick':
            return pickSample(f);
        case 'email':
            return 'visitor@example.com';
        default:
            return f.label || 'answer';
    }
}

/** The declared fields that have a name. */
export function namedFormFields(form: FlowNode['form']): FormFieldDecl[] {
    return Array.isArray(form?.fields) ? form.fields.filter((f) => f?.name) : [];
}

/**
 * A form page's output IS the visitor's answers, keyed by field name; an
 * 'ending' page has nothing to bind.
 */
export function describeFormPage(node: FlowNode): VariableGroup | null {
    if (node.mode === 'ending') return null;
    const fields = namedFormFields(node.form);
    const base = `steps.${node.id}.output`;
    return {
        id: node.id,
        label: node.label || node.form?.title || t('routines.node.form_page.typeLabel', 'Form page'),
        kind: 'form_page',
        basePath: base,
        sample: Object.fromEntries(fields.map((f) => [f.name, answerSample(f)])),
        fields: fields.map((f) => ({ key: f.name as string, path: `${base}.${f.name}`, sample: answerSample(f) })),
    };
}
