/**
 * What an ANSWERED form field looks like as a sample.
 *
 * A hosted form reaches the run twice over: as the trigger's payload
 * (triggers.mjs) and as a form PAGE's output midway through, "the same shape
 * the trigger produces, one page later". Mirrors execFormPage's return in
 * server/core/automationRunner/engine.js: an 'input' page resolves to the
 * answers, an 'ending' page has nothing to bind.
 */
import { groupLabel, resolveEnv } from './env.mjs';
import { stepGroup } from './sampleFields.mjs';

/**
 * What an `app_pick` answer looks like once the run has it: the reference the
 * person chose, the text read from the record, and the record's own
 * structured fields. A question that takes several records yields a LIST of
 * these, which is what makes a per-item step over them mappable.
 *
 * `data` comes from the server's registry (env.pickSourceById), never from a
 * shape written out here: the keys differ per app, and a sample that promises
 * the wrong one hands the author a binding that resolves to undefined
 * forever. Before the registry has loaded the sample simply has no `data`
 * rows: fewer rows, never wrong ones.
 */
export function pickSample(field, env) {
    const source = resolveEnv(env).pickSourceById(field.source);
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

/** A typed example answer for one declared form field. */
export function answerSample(f, env) {
    if (f.type === 'checkbox') return true;
    if (f.type === 'number') return 42;
    if (f.type === 'date') return '2026-01-31';
    if (f.type === 'file') return { kind: 'form_upload', filename: 'attachment.pdf' };
    // A picked record, as the run receives it: the reference the person chose,
    // plus the text that was read from it.
    if (f.type === 'app_pick') return pickSample(f, env);
    if (f.type === 'email') return 'visitor@example.com';
    return f.label || 'answer';
}

/** The declared fields that have a name. */
export function namedFormFields(form) {
    return Array.isArray(form?.fields) ? form.fields.filter(f => f?.name) : [];
}

/** The answers as one sample object, keyed by field name. */
export function answersSample(form, env) {
    return Object.fromEntries(namedFormFields(form).map(f => [f.name, answerSample(f, env)]));
}

export function describeFormPage(node, env) {
    if (node.mode === 'ending') return null;
    const label = node.label || node.form?.title || groupLabel(env, 'form_page', 'Form page');
    return stepGroup(node, label, 'form_page', answersSample(node.form, env));
}
