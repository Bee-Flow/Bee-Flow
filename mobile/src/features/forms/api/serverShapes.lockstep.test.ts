/**
 * TEXTUAL lockstep: the routes and answer shapes the forms calls rely on,
 * read out of the server source (routes/automation/{crud,formPublic,
 * webhooksAndRunOps}.js, routes/datatables/*, automation/formAnswers/
 * summary.js). A renamed route or field fails here, not as an `undefined` on
 * somebody's phone.
 */

import { readServer } from '../testing/sources';

const crud = readServer('routes/automation/crud.js');
const formPublic = readServer('routes/automation/formPublic.js');
const links = readServer('routes/automation/webhooksAndRunOps.js');
const answersRoute = readServer('routes/datatables/answers.js');
const rows = readServer('routes/datatables/rows.js');
const summary = readServer('automation/formAnswers/summary.js');
const index = readServer('index.js');

/** The source of one route handler: from its registration to the next one. */
function handler(src: string, registration: string): string {
    const at = src.indexOf(registration);
    if (at < 0) throw new Error(`${registration} is gone`);
    const next = src.indexOf('\nrouter.', at + registration.length);
    return src.slice(at, next < 0 ? undefined : next);
}

const missing = (src: string, keys: string[]) => keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(src));

it('mounts the routes where the phone calls them', () => {
    expect(index).toContain("app.use('/api/automation'");
    expect(index).toContain("app.use('/api/datatables'");
    for (const route of ["router.get('/forms'", "router.get('/forms/:automationId'", "router.put('/forms/:automationId/audience'", "router.post('/forms/:automationId/answers-table'", "router.post('/forms/ai/draft'"]) {
        expect(crud).toContain(route);
    }
    for (const route of ["router.post('/:id/form'", "router.post('/:id/form/:token/rotate'", "router.delete('/:id/form/:token'"]) expect(links).toContain(route);
    for (const route of [
        "router.get('/form/:token'", "router.post('/form/:token/upload'", "router.post('/form/:token/pick'", "router.post('/form/:token'",
        "router.get('/form/:token/s/:sid'", "router.post('/form/:token/s/:sid'", "router.get('/form/:token/s/:sid/file/:fileId'",
        "router.post('/form/:token/s/:sid/file/:fileId/notebook'", "router.post('/form/:token/s/:sid/notebook'",
    ]) {
        expect(formPublic).toContain(route);
    }
    expect(answersRoute).toContain("'/:id/answers/summary'");
    for (const route of ["'/:id/rows'", "'/:id/rows/:rowId'", "'/:id/rows.csv'"]) expect(rows).toContain(route);
});

it('still builds every field the Form page reads', () => {
    const detail = handler(crud, "router.get('/forms/:automationId'");
    expect(
        missing(detail, ['id', 'url', 'automationId', 'title', 'description', 'live', 'isActive', 'isDraft', 'submissions', 'mine', 'canOpen', 'audience', 'questions', 'pages', 'answers', 'definition', 'automationTitle', 'collect', 'fields', 'theme', 'submitLabel', 'successMessage']),
    ).toEqual([]);
    const list = handler(crud, "router.get('/forms'");
    expect(missing(list, ['canOpen', 'audience', 'answers'])).toEqual([]);
    expect(missing(crud, ['collecting', 'datatableId', 'grade', 'rowCount', 'linked', 'lastWriteError'])).toEqual([]);
    expect(handler(crud, "router.put('/forms/:automationId/audience'")).toContain('audience: publicAudience(');
});

it('still answers filling a form in with the shapes the phone reads', () => {
    expect(missing(handler(formPublic, "router.get('/form/:token'"), ['form', 'multiPage', 'csrf', 'issuedAt'])).toEqual([]);
    expect(missing(handler(formPublic, "router.post('/form/:token/upload'"), ['fileId', 'filename', 'size', 'mimeType', 'sessionId', 'csrf', 'field'])).toEqual([]);
    expect(missing(handler(formPublic, "router.post('/form/:token/pick'"), ['results', 'error', 'field', 'query', 'sessionId'])).toEqual([]);
    const poll = handler(formPublic, "router.get('/form/:token/s/:sid'");
    for (const state of ['working', 'form', 'done', 'expired', 'error']) expect(poll).toContain(`state: '${state}'`);
    expect(missing(poll, ['progress', 'progressNote', 'stepId', 'ending'])).toEqual([]);
    // A 202 carries the session id; the silent bot answers do not.
    expect(formPublic).toContain('res.status(202).json({ accepted: true, ...extra })');
    expect(formPublic).toContain('{ sessionId: session.id }');
    expect(formPublic).toContain("res.status(400).json({ error: 'Some answers need attention', fields: errors })");
    expect(formPublic).toContain('res.json({ notebookId: notebook.id })');
    expect(formPublic).toContain("const HONEYPOT_FIELD = 'website_url'");
    expect(formPublic).toContain('const MIN_FORM_AGE_MS = 2000');
});

it('still answers the dashboard in one shape', () => {
    const fn = summary.slice(summary.indexOf('async function answersSummary'));
    expect(missing(fn, ['table', 'range', 'totals', 'timeline', 'questions', 'recent', 'inRange', 'last7d', 'completed', 'open', 'lastAt', 'retired', 'answered', 'skipped', 'breakdown', 'preview', 'runId', 'submittedAt'])).toEqual([]);
    for (const kind of ['choice', 'yesno', 'number', 'date', 'file', 'text']) expect(fn).toContain(`kind: '${kind}'`);
    expect(missing(handler(rows, "router.get('/:id/rows'"), ['rows', 'hasMore', 'nextCursor', 'total'])).toEqual([]);
});
