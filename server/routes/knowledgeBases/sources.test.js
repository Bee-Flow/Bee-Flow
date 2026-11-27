/**
 * The KB source API (K1): who may touch it, what it hands back, and the two
 * things it must never do — leak a document body into a list, or let a client
 * create a kind the product cannot yet refresh.
 *
 * Same harness as routes/knowledgeBases.ssrf.test.js: the sub-routers' own
 * dependencies are replaced with recording doubles through
 * Module._resolveFilename, and the request goes through the REAL facade
 * (routes/knowledgeBases.js), so the mount order is under test too.
 *
 * The harness is sources.testkit.js; the web-page kind (the webpages module's) is
 * sources.webpages.test.js.
 *
 * Run: cd server && node --test --test-force-exit routes/knowledgeBases/sources.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { fx, resetFx, doc, source, sourcesRouter, dispatch } = require('./sources.testkit');

// ═══ Reads ══════════════════════════════════════════════════════════

test('GET /:id/sources returns camelCase sources with per-source counters and totals', async () => {
    resetFx();
    fx.sources = [
        source({ id: 's1', kind: 'upload', name: 'Uploaded files' }),
        source({ id: 's2', kind: 'webpage', name: 'example.com', config: { url: 'https://example.com', crawl: { maxPages: 3 } }, refreshMode: 'schedule', refreshCron: '0 7 * * *', status: 'error', lastRefreshError: 'HTTP 500' }),
    ];
    fx.counts = {
        s1: { documentCount: 38, processedCount: 36, redactedCount: 0, skippedCount: 1, errorCount: 1, duplicateCount: 0, piiFoundCount: 2, totalChunks: 120 },
    };

    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.sources.length, 2);

    const upload = res.body.sources[0];
    assert.strictEqual(upload.documentCount, 38);
    assert.strictEqual(upload.processedCount, 36);
    assert.strictEqual(upload.totalChunks, 120);
    assert.deepStrictEqual(upload.createdBy, { id: 'u1', name: 'Tom' });
    assert.strictEqual(upload.refreshLabelKey, 'knowledge.sources.refresh.manual');

    const web = res.body.sources[1];
    assert.strictEqual(web.status, 'error');
    assert.strictEqual(web.error, 'HTTP 500');
    assert.strictEqual(web.refreshLabelKey, 'knowledge.sources.refresh.schedule');
    // A source with no documents yet reads as zeroes, never undefined.
    assert.strictEqual(web.documentCount, 0);

    assert.strictEqual(res.body.totals.sourceCount, 2);
    assert.strictEqual(res.body.totals.autoRefreshCount, 1);
    assert.strictEqual(res.body.totals.errorSourceCount, 1);
    assert.strictEqual(res.body.totals.documentCount, 38);
});

test('the public config is an allow-list: a text source never ships its text', async () => {
    resetFx();
    fx.sources = [source({ id: 's9', kind: 'text', name: 'Opening hours', config: { title: 'Opening hours', charCount: 42, text: 'SECRET BODY', internalNote: 'nope' } })];

    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    const cfg = res.body.sources[0].config;
    assert.deepStrictEqual(cfg, { title: 'Opening hours', charCount: 42 });
    assert.ok(!JSON.stringify(res.body).includes('SECRET BODY'));
    assert.ok(!JSON.stringify(res.body).includes('internalNote'));
});

test('reading needs the read grade; a base the caller may not read and an unknown KB answer the same 404', async () => {
    resetFx();
    fx.canAccess = false;
    const denied = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(denied.statusCode, 404);

    resetFx();
    const missing = await dispatch({ method: 'GET', url: '/nope/sources' });
    assert.strictEqual(missing.statusCode, 404);
    assert.strictEqual(missing.body.code, 'kb_not_found');
});

test('GET /:id/sources/:sid/documents is projected and passes the filters through', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    fx.documents = [doc({ id: 'd1', source_id: 's1' }), doc({ id: 'd2', source_id: 'other' })];

    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents?status=error&pii=found&q=hand&limit=5&offset=10' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.documents.length, 1);
    assert.strictEqual(res.body.limit, 5);
    assert.strictEqual(res.body.offset, 10);

    const call = fx.listCalls.at(-1);
    assert.strictEqual(call.limit, 5);
    assert.strictEqual(call.offset, 10);
    assert.deepStrictEqual(call.filters, { sourceId: 's1', status: 'error', pii: 'found', q: 'hand' });
    // The projection is the store's; what matters here is that nothing in the
    // response carries a body.
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body.documents[0], 'original_content'));
});

test('a document of another source is a 404 on this source', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' }), source({ id: 's2' })];
    fx.documents = [doc({ id: 'd1', source_id: 's2' })];

    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents/d1' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.code, 'document_not_found');

    const ok = await dispatch({ method: 'GET', url: '/kb1/sources/s2/documents/d1' });
    assert.strictEqual(ok.statusCode, 200);
    assert.strictEqual(ok.body.document.id, 'd1');
});

test('a source id from another KB is never resolved', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', knowledgeBaseId: 'other-kb' })];
    const res = await dispatch({ method: 'GET', url: '/kb1/sources/s1/documents' });
    assert.strictEqual(res.statusCode, 404);
    assert.strictEqual(res.body.code, 'source_not_found');
});

// ═══ Writes: the authz matrix ═══════════════════════════════════════

test('writing needs canManageKB', async () => {
    resetFx();
    fx.canManage = false;
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload' } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(fx.sources.length, 0);
});

test('a system-managed KB is read-only even for someone who may manage it', async () => {
    resetFx();
    fx.isSystem = true;
    fx.canManage = true;

    const create = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload' } });
    assert.strictEqual(create.statusCode, 403);
    assert.match(create.body.error, /read-only/i);

    fx.sources = [source({ id: 's1' })];
    const del = await dispatch({ method: 'DELETE', url: '/kb1/sources/s1' });
    assert.strictEqual(del.statusCode, 403);
    assert.strictEqual(fx.removed.length, 0);

    const patch = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: 'x' } });
    assert.strictEqual(patch.statusCode, 403);

    const refresh = await dispatch({ method: 'POST', url: '/kb1/sources/s1/refresh' });
    assert.strictEqual(refresh.statusCode, 403);
    assert.strictEqual(fx.refreshed.length, 0);

    // Reading a system KB stays allowed.
    const read = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.strictEqual(read.statusCode, 200);
});

// ═══ Writes: creating ═══════════════════════════════════════════════

test('a kind whose engine has not landed yet is refused with kind_not_available', async () => {
    // `meeting_tag` left this list in K7 and `datatable` in K8, when their
    // adapters landed. Still ahead: nextcloud_folder (reserved; the cloud_folder kind covers Nextcloud), K10 (automation).
    resetFx();
    for (const kind of ['nextcloud_folder', 'automation', 'legacy']) {
        const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind } });
        assert.strictEqual(res.statusCode, 400, kind);
        assert.strictEqual(res.body.code, 'kind_not_available', kind);
        assert.deepStrictEqual(res.body.availableKinds, ['text', 'upload', 'webpage', 'meeting_tag', 'datatable', 'cloud_folder']);
    }
    const unknown = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'telepathy' } });
    assert.strictEqual(unknown.statusCode, 400);
    assert.strictEqual(unknown.body.code, 'kind_not_available');
    assert.strictEqual(fx.sources.length, 0);
});

test('POST kind=text creates the source and ingests the snippet onto it', async () => {
    resetFx();
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', name: 'Opening hours', config: { text: 'We open at nine.' } },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.source.kind, 'text');
    assert.strictEqual(res.body.source.name, 'Opening hours');
    assert.strictEqual(res.body.source.config.charCount, 'We open at nine.'.length);

    const ingest = fx.ingested.at(-1);
    assert.strictEqual(ingest.opts.sourceId, res.body.source.id, 'the document hangs off the new source');
    assert.strictEqual(ingest.opts.createdBy, 'u1');
    assert.strictEqual(ingest.opts.onFailure, 'record', 'a failed snippet leaves a row, not nothing');
});

/**
 * ── WHERE A TEXT SNIPPET CAME FROM (M4) ─────────────────────────────
 * The transcript tab files one line of a meeting as a text source, and the
 * meeting has to find those again afterwards. Two facts make that possible,
 * and they are ALLOW-LISTED rather than copied through: this object is written
 * by a client and read back on another screen, so a spread would carry
 * whatever a caller invents into a knowledge base a whole organisation can
 * query.
 */
test('POST kind=text records which transcript line it came from', async () => {
    resetFx();
    fx.visibleTranscriptions = ['t-1'];   // a meeting this writer may open
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: {
            kind: 'text', name: 'Regel 12', config: {
                text: 'We gaan met leverancier B verder.',
                metadata: { transcriptionId: 't-1', segmentIndex: 12 },
            },
        },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(res.body.source.config.metadata, { transcriptionId: 't-1', segmentIndex: 12 });
});

test('POST kind=text keeps ONLY the two allow-listed origin fields', async () => {
    resetFx();
    fx.visibleTranscriptions = ['t-1'];
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: {
            kind: 'text', name: 'Regel 12', config: {
                text: 'We gaan met leverancier B verder.',
                metadata: {
                    transcriptionId: 't-1', segmentIndex: 12,
                    // What a spread would have carried into the base with it.
                    speakerName: 'Sandra de Vries', email: 'sandra@example.com', ownerId: 'u-other',
                },
            },
        },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(Object.keys(res.body.source.config.metadata).sort(), ['segmentIndex', 'transcriptionId']);
});

test('POST kind=text stores NO origin at all when it is not a usable pair', async () => {
    // Unknown narrows: a half-filled origin (a transcription with no line, a
    // line index that is not a line) would make "this line is already filed"
    // true for every line of that meeting.
    for (const metadata of [undefined, null, 't-1', ['t-1'], {}, { segmentIndex: 3 }, { transcriptionId: '  ' }]) {
        resetFx();
        fx.visibleTranscriptions = ['t-1'];
        const res = await dispatch({
            method: 'POST', url: '/kb1/sources',
            body: { kind: 'text', config: { text: 'Een regel uit de meeting.', metadata } },
        });
        assert.strictEqual(res.statusCode, 201);
        assert.strictEqual(res.body.source.config.metadata, undefined, `metadata ${JSON.stringify(metadata)} must not be stored`);
    }
    // A transcription id with an unusable line number keeps the id and drops
    // the line — the meeting is still findable, no line is falsely claimed.
    for (const bad of [null, true, -1, 1.5, 'twaalf', {}]) {
        resetFx();
        fx.visibleTranscriptions = ['t-1'];
        const res = await dispatch({
            method: 'POST', url: '/kb1/sources',
            body: { kind: 'text', config: { text: 'Een regel uit de meeting.', metadata: { transcriptionId: 't-1', segmentIndex: bad } } },
        });
        assert.deepStrictEqual(res.body.source.config.metadata, { transcriptionId: 't-1' });
    }
});

/**
 * ── THE ID IS AN ASSERTION ABOUT SOMEONE ELSE'S MEETING (M4) ────────
 * `metadata.transcriptionId` makes a line land on the timeline of a meeting: the bar under the tag row, the Used-by tab and "Taken from this
 * transcript" all read it back, and the delete gate of that meeting counts it. On your OWN knowledge base you are always admin, so without this
 * check anyone could INVENT an id and paste an untrue, unrefutable line onto somebody else's meeting — which then could only be removed from their
 * own note through the confirmed escape hatch.
 *
 * The same guard as the meeting_tag branch above, and for the same reason:
 * it runs as the MAKER, and unknown narrows.
 */
test('POST kind=text refuses a transcript id the creator cannot see', async () => {
    resetFx();
    fx.visibleTranscriptions = [];        // not from this writer
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: {
            kind: 'text', name: 'Regel 12', config: {
                text: 'Een regel uit de vergadering van iemand anders.',
                metadata: { transcriptionId: 't-van-iemand-anders', segmentIndex: 3 },
            },
        },
    });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'transcription_not_visible');
    // En er landt NIETS: geen bron, geen document, geen ingest.
    assert.strictEqual(fx.sources.length, 0, 'no source may be created');
    assert.deepStrictEqual(fx.ingested, [], 'and nothing may be ingested');
});

test('"no such meeting" and "not yours to see" answer the same', async () => {
    // Otherwise the route is an existence oracle: the difference between the two
    // answers would reveal which meeting ids exist.
    resetFx();
    fx.visibleTranscriptions = ['t-mine'];
    const missing = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 'bestaat-niet', segmentIndex: 1 } } },
    });
    const hidden = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-van-een-ander', segmentIndex: 1 } } },
    });
    assert.strictEqual(missing.statusCode, hidden.statusCode);
    assert.deepStrictEqual(missing.body, hidden.body);
});

test('the transcript probe runs as the CREATOR, not as the knowledge base owner', async () => {
    resetFx();
    fx.visibleTranscriptions = ['t-1'];
    await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-1', segmentIndex: 4 } } },
    });
    assert.strictEqual(fx.transcriptProbes.length, 1);
    assert.strictEqual(fx.transcriptProbes[0].reader, 'u1', 'the person pressing the button, not kb.tenant_id');
    assert.strictEqual(fx.transcriptProbes[0].id, 't-1');
});

/**
 * ── WHO PROBES IS HALF; WITH WHAT IS THE OTHER HALF ──────────────────
 * The tests above pin `reader` and `id` and are silent about the THIRD
 * parameter — and that is precisely what determines whether the check means anything. The real
 * store does `if (ctx.isSuperAdmin) return true;`, so one flag in there and the
 * gate stands wide open without a single assertion changing. And too narrow a scope (a misspelled field name) makes every org-published
 * meeting unfileable. Both mutations stayed green; that is why these two.
 */
test('de probe draagt de SCOPE van de schrijver — en nooit isSuperAdmin', async () => {
    resetFx();
    fx.visibleTranscriptions = ['t-1'];
    await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-1', segmentIndex: 4 } } },
    });
    const { ctx } = fx.transcriptProbes[0];
    assert.ok(ctx && typeof ctx === 'object', 'er gaat een context mee');
    // The flag that would turn this check into a pass-through must not be in here —
    // not even as `false`, because then the question would have been answered here instead of by the read rules of the meeting.
    assert.strictEqual('isSuperAdmin' in ctx, false, 'de poort geeft zichzelf geen super-admin-doorgang');
    // And the scope that IS in there is that of the writer: his direct org
    // and the orgs that follow from his groups — the same resolution as the read path with which he opened that meeting in the first place.
    assert.deepStrictEqual([...ctx.orgIds].sort(), ['org-via-groep', 'org1']);
    assert.deepStrictEqual(ctx.userGroupIds, ['g-sales']);
});

test('een schrijver zonder org krijgt ook geen org-scope mee', async () => {
    resetFx();
    fx.users.u3 = { id: 'u3', organizationId: '', groups: [] };
    fx.visibleTranscriptions = ['t-1'];
    await dispatch({
        method: 'POST', url: '/kb1/sources', session: { user: { id: 'u3' } },
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-1', segmentIndex: 4 } } },
    });
    const { ctx, reader } = fx.transcriptProbes[0];
    assert.strictEqual(reader, 'u3');
    assert.deepStrictEqual([...ctx.orgIds], [], 'geen org betekent geen org-clausule, niet "alle orgs"');
});

test('a probe that fails refuses, rather than filing a line it could not check', async () => {
    resetFx();
    fx.transcriptProbeFails = true;
    const res = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'text', config: { text: 'Een regel.', metadata: { transcriptionId: 't-1', segmentIndex: 4 } } },
    });
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(fx.sources.length, 0);
    assert.deepStrictEqual(fx.ingested, []);
});

test('a snippet with no origin is not probed for at all', async () => {
    // Een gewone geplakte tekst beweert niets over een vergadering, dus er valt
    // niets te controleren — en een controle die er toch was, zou van elke
    // tekstbron een vergaderingslookup maken.
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'text', config: { text: 'Openingstijden: 9-17.' } } });
    assert.strictEqual(res.statusCode, 201);
    assert.deepStrictEqual(fx.transcriptProbes, []);
});

test('POST kind=text refuses an empty snippet', async () => {
    resetFx();
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'text', config: { text: ' ' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some(d => d.path === 'body.config.text'), 'the 400 names the field');
    assert.strictEqual(fx.sources.length, 0);
});

test('max_kb_sources is enforced against the live count, and -1 is uncapped', async () => {
    resetFx();
    fx.maxSources = 2;
    fx.sources = [source({ id: 's1' }), source({ id: 's2', kind: 'text' })];

    const blocked = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload' } });
    assert.strictEqual(blocked.statusCode, 403);
    assert.strictEqual(blocked.body.code, 'source_limit_reached');
    assert.strictEqual(blocked.body.limit, 2);
    assert.strictEqual(fx.sources.length, 2, 'nothing was created');

    fx.maxSources = -1;
    const allowed = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'upload' } });
    assert.strictEqual(allowed.statusCode, 201);
    assert.strictEqual(fx.sources.length, 3);
});

// ═══ Uploads ════════════════════════════════════════════════════════

function file(name, mimetype = 'application/pdf', size = 1024) {
    return { originalname: name, mimetype, size, buffer: Buffer.from(`bytes of ${name}`) };
}

test('POST /files answers 202 with real document ids, then processes detached', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];

    const res = await dispatch({
        method: 'POST', url: '/kb1/sources/s1/files',
        files: [file('Handbook.pdf'), file('Prices.xlsx', 'application/vnd.ms-excel')],
    });

    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.accepted, 2);
    assert.deepStrictEqual(res.body.documents.map(d => d.name), ['Handbook.pdf', 'Prices.xlsx']);
    assert.ok(res.body.documents.every(d => d.status === 'processing'));
    assert.ok(res.body.documents.every(d => typeof d.id === 'string' && d.id.length > 0));
    // The ids are real rows, which is what lets the UI follow them.
    for (const d of res.body.documents) {
        assert.ok(fx.documents.some(row => row.id === d.id), `${d.name} exists as a row before processing`);
    }

    await sourcesRouter.settleUploads();
    assert.strictEqual(fx.reingested.length, 2, 'both files were processed after the response');
    assert.strictEqual(fx.reingested[0].opts.pageCount, 3);
    assert.strictEqual(fx.reingested[0].opts.onFailure, 'record');
    assert.ok(fx.documents.every(d => d.status === 'processed'));
});

test('a file that cannot be extracted leaves an error ROW, never a silent gap', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];

    const res = await dispatch({ method: 'POST', url: '/kb1/sources/s1/files', files: [file('broken.pdf')] });
    assert.strictEqual(res.statusCode, 202);
    await sourcesRouter.settleUploads();

    const update = fx.statusUpdates.at(-1);
    assert.strictEqual(update.status, 'error');
    assert.match(update.statusReason, /extract/i);
    assert.strictEqual(fx.reingested.length, 0);
    assert.strictEqual(fx.documents.length, 1, 'the row survives so the file is visible with a reason');
});

test('the same file twice becomes a duplicate row, not a second embedding', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];
    // An existing processed row with the hash the extractor will produce.
    fx.documents = [doc({ id: 'canonical', source_id: 's1', content_hash: `hash:${'content of Handbook.pdf'.length}` })];

    await dispatch({ method: 'POST', url: '/kb1/sources/s1/files', files: [file('Handbook.pdf')] });
    await sourcesRouter.settleUploads();

    const update = fx.statusUpdates.at(-1);
    assert.strictEqual(update.status, 'duplicate');
    assert.strictEqual(fx.reingested.length, 0, 'a duplicate is never embedded again');
});

test('files may only be added to an upload source', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', config: { url: 'https://example.com' } })];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources/s1/files', files: [file('x.pdf')] });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'not_an_upload_source');
});

test('a POST with no files is a 400, not an empty 202', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources/s1/files', files: [] });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'no_files');
});

// ═══ Patch / delete / refresh ═══════════════════════════════════════

test('PATCH renames and refuses a refresh mode the kind cannot do', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'upload' })];

    const renamed = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: '  Contracts  ' } });
    assert.strictEqual(renamed.statusCode, 200);
    assert.strictEqual(fx.updated.at(-1).patch.name, 'Contracts');

    const refused = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'live' } } });
    assert.strictEqual(refused.statusCode, 400);
    assert.strictEqual(refused.body.code, 'refresh_mode_not_available');
});

test('PATCH accepts a schedule on a webpage source and validates cron and tz', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', config: { url: 'https://example.com' } })];

    const ok = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'schedule', cron: '0 7 * * *', tz: 'Europe/Amsterdam' } } });
    assert.strictEqual(ok.statusCode, 200);
    const patched = fx.updated.at(-1).patch;
    assert.strictEqual(patched.refreshMode, 'schedule');
    assert.strictEqual(patched.refreshCron, '0 7 * * *');
    assert.strictEqual(patched.refreshTz, 'Europe/Amsterdam');
    // Saving a schedule must ARM it. `next_refresh_at` is the only thing the
    // refresh tick looks at, so a good cron with a null next-run is a source
    // that silently never refreshes while its schedule is on screen.
    assert.ok(patched.nextRefreshAt, 'a saved schedule must be armed');
    assert.ok(Date.parse(patched.nextRefreshAt) > Date.now(), 'and armed in the future');

    const badCron = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'schedule', cron: 'daily' } } });
    assert.strictEqual(badCron.statusCode, 400);
    assert.ok(badCron.body.details.some(d => d.path === 'body.refresh.cron'));

    const badTz = await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { tz: 'Mars/Olympus' } } });
    assert.strictEqual(badTz.statusCode, 400);
    assert.strictEqual(badTz.body.error, 'Unknown time zone: Mars/Olympus');
});

test('editing the cron of an already-scheduled source re-arms it from the NEW cron', async () => {
    // Computed from the row as it will be AFTER the patch. Arming the old
    // cron would leave the source firing on a schedule nobody can see.
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 7 * * *', refreshTz: 'UTC' })];
    await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { cron: '30 23 * * *' } } });
    const patch = fx.updated.at(-1).patch;
    assert.strictEqual(patch.refreshCron, '30 23 * * *');
    assert.strictEqual(new Date(patch.nextRefreshAt).getUTCHours(), 23);
    assert.strictEqual(new Date(patch.nextRefreshAt).getUTCMinutes(), 30);
});

test('renaming a scheduled source does not touch its schedule', async () => {
    // Re-arming on every unrelated save would walk the next run forward each
    // time somebody edited the name.
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 7 * * *' })];
    await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { name: 'Terms page' } });
    const patch = fx.updated.at(-1).patch;
    assert.strictEqual(patch.name, 'Terms page');
    assert.strictEqual(patch.nextRefreshAt, undefined, 'the schedule was not touched');
});

test('switching back to manual clears the schedule so no stale cron survives', async () => {
    resetFx();
    fx.sources = [source({ id: 's1', kind: 'webpage', refreshMode: 'schedule', refreshCron: '0 7 * * *' })];
    await dispatch({ method: 'PATCH', url: '/kb1/sources/s1', body: { refresh: { mode: 'manual' } } });
    const patch = fx.updated.at(-1).patch;
    assert.strictEqual(patch.refreshMode, 'manual');
    assert.strictEqual(patch.refreshCron, null);
    assert.strictEqual(patch.nextRefreshAt, null);
});

test('DELETE removes every document\'s chunks before the source row, without snapshotting', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    fx.documents = [doc({ id: 'd1', source_id: 's1' }), doc({ id: 'd2', source_id: 's1' }), doc({ id: 'd3', source_id: 'other' })];

    const res = await dispatch({ method: 'DELETE', url: '/kb1/sources/s1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deletedDocuments, 2);
    assert.deepStrictEqual(fx.chunkDeletes.map(c => c.docId), ['d1', 'd2']);
    assert.ok(fx.chunkDeletes.every(c => c.opts.skipSnapshot === true),
        'a source-driven removal must not copy the row into kb_document_versions');
    assert.deepStrictEqual(fx.removed, ['s1']);
    assert.deepStrictEqual(fx.documents.map(d => d.id), ['d3'], "another source's documents are untouched");
});

test('DELETE keeps the source row when a document refuses to be purged', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    fx.documents = [doc({ id: 'd1', source_id: 's1' }), doc({ id: 'd2', source_id: 's1' })];
    fx.chunkDeleteFails.add('d2');

    const res = await dispatch({ method: 'DELETE', url: '/kb1/sources/s1' });
    // The FK on documents.source_id cascades; if the source row nevertheless
    // disappeared, d2's row would be gone and its embeddings would remain searchable forever.
    assert.strictEqual(res.statusCode, 409);
    assert.strictEqual(res.body.code, 'purge_incomplete');
    assert.strictEqual(res.body.deletedDocuments, 1);
    assert.deepStrictEqual(fx.removed, [], 'de bron blijft staan');
    assert.ok(fx.documents.some(d => d.id === 'd2'), 'het document dat niet weg wilde staat er nog');
    // One row per document, even if it was tried over several rounds.
    assert.deepStrictEqual(res.body.errors.map(e => e.documentId), ['d2']);
});

test('DELETE pages past the first page of documents', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    // One more than one page (PAGE = 200): without a round loop, exactly
    // one document is left behind, without anything going wrong that could be reported.
    fx.documents = Array.from({ length: 201 }, (_, i) => doc({ id: `p${i}`, source_id: 's1' }));

    const res = await dispatch({ method: 'DELETE', url: '/kb1/sources/s1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.deletedDocuments, 201);
    assert.deepStrictEqual(fx.documents, []);
    assert.deepStrictEqual(fx.removed, ['s1']);
});

test('POST /refresh only queues — K3 does the work', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources/s1/refresh' });
    assert.strictEqual(res.statusCode, 202);
    assert.strictEqual(res.body.queued, true);
    assert.deepStrictEqual(fx.refreshed, ['s1']);
    assert.strictEqual(res.body.source.nextRefreshAt, '2026-09-04T12:00:00.000Z');
});

// ═══ Mount order ════════════════════════════════════════════════════

test('the sources router is mounted before detail, so /:id never swallows /:id/sources', async () => {
    resetFx();
    fx.sources = [source({ id: 's1' })];
    const res = await dispatch({ method: 'GET', url: '/kb1/sources' });
    assert.ok(Array.isArray(res.body.sources), 'the sources handler answered, not GET /:id');
    assert.ok(!Object.prototype.hasOwnProperty.call(res.body, 'documents'));
});

// ── meeting_tag (K7) ────────────────────────────────────────────────

/**
 * A meeting-tag source WIDENS who can read a meeting summary: the note's own
 * audience is replaced by the knowledge base's, which may be larger. The
 * adapter holds one half of that line (it enumerates as the KB's owner,
 * through the store's read ACL); this route holds the other.
 */
test('creating a meeting source requires the creator to see the tag themselves', async () => {
    // Without this, somebody with manage_knowledge could point a knowledge
    // base at a tag they have never been able to read and have the OWNER's
    // reach fill it in for them. The tag would still be filtered by the
    // owner's ACL — but the choice of which meetings to expose would have been
    // made by somebody who cannot see them.
    resetFx();
    fx.taggedMeetings = [];   // nothing this person can open carries it
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'directie' } } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.code, 'tag_not_visible');
    assert.strictEqual(fx.sources.length, 0);
});

test('the probe runs as the CREATOR, not as the knowledge base owner', async () => {
    resetFx();
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales' } } });
    assert.strictEqual(fx.tagProbes[0].reader, 'u1', 'the person pressing the button');
    assert.strictEqual(fx.tagProbes[0].tag, 'sales');
});

test('"no such tag" and "not yours to see" answer the same', async () => {
    // Telling them apart would let somebody probe for which tags exist in the
    // organisation.
    resetFx();
    fx.taggedMeetings = [];
    const missing = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'does-not-exist' } } });
    const hidden = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'directie' } } });
    assert.deepStrictEqual(missing.body, hidden.body);
});

test('a visible tag creates the source, defaulting to summary and decisions', async () => {
    resetFx();
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales' } } });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(res.body.source.kind, 'meeting_tag');
    assert.match(res.body.source.name, /sales/);
    // The STORED config, not the API projection: `mapSourceForApi` reshapes a
    // source for the row UI, and what the adapter reads later is this.
    const stored = fx.created.at(-1).source;
    assert.deepStrictEqual(stored.config, { tag: 'sales', fields: ['summary', 'decisions'] });
});

test('the fields asked for are kept, and a field this source has no answer for is refused', async () => {
    resetFx();
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    const kept = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'meeting_tag', config: { tag: 'sales', fields: ['summary', 'questions'] } },
    });
    assert.strictEqual(kept.statusCode, 201);
    assert.deepStrictEqual(fx.created.at(-1).source.config.fields, ['summary', 'questions']);

    // Dropping it silently was how somebody asked for the transcript, was
    // answered 201, and then found a source that does not carry one.
    resetFx();
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    const refused = await dispatch({
        method: 'POST', url: '/kb1/sources',
        body: { kind: 'meeting_tag', config: { tag: 'sales', fields: ['summary', 'transcript'] } },
    });
    assert.strictEqual(refused.statusCode, 400);
    assert.ok(refused.body.details.some(d => d.path === 'body.config.fields.1'), 'the 400 names which entry');
    assert.strictEqual(fx.sources.length, 0);
});

test('a tag is required', async () => {
    resetFx();
    for (const config of [{}, { tag: '   ' }, { tag: 5 }]) {
        const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config } });
        assert.strictEqual(res.statusCode, 400, JSON.stringify(config));
        assert.strictEqual(res.body.error, 'A meeting source needs a tag.', JSON.stringify(config));
        assert.ok(res.body.details.some(d => d.path === 'body.config.tag'), JSON.stringify(config));
    }
    assert.deepStrictEqual(fx.tagProbes, [], 'and nothing is probed for');
});

test('a probe that fails refuses, rather than creating a source it could not check', async () => {
    resetFx();
    fx.tagProbeFails = true;
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales' } } });
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(fx.sources.length, 0);
});

test('someone who may only READ the knowledge base cannot point it at meetings', async () => {
    resetFx();
    fx.canManage = false;
    fx.taggedMeetings = [{ id: 'm1', tags: ['sales'] }];
    const res = await dispatch({ method: 'POST', url: '/kb1/sources', body: { kind: 'meeting_tag', config: { tag: 'sales' } } });
    assert.strictEqual(res.statusCode, 403);
    assert.strictEqual(fx.sources.length, 0);
});
