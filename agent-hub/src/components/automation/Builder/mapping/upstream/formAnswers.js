/**
 * What an ANSWERED form field looks like as a sample.
 *
 * A hosted form reaches the run twice over: as the trigger's payload
 * (triggers.js) and as a form PAGE's output midway through — "the same shape
 * the trigger produces, one page later". The `app_pick` answer is the part
 * neither could write out for itself, so it lives here and both read it.
 */
import { pickSourceById } from '../../flow/pickSourceCatalog';

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
export function pickSample(field) {
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

export function describeFormPage(node) {
    if (node.mode === 'ending') return null;
    const fields = Array.isArray(node.form?.fields) ? node.form.fields.filter(f => f?.name) : [];
    const sampleFor = (f) => (f.type === 'checkbox' ? true
        : f.type === 'number' ? 42
        : f.type === 'date' ? '2026-01-31'
        : f.type === 'file' ? { kind: 'form_upload', filename: 'attachment.pdf' }
        : f.type === 'app_pick' ? pickSample(f)
        : f.type === 'email' ? 'visitor@example.com'
        : f.label || 'answer');
    const base = `steps.${node.id}.output`;
    return {
        id: node.id,
        label: node.label || node.form?.title || 'Form page',
        kind: 'form_page',
        basePath: base,
        sample: Object.fromEntries(fields.map(f => [f.name, sampleFor(f)])),
        fields: fields.map(f => ({ key: f.name, path: `${base}.${f.name}`, sample: sampleFor(f) })),
    };
}
