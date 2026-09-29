'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
    maskEmail, maskRequest, maskTimeline,
    dossierRequest, dossierTimeline,
    PUBLIC_COLUMNS, DOSSIER_COLUMNS, FREE_TEXT_COLUMNS,
} = require('./mask');

test('maskEmail keeps the first character and the domain only', () => {
    assert.strictEqual(maskEmail('jan.jansen@example.org'), 'j***@example.org');
    assert.strictEqual(maskEmail('  Tom@Beeflow.nl '), 'T***@Beeflow.nl');
});

test('maskEmail degrades to *** on anything that is not an address', () => {
    assert.strictEqual(maskEmail('a@b.c'), 'a***@b.c');
    assert.strictEqual(maskEmail('@example.org'), '***');
    assert.strictEqual(maskEmail('nodomain@'), '***');
    assert.strictEqual(maskEmail('plain'), '***');
    assert.strictEqual(maskEmail(''), '***');
    assert.strictEqual(maskEmail(null), '***');
    assert.strictEqual(maskEmail(42), '***');
});

test('maskRequest rebuilds the row from the allow-list — subject_email never survives', () => {
    const row = {
        id: 7, organization_id: 'org', request_type: 'access', status: 'pending',
        subject_email: 'person@example.org', source_ip: '10.0.0.1', result_payload: { secret: 1 },
        due_at: '2026-10-01T00:00:00Z', channel: 'public_form', identity_status: 'unverified',
        timeline: [], future_column_with_pii: 'leak',
    };
    const out = maskRequest(row);
    assert.strictEqual(out.subject_email, undefined);
    assert.strictEqual(out.subject_email_masked, 'p***@example.org');
    assert.strictEqual(out.id, 7);
    assert.strictEqual(out.due_at, row.due_at);
    // Columns outside the allow-list — including ones added later — are dropped.
    assert.strictEqual(out.future_column_with_pii, undefined);
    assert.strictEqual(out.source_ip, undefined);
    assert.strictEqual(out.result_payload, undefined);
    assert.ok(!JSON.stringify(out).includes('person@example.org'));
});

test('maskRequest: missing columns stay missing, extras opt in by name', () => {
    const out = maskRequest({ id: 1, subject_email: 'x@y.z', days_left: 3 }, { extra: ['days_left'] });
    assert.deepStrictEqual(Object.keys(out).sort(), ['days_left', 'id', 'subject_email_masked']);
    assert.strictEqual(maskRequest(null), null);
    // Passing subject_email as an "extra" cannot unmask it.
    const sneaky = maskRequest({ id: 1, subject_email: 'x@y.z' }, { extra: ['subject_email'] });
    assert.strictEqual(sneaky.subject_email, undefined);
    assert.ok(!PUBLIC_COLUMNS.includes('subject_email'));
});

test('maskTimeline keeps the known event keys and drops the rest', () => {
    const tl = [
        { at: '2026-09-01T00:00:00Z', by: null, kind: 'received', channel: 'public_form', email: 'x@y.z' },
        { at: '2026-09-02T00:00:00Z', by: 'u1', kind: 'extended', text: 'backlog', until: '2026-11-30T00:00:00Z' },
        null, 'garbage',
    ];
    const out = maskTimeline(tl);
    assert.strictEqual(out.length, 2);
    assert.strictEqual(out[0].email, undefined);
    assert.strictEqual(out[0].channel, 'public_form');
    assert.strictEqual(out[1].until, '2026-11-30T00:00:00Z');
    assert.deepStrictEqual(maskTimeline(undefined), []);
});

// ── The dossier: a file that leaves the app claiming to hold no personal data ──

test('dossierRequest drops every free-text column and reports its length instead', () => {
    const row = {
        id: 7, organization_id: 'org', request_type: 'access', status: 'fulfilled',
        subject_email: 'jan.jansen@example.org',
        notes: 'Ik ben Jan Jansen, Kerkstraat 1, 1234 AB Utrecht',
        result_summary: 'Kopie per post naar Jan Jansen gestuurd.',
        extension_reason: 'Dossier van Jan Jansen loopt over twee systemen.',
        due_at: '2026-10-01T00:00:00Z', channel: 'public_form', identity_status: 'verified_email_link',
        timeline: [{ at: '2026-09-01T00:00:00Z', kind: 'received' }],
        source_ip: '10.0.0.1', future_column_with_pii: 'leak',
    };
    const out = dossierRequest(row);

    // The whole file, not just the field: the subject typed their own name and
    // address into the public form's notes.
    const json = JSON.stringify(out);
    assert.ok(!json.includes('Jan Jansen'), 'the subject\'s name must not be in the dossier');
    assert.ok(!json.includes('Kerkstraat'), 'nor their address');
    assert.strictEqual(out.notes, undefined);
    assert.strictEqual(out.result_summary, undefined);
    assert.strictEqual(out.extension_reason, undefined);
    assert.strictEqual(out.timeline, undefined);
    assert.strictEqual(out.source_ip, undefined);
    assert.strictEqual(out.future_column_with_pii, undefined);
    assert.strictEqual(out.subject_email, undefined);

    // What the handling record still says: the shape, and that there WAS text.
    assert.strictEqual(out.notes_length, row.notes.length);
    assert.strictEqual(out.result_summary_length, row.result_summary.length);
    assert.strictEqual(out.extension_reason_length, row.extension_reason.length);
    assert.strictEqual(out.id, 7);
    assert.strictEqual(out.status, 'fulfilled');
    assert.strictEqual(out.due_at, row.due_at);
    assert.strictEqual(out.identity_status, 'verified_email_link');
    assert.strictEqual(out.subject_email_masked, 'j***@example.org');

    // A column with no text gets no length key (never an invented 0).
    assert.strictEqual(dossierRequest({ id: 1, subject_email: 'x@y.z' }).notes_length, undefined);
    assert.strictEqual(dossierRequest(null), null);
});

test('the in-app view keeps the free text the DPO has to read', () => {
    const row = { id: 7, subject_email: 'jan@example.org', notes: 'Please delete everything', result_summary: 'Done', extension_reason: 'Backlog' };
    const inApp = maskRequest(row);
    assert.strictEqual(inApp.notes, 'Please delete everything');
    assert.strictEqual(inApp.result_summary, 'Done');
    assert.strictEqual(inApp.extension_reason, 'Backlog');
});

test('the dossier allow-list is its own list, not the in-app one minus a column', () => {
    for (const col of FREE_TEXT_COLUMNS) {
        assert.ok(!DOSSIER_COLUMNS.includes(col), `${col} is free text and must not be in DOSSIER_COLUMNS`);
        assert.ok(PUBLIC_COLUMNS.includes(col), `${col} stays in the in-app allow-list`);
    }
    assert.ok(!DOSSIER_COLUMNS.includes('subject_email'));
    assert.ok(!DOSSIER_COLUMNS.includes('timeline'));
    // Its own literal list: a column added to the in-app view does not reach a
    // downloaded file by itself.
    assert.ok(Object.isFrozen(DOSSIER_COLUMNS));
});

test('dossierTimeline keeps the trail\'s shape and drops the prose', () => {
    const tl = [
        { at: '2026-09-02T00:00:00Z', by: 'u1', kind: 'extended', text: 'Jan Jansen belde erover', until: '2026-11-30T00:00:00Z' },
        { at: '2026-09-03T00:00:00Z', by: 'u1', kind: 'fulfilled', text: 'Kopie naar Kerkstraat 1 gestuurd', status: 'fulfilled' },
        { at: '2026-09-01T00:00:00Z', by: null, kind: 'received', channel: 'public_form', email: 'jan@example.org' },
    ];
    const out = dossierTimeline(tl);
    assert.strictEqual(out.length, 3);
    assert.ok(!JSON.stringify(out).includes('Jan Jansen'));
    assert.ok(!JSON.stringify(out).includes('Kerkstraat'));
    assert.ok(!JSON.stringify(out).includes('jan@example.org'));
    assert.strictEqual(out[0].text, undefined);
    assert.strictEqual(out[0].text_length, tl[0].text.length);
    assert.strictEqual(out[0].kind, 'extended');
    assert.strictEqual(out[0].until, '2026-11-30T00:00:00Z');
    assert.strictEqual(out[1].status, 'fulfilled');
    assert.strictEqual(out[2].channel, 'public_form');
    assert.strictEqual(out[2].text_length, undefined);
    assert.strictEqual(out[2].email, undefined);
    // The in-app trail is unchanged — the DPO still reads the note.
    assert.strictEqual(maskTimeline(tl)[0].text, 'Jan Jansen belde erover');
    assert.deepStrictEqual(dossierTimeline(undefined), []);
});
