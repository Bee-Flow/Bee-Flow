/**
 * TEXTUAL lockstep: the routes and answer shapes the forms calls rely on,
 * read out of the server source (routes/automation/{forms,formPublic/*,
 * webhooksAndRunOps}.js, automation/formQueue.js, routes/datatables/*,
 * automation/formAnswers/summary.js). A renamed route or field fails here,
 * not as an `undefined` on somebody's phone.
 *
 * The form routes moved out of crud.js into forms.js (registerFormRoutes),
 * and formPublic.js into one module per concern under formPublic/, each with
 * a register(router); the first test pins that crud.js and formPublic.js
 * still mount them.
 */

import fs from 'node:fs';
import path from 'node:path';

// Read off a SERVER handle with plain path literals, so src/meta/serverClosure.test.ts
// sees every file this test reads and holds ci.yml's mobile filter to them.
const SERVER = path.resolve(__dirname, '../../../../../server');
const readServer = (rel: string): string => fs.readFileSync(path.join(SERVER, rel), 'utf8');

const crud = readServer('routes/automation/crud.js');
const forms = readServer('routes/automation/forms.js');
const formPublicRouter = readServer('routes/automation/formPublic.js');
const FORM_PUBLIC_MODULES = ['page', 'submit', 'session', 'results'];
const formPublic = [
    readServer('routes/automation/formPublic/page.js'),
    readServer('routes/automation/formPublic/submit.js'),
    readServer('routes/automation/formPublic/session.js'),
    readServer('routes/automation/formPublic/results.js'),
].join('\n');
// The accepted-submission 202 is answered by the queue a submission waits in.
const formQueue = readServer('automation/formQueue.js');
const links = readServer('routes/automation/webhooksAndRunOps.js');
const answersRoute = readServer('routes/datatables/answers.js');
const rows = readServer('routes/datatables/rows.js');
// rows.js keeps the route table; its named handlers (H.listRows, …) live here.
const rowHandlers = readServer('routes/datatables/rowHandlers.js');
const summary = readServer('automation/formAnswers/summary.js');
const index = readServer('index.js');

/**
 * The source of one route handler. Inline (`router.get('/x', async (req, res) => {…`):
 * from its registration to the next one. Named (`router.get('/x', limiter, handlerFn);`
 * or `H.handlerFn`): that function's own source, from `src` or from `handlers`
 * when the router keeps its handlers in a sibling module.
 */
function handler(src: string, registration: string, handlers: string = src): string {
    const at = src.indexOf(registration);
    if (at < 0) throw new Error(`${registration} is gone`);
    const lineEnd = src.indexOf('\n', at);
    const named = /,\s*(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\);\s*$/.exec(src.slice(at, lineEnd < 0 ? undefined : lineEnd));
    if (named) {
        src = handlers;
        const start = src.search(new RegExp(`^(?:async )?function ${named[1]}\\(`, 'm'));
        if (start < 0) throw new Error(`${named[1]} (the handler of ${registration}) is gone`);
        const end = src.indexOf('\n}\n', start);
        return src.slice(start, end < 0 ? undefined : end + 2);
    }
    const next = src.slice(at + registration.length).search(/\n\s*router\./);
    return src.slice(at, next < 0 ? undefined : at + registration.length + next);
}

const missing = (src: string, keys: string[]) => keys.filter((k) => !new RegExp(`\\b${k}\\b`).test(src));

it('mounts the routes where the phone calls them', () => {
    expect(index).toContain("app.use('/api/automation'");
    expect(index).toContain("app.use('/api/datatables'");
    expect(crud).toContain("const { registerFormRoutes } = require('./forms');");
    expect(crud).toMatch(/^registerFormRoutes\(router\);$/m);
    for (const route of ["router.get('/forms'", "router.get('/forms/:automationId'", "router.put('/forms/:automationId/audience'", "router.post('/forms/:automationId/answers-table'", "router.post('/forms/ai/draft'"]) {
        expect(forms).toContain(route);
    }
    for (const m of FORM_PUBLIC_MODULES) expect(formPublicRouter).toContain(`require('./formPublic/${m}')`);
    for (const call of ['page.register(router)', 'submit.registerSubmit(router)', 'session.register(router)', 'results.register(router)', 'submit.registerResume(router)']) {
        expect(formPublicRouter).toContain(call);
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
    const detail = handler(forms, "router.get('/forms/:automationId'");
    expect(
        missing(detail, ['id', 'url', 'automationId', 'title', 'description', 'live', 'isActive', 'isDraft', 'submissions', 'mine', 'canOpen', 'audience', 'questions', 'pages', 'answers', 'definition', 'automationTitle', 'collect', 'fields', 'theme', 'submitLabel', 'successMessage']),
    ).toEqual([]);
    const list = handler(forms, "router.get('/forms'");
    expect(missing(list, ['canOpen', 'audience', 'answers'])).toEqual([]);
    expect(missing(forms, ['collecting', 'datatableId', 'grade', 'rowCount', 'linked', 'lastWriteError'])).toEqual([]);
    expect(handler(forms, "router.put('/forms/:automationId/audience'")).toContain('audience: publicAudience(');
});

it('still answers filling a form in with the shapes the phone reads', () => {
    expect(missing(handler(formPublic, "router.get('/form/:token'"), ['form', 'multiPage', 'csrf', 'issuedAt'])).toEqual([]);
    expect(missing(handler(formPublic, "router.post('/form/:token/upload'"), ['fileId', 'filename', 'size', 'mimeType', 'sessionId', 'csrf', 'field'])).toEqual([]);
    expect(missing(handler(formPublic, "router.post('/form/:token/pick'"), ['results', 'error', 'field', 'query', 'sessionId'])).toEqual([]);
    const poll = handler(formPublic, "router.get('/form/:token/s/:sid'");
    for (const state of ['working', 'form', 'done', 'expired', 'error']) expect(poll).toContain(`state: '${state}'`);
    expect(missing(poll, ['progress', 'progressNote', 'stepId', 'ending'])).toEqual([]);
    // A 202 carries the session id; the silent bot answers do not.
    expect(formQueue).toContain('res.status(202).json({ accepted: true, ...extra });');
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
    expect(missing(handler(rows, "router.get('/:id/rows'", rowHandlers), ['rows', 'hasMore', 'nextCursor', 'total'])).toEqual([]);
});
