'use strict';

/**
 * Keeping a finished journey's result (formPublic/results.js): a generated
 * document into Notebooks, and the closing page's text as a notebook, a
 * Word/PDF file or a webpage.
 *
 * Harness: formPublic.testkit.js (mocks first, then the real router).
 *
 * Run: node --test routes/automation/formPublic/results.test.js
 */
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const {
    FORM,
    state,
    resetState,
    putRun,
    openInNotebooks,
    saveTextToNotebook,
    getExport,
    saveAsWebpage,
    makeRes,
    makeReq,
    startSession,
    putFile,
} = require('./formPublic.testkit');

beforeEach(resetState);

// ── Open in Notebooks ─────────────────────────────────
//
// The closing page's other button. It is the download's twin: same token →
// session → journey-runs → generated-file chain, so everything that makes a
// file unreachable there makes it unreachable here.

test('puts the document IN the notebook, as its content', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    const res = makeRes();
    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.notebookId, 'nb1');
    // Named after the document, without its extension, and owned by the caller
    // — not by the automation's author.
    assert.strictEqual(state.notebooks[0].name, 'offerte');
    assert.strictEqual(state.notebooks[0].userId, 'colleague1');
    // The text is the notebook's own content. It is NOT an attached source:
    // a source is something you ask questions about, and this is the thing the
    // automation just wrote, sent here to be worked on.
    assert.strictEqual(state.notebookWrites.length, 1);
    assert.strictEqual(state.notebookWrites[0].id, 'nb1');
    assert.strictEqual(
        state.notebookWrites[0].documentContent,
        '<p>Eerste alinea.</p><p>Tweede alinea.</p>',
    );
});

test('parses the real bytes, without a round trip through the browser', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    assert.deepStrictEqual(state.parsed, [{ bytes: '%PDF-1.7 fake'.length, mimeType: 'application/pdf', filename: 'offerte.pdf' }]);
});

test('keeps HTML a Word document already carries, rather than escaping it', async () => {
    // mammoth returns real markup for a .docx; re-escaping it would show the
    // visitor their own tags.
    state.parsedText = '<h1>Offerte</h1><p>Beste klant</p>';
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    assert.strictEqual(state.notebookWrites[0].documentContent, '<h1>Offerte</h1><p>Beste klant</p>');
});

test('escapes plain text so a generated document cannot inject markup', async () => {
    // This text came out of a document an automation wrote, which routinely carries
    // model output, and the notebook editor renders what it is given.
    state.parsedText = 'Hallo <script>alert(1)</script>';
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    const html = state.notebookWrites[0].documentContent;
    assert.ok(!html.includes('<script>'), html);
    assert.ok(html.includes('&lt;script&gt;'), html);
});

test('pressing it twice gives two notebooks', async () => {
    // The chosen behaviour: a fresh notebook every time. Writing into an
    // existing one would mean guessing which of the caller's was meant.
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), makeRes());
    assert.strictEqual(state.notebooks.length, 2);
});

test('a file from another journey cannot be opened into your notebook', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('other', 'someone-elses-run');

    const res = makeRes();
    await openInNotebooks(makeReq({ sid, params: { fileId: 'other' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0, 'nothing was created');
});

test('a file whose bytes are already reaped makes no empty notebook', async () => {
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');
    state.storageMissing = true;

    const res = makeRes();
    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0, 'the notebook is made only after the bytes are in hand');
});

test('an unreadable document says so instead of leaving an empty notebook', async () => {
    state.parseThrows = true;
    const sid = await startSession();
    putRun('run1', 'success', { steps: [] });
    state.sessions.get(sid).runId = 'run1';
    putFile('f1', 'run1');

    const res = makeRes();
    await openInNotebooks(makeReq({ sid, params: { fileId: 'f1' } }), res);
    assert.strictEqual(res.statusCode, 422);
    assert.strictEqual(state.notebooks.length, 0);
});

// ── Keeping the closing page's own TEXT (BFSF-419) ───────────────────────
//
// The common case: no generate_document step at all, so the "result" is just
// the ending page's rendered markdown. Notebook, webpage and Word/PDF all read
// that text back from the RUN, never from the request: a visitor keeps what
// their own journey produced, and these routes cannot be pointed at arbitrary
// content.

const BLOG = '## Waterstralen\n\nEen alinea met **nadruk**.\n\n| Klasse | Tolerantie |\n|---|---|\n| Fijn | ±0,15 mm |';

/** A session whose journey finished on a closing page with `ending`. */
async function finishedSession(ending = { title: 'Mijn SEO-blog', description: BLOG }) {
    const sid = await startSession();
    putRun('run1', 'success', {
        steps: [
            { stepId: 'ai1', status: 'success', output: { text: 'concept' } },
            { stepId: 'end', status: 'success', output: { mode: 'ending', form: ending } },
        ],
    });
    state.sessions.get(sid).runId = 'run1';
    return sid;
}

test('saves the closing page\'s text into a new notebook, formatted', async () => {
    const sid = await finishedSession();
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.notebookId, 'nb1');
    // Named after the closing page, and owned by the caller — not by the
    // automation's author.
    assert.strictEqual(state.notebooks[0].name, 'Mijn SEO-blog');
    assert.strictEqual(state.notebooks[0].userId, 'colleague1');
    // The markdown arrives as the structure the visitor saw, not as `##`/`|`.
    assert.strictEqual(state.notebookWrites.length, 1);
    const html = state.notebookWrites[0].documentContent;
    assert.match(html, /<h2>Waterstralen<\/h2>/);
    assert.match(html, /<strong>nadruk<\/strong>/);
    assert.match(html, /<table>/);
    assert.ok(!html.includes('##'), html);
});

test('the notebook gets the RUN\'s text, whatever the request body says', async () => {
    // The page used to send the text along. Whatever it sends now is ignored.
    const sid = await finishedSession();
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, body: { text: '<p>iets heel anders</p>', title: 'Verzonnen' } }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.notebooks[0].name, 'Mijn SEO-blog');
    assert.ok(!state.notebookWrites[0].documentContent.includes('iets heel anders'));
});

test('falls back to the form\'s own title when the closing page has none', async () => {
    const sid = await finishedSession({ description: 'Hallo daar.' });
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid }), res);
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(state.notebooks[0].name, 'Contact us');
});

test('markup in a generated result is shown as text, not injected', async () => {
    const sid = await finishedSession({ title: 'X', description: 'Hallo <script>alert(1)</script>' });
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid }), res);
    assert.strictEqual(res.statusCode, 200);
    const html = state.notebookWrites[0].documentContent;
    assert.ok(!html.includes('<script>'), html);
    assert.ok(html.includes('&lt;script&gt;'), html);
});

test('a journey that has not finished has nothing to save yet', async () => {
    const sid = await startSession();
    putRun('run1', 'running', { steps: [] });
    state.sessions.get(sid).runId = 'run1';

    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0);
});

test('a closing page without text makes no blank notebook', async () => {
    const sid = await finishedSession({ title: 'Bedankt!', description: '  ' });
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0);
});

test('an unknown or foreign session id is a 404 — the same answer everywhere else in this file', async () => {
    // Never created by startSession(): this is what holding someone ELSE's
    // (or a made-up) session id looks like from here.
    await finishedSession();
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid: 'f'.repeat(48) }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0, 'nothing was created');
});

test('an expired session is rejected the same way', async () => {
    const sid = await finishedSession();
    state.sessions.get(sid).expiresAt = new Date(Date.now() - 1000).toISOString();

    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0);
});

test('a session from a DIFFERENT automation is refused, even with a shape-valid id', async () => {
    // getFormSession only matches rows whose formPageId is THIS token, but the
    // route also cross-checks automationId directly — belt and braces against
    // a page ever being re-pointed at another automation.
    const sid = await finishedSession();
    state.sessions.get(sid).automationId = 'someone-elses-automation';

    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.notebooks.length, 0);
});

test('an unauthenticated caller is refused before anything is read or written', async () => {
    const sid = await finishedSession();
    const res = makeRes();
    await saveTextToNotebook(makeReq({ sid, session: null }), res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(state.notebooks.length, 0);
});

// ── …as a Word or PDF download ──

for (const format of ['docx', 'pdf']) {
    test(`downloads the result as ${format}`, async () => {
        const sid = await finishedSession();
        const res = makeRes();
        await getExport(makeReq({ sid, params: { format } }), res);
        await new Promise(r => res.on('finish', r));

        assert.strictEqual(res.statusCode, 200);
        assert.strictEqual(res.bytes().toString(), `rendered ${format}`);
        assert.match(res.headers['content-disposition'], new RegExp(`^attachment; filename="mijn-seo-blog\\.${format}"`));
        assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
        // The run's markdown, rendered as markdown, under the page's title.
        assert.strictEqual(state.renders.length, 1);
        assert.strictEqual(state.renders[0].content, BLOG);
        assert.strictEqual(state.renders[0].contentFormat, 'markdown');
        assert.strictEqual(state.renders[0].title, 'Mijn SEO-blog');
        assert.strictEqual(state.renders[0].format, format);
    });
}

test('an unknown format renders nothing', async () => {
    const sid = await finishedSession();
    const res = makeRes();
    await getExport(makeReq({ sid, params: { format: 'html' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.renders.length, 0);
});

test('a download from someone else\'s session renders nothing', async () => {
    await finishedSession();
    const res = makeRes();
    await getExport(makeReq({ sid: 'f'.repeat(48), params: { format: 'pdf' } }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.renders.length, 0);
});

test('an automation without an AI step exports unmarked', async () => {
    const sid = await finishedSession();
    const res = makeRes();
    await getExport(makeReq({ sid, params: { format: 'pdf' } }), res);
    assert.strictEqual(state.markingAsks.length, 0);
    assert.strictEqual(state.renders[0].marking, null);
});

test('an automation with an AI step asks the organisation\'s marking policy (Art. 50(2))', async () => {
    state.definitionOverride = {
        trigger: { id: 'trg', type: 'trigger', kind: 'form', form: FORM },
        steps: [{ id: 'ai1', type: 'ai_step', model: 'anthropic/claude-x' }],
    };
    const sid = await finishedSession();
    const res = makeRes();
    await getExport(makeReq({ sid, params: { format: 'docx' } }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(state.markingAsks, [{ orgId: 'org1', info: { automationId: 'auto1', aiStepIds: ['ai1'], provider: 'anthropic' } }]);
    assert.deepStrictEqual(state.renders[0].marking, { enabled: true, org: 'Org' });
});

// ── …as a new webpage ──

test('saves the result as a new webpage: a complete page plus its stylesheet', async () => {
    const sid = await finishedSession();
    const res = makeRes();
    await saveAsWebpage(makeReq({ sid }), res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.webpageId, 'wp1');
    assert.strictEqual(state.webpages[0].userId, 'colleague1');
    assert.strictEqual(state.webpages[0].name, 'Mijn SEO-blog');
    assert.deepStrictEqual(state.webpages[0].settings, { framework: 'vanilla', runtime: 'light' });

    const slots = Object.fromEntries(state.webpageSlots.map(s => [s.slot, s.content]));
    assert.deepStrictEqual(Object.keys(slots).sort(), ['css', 'html']);
    assert.match(slots.html, /<link rel="stylesheet" href="style.css">/);
    assert.match(slots.html, /<h1>Mijn SEO-blog<\/h1>/);
    assert.match(slots.html, /<h2>Waterstralen<\/h2>/);
    // The editor reads a page's sizes off the row; without them it looks empty.
    assert.strictEqual(state.webpageMeta[0].htmlSha, 'sha-html');
    assert.strictEqual(state.webpageMeta[0].htmlSize, slots.html.length);
    assert.strictEqual(state.webpageMeta[0].cssSize, slots.css.length);
});

test('no file storage: refused before an empty webpage is made', async () => {
    const sid = await finishedSession();
    state.storageAvailable = false;
    await assert.rejects(saveAsWebpage(makeReq({ sid }), makeRes()),
        (err) => err.status === 503 && err.code === 'storage_unavailable');
    assert.strictEqual(state.webpages.length, 0);
});

test('a webpage needs a signed-in caller and a finished journey of their own', async () => {
    const sid = await finishedSession();
    let res = makeRes();
    await saveAsWebpage(makeReq({ sid, session: null }), res);
    assert.strictEqual(res.statusCode, 401);

    res = makeRes();
    await saveAsWebpage(makeReq({ sid: 'f'.repeat(48) }), res);
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(state.webpages.length, 0);
});
