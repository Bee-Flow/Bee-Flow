/**
 * What an ANSWERED form field looks like as a sample.
 *
 * A hosted form reaches the run twice over: as the trigger's payload
 * (triggers.js) and as a form PAGE's output midway through — "the same shape
 * the trigger produces, one page later". The `app_pick` answer is the part
 * neither could write out for itself, so it lives here and both read it.
 */
import { appendKey } from '@shared/expr/path.mjs';
import { fieldFor } from './fieldTree';
import { pickSourceById } from '../../flow/pickSourceCatalog';
import { isDisplayField } from '../../flow/settings/formPreview';
import { normaliseOptions } from '../../../../forms/formOptions';
import type { FormFieldDecl, Group, UpstreamNode } from './upstream.types';

/**
 * A form page's output IS the visitor's answers, keyed by field name — the
 * same shape the trigger produces, one page later. Mirrors execFormPage's
 * return in server/core/automationRunner/engine.js: an 'input' page resolves
 * to the answers, an 'ending' page has nothing to bind.
 */
/**
 * What an `app_pick` answer looks like once the run has it: the reference the
 * person chose, the text read from the record, and the record's own structured
 * fields. A question that takes several records yields a LIST of these, which
 * is what makes a `forEach` over them mappable in the builder.
 *
 * `data` comes from the server's registry via pickSourceCatalog, never from a
 * shape written out here: the keys differ per app (a call has speakers, a mail
 * has a sender) and a sample that promises the wrong one hands the author a
 * binding that resolves to undefined forever. Before that registry has loaded
 * the sample simply has no `data` rows — fewer rows, never wrong ones.
 */
function pickSample(field: FormFieldDecl) {
    const source = pickSourceById(field.source);
    const one = {
        kind: 'app_pick',
        source: field.source || '',
        app: source?.app || field.app || '',
        recordId: 'rec_123',
        title: 'Kickoff with Acme',
        text: 'The text of the record — the transcript, the email body, the note.',
        ...(source?.sampleData && Object.keys(source.sampleData).length ? { data: source.sampleData } : {}),
    };
    return field.multiple ? [one] : one;
}

/**
 * One answered question as a sample: what a downstream step would see in
 * `<base>.<name>`. A choice question answers with the VALUE of a choice (the
 * first one, when the list is typed in), several choices answer with a list of
 * values, and a question asked once per list item answers with a list of
 * `{ key, label, answer }`.
 */
export function formFieldSample(f: FormFieldDecl): unknown {
    if (f.fieldsFrom) return [{ key: 'item_1', label: 'Item 1', answer: scalarSample({ ...f, fieldsFrom: undefined }) }];
    if (f.type === 'multiselect') {
        const first = normaliseOptions(f.options)[0]?.value;
        return [first || 'choice_1'];
    }
    return scalarSample(f);
}

function scalarSample(f: FormFieldDecl): unknown {
    if (f.type === 'radio') return normaliseOptions(f.options)[0]?.value || 'choice_1';
    return f.type === 'checkbox' ? true
        : f.type === 'number' ? 42
        : f.type === 'date' ? '2026-01-31'
        : f.type === 'file' ? { kind: 'form_upload', filename: 'attachment.pdf' }
        // A picked record, as the run receives it: the reference the person
        // chose, plus the text that was read from it. Shown even when the
        // question only takes one, because `.text` is what a downstream
        // step binds and it has to be visible to be draggable.
        : f.type === 'app_pick' ? pickSample(f)
        : f.type === 'email' ? 'visitor@example.com'
        : f.label || 'answer';
}

/**
 * The questions of a form that produce an answer: named, and not a display
 * field (a download, an Open in Notebooks button or a text block gives
 * instead of asks, so there is nothing to bind).
 */
export function answerableFields(form: { fields?: FormFieldDecl[] } | null | undefined): FormFieldDecl[] {
    return (Array.isArray(form?.fields) ? form.fields : []).filter(f => f?.name && !isDisplayField(f));
}

export function describeFormPage(node: UpstreamNode): Group | null {
    if (node.mode === 'ending') return null;
    const fields = answerableFields(node.form);
    const base = `steps.${node.id}.output`;
    return {
        id: node.id,
        label: node.label || node.form?.title || 'Form page',
        kind: 'form_page',
        basePath: base,
        sample: Object.fromEntries(fields.map(f => [f.name, formFieldSample(f)])),
        fields: fields.map(f => fieldFor(f.name, appendKey(base, f.name), formFieldSample(f))),
    };
}
