'use strict';

/**
 * The finalize-time naming net (appNaming.js): five derivation rules in
 * order, EN and NL, the clamp, and "stays Untitled when nothing derivable".
 * The live briefs in scripts/builder-briefs are the fixtures where they say
 * enough to name the app.
 *
 * Run: cd server && node --test --test-force-exit appStudio/builderTools/appNaming.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { deriveAppName, ensureAppName, briefForNaming, briefForSnapshot, UNTITLED, MAX_APP_NAME, BRIEF_SNAPSHOT_MAX } = require('./appNaming');
const { emptyDefinition } = require('../componentSpecs');

const brief = (name) => {
    const d = require(path.join(__dirname, '..', '..', 'scripts', 'builder-briefs', `${name}.json`));
    return d.brief || (d.turns || [''])[0];
};

test('rule 1: an explicit name in the brief wins, in either language and either quote style', () => {
    assert.deepEqual(deriveAppName({ message: 'Bouw iets. App name "Facturen". Klaar.' }), { name: 'Facturen', source: 'brief' });
    assert.deepEqual(deriveAppName({ message: 'App naam: ‘Klantenoverzicht’' }), { name: 'Klantenoverzicht', source: 'brief' });
    assert.deepEqual(deriveAppName({ message: 'Please name the app “Orders dashboard” and build it.' }), { name: 'Orders dashboard', source: 'brief' });
    assert.deepEqual(deriveAppName({ message: 'Noem de app "Klachten". Bouw een register.' }), { name: 'Klachten', source: 'brief' });
    // The playbook brief says it at the very end, after two screens of spec.
    assert.deepEqual(deriveAppName({ message: brief('playbook-invoice-app') }), { name: 'Facturen', source: 'brief' });
    // An explicit name beats a heading and a table.
    assert.equal(deriveAppName({ message: '## Something else\nApp name "Winner"', dataModel: { tables: [{ name: 'Loser' }] } }).name, 'Winner');
});

test('rule 2: the first heading that is not the DESIGN block (nor a structural one)', () => {
    assert.deepEqual(deriveAppName({ message: '## Orders dashboard\n\nBuild a dashboard on my Studio table Orders.\n\n## DESIGN\nBlue.' }), { name: 'Orders dashboard', source: 'heading' });
    // Sub-headings inside DESIGN (`### Screen "…"`) never count, nor do structural headings.
    const withDesign = 'Build the invoices app.\n\n## DESIGN\nFollow this.\n\n### Screen "Overzicht" — the overview\n- **Top**: stat "x"';
    assert.deepEqual(deriveAppName({ message: withDesign }), { name: 'Invoices app', source: 'sentence' });
    assert.equal(deriveAppName({ message: '## Requirements\n- a\n## Tables\n- b\n## Klachtenregister\nx' }).name, 'Klachtenregister');
});

test('rule 3 and 4: the first table, then the first screen that is not Home', () => {
    assert.deepEqual(deriveAppName({ message: '', dataModel: { tables: [{ name: 'Suppliers', key: 'suppliers' }, { name: 'Invoices' }] } }), { name: 'Suppliers', source: 'table' });
    assert.deepEqual(deriveAppName({ message: '', dataModel: { tables: [{ key: 'order_lines' }] } }), { name: 'Order lines', source: 'table' });
    const def = emptyDefinition();
    def.screens.push({ id: 'scr_2', name: 'Invoices', sections: [] });
    assert.deepEqual(deriveAppName({ message: '', def }), { name: 'Invoices', source: 'screen' });
    assert.equal(deriveAppName({ message: '', def: emptyDefinition() }), null, 'Home alone names nothing');
    // The brief that names nothing itself (invoice-tracker) gets its first table.
    assert.equal(deriveAppName({ message: brief('invoice-tracker') }), null);
    assert.equal(deriveAppName({ message: brief('invoice-tracker'), dataModel: { tables: [{ name: 'Invoices' }] } }).name, 'Invoices');
});

test('rule 5: the first sentence with its imperative stripped, EN and NL, cut at the first connective', () => {
    const cases = [
        ['Build a professional invoice tracker for my team that lists all invoices.', 'Invoice tracker'],
        ['Maak een eenvoudige contactenlijst met een formulier.', 'Contactenlijst'],
        ['Make me a tip splitter', 'Tip splitter'],
        ['Can you create a kanban board for our sprint?', 'Kanban board'],
        ['Kun je een klachtenregister maken?', 'Klachtenregister'],
        ['I want a small tally counter.', 'Tally counter'],
        ['Bouw een facturen-dashboard op mijn Studio-tabel "Facturen" (alleen lezen).', 'Facturen-dashboard'],
        ['Design a bookings calendar with room availability and a booking form.', 'Bookings calendar'],
    ];
    for (const [message, expected] of cases) {
        assert.deepEqual(deriveAppName({ message }), { name: expected, source: 'sentence' }, message);
    }
    assert.equal(deriveAppName({ message: brief('facturen-app') }).name, 'Facturen-dashboard');
    // A generic head ("an app with tables where …") is not a name; the
    // clause after it is tried, and a brief with nothing else stays unnamed.
    assert.equal(deriveAppName({ message: 'Build me an app' }), null);
    assert.equal(deriveAppName({ message: 'An app.' }), null);
    assert.equal(deriveAppName({ message: 'Build an app for tracking complaints' }).name, 'Tracking complaints');
});

test('rule 5: a greeting or an acknowledgement that opens the brief is not the name, and filler alone never is', () => {
    // Measured in review 2026-09-18: the sentence rule fired on "Hi!" and
    // named the app "Hi" — exactly on the table-less, one-screen instrument
    // apps where no earlier rule applies.
    const cases = [
        ['Hi! Can you build me a tip splitter?', 'Tip splitter'],
        ['Hoi! Ik wil een fooi-verdeler.', 'Fooi-verdeler'],
        ['Hello. I need a tally counter please.', 'Tally counter'],
        ['Thanks. Build a counter.', 'Counter'],
        ['Hi, can you build me a tip splitter?', 'Tip splitter'],
        ['Hi Claude, maak een klachtenregister.', 'Klachtenregister'],
        ['Beste team: bouw een urenregistratie voor ons.', 'Urenregistratie'],
        ['Goedemorgen! Wij willen graag een planbord.', 'Planbord'],
        ['Hey there, so, build me a lunch order form for the office', 'Lunch order form'],
        ['We need an app to track invoices from suppliers', 'Track invoices'],
        ['Ok build a counter', 'Counter'],
        // A verb-only clause takes its object along.
        ['Kun je een app maken voor het bijhouden van klachten', 'Bijhouden van klachten'],
    ];
    for (const [message, expected] of cases) {
        assert.deepEqual(deriveAppName({ message }), { name: expected, source: 'sentence' }, message);
    }
    // Nothing but filler: Untitled beats "Hi".
    for (const message of ['Hi!', 'Hoi', 'Please.', 'We need', 'Thanks!', 'Ok.', 'Hi, can you?']) {
        assert.equal(deriveAppName({ message }), null, message);
    }
});

test('rule 2: a heading written as an ask loses its imperative', () => {
    assert.deepEqual(deriveAppName({ message: '## Build an invoice app\n\nWith a table.' }), { name: 'Invoice app', source: 'heading' });
    assert.deepEqual(deriveAppName({ message: '## Maak een klachtenregister\n\nMet een formulier.' }), { name: 'Klachtenregister', source: 'heading' });
    // A heading that IS a name keeps its own words — no connective cut, no four-word cap.
    assert.deepEqual(deriveAppName({ message: '## Invoice tracker for the finance team\n\nx' }), { name: 'Invoice tracker for the finance team', source: 'heading' });
});

test('the clamp: at most 40 chars, cut at a word boundary, quotes and trailing punctuation gone', () => {
    const long = 'Build a very comprehensive multi departmental purchase order intake and approval workflow tool';
    const r = deriveAppName({ message: long });
    assert.ok(r.name.length <= MAX_APP_NAME, r.name);
    assert.ok(!r.name.endsWith(' '));
    assert.equal(deriveAppName({ message: 'App name "A name that is far too long for an app card to show comfortably"' }).name, 'A name that is far too long for an app');
    assert.equal(deriveAppName({ message: 'App name "Untitled app"' }), null, 'the default is never a derived name');
    assert.equal(deriveAppName({ message: 'App name " "' }), null);
    assert.equal(deriveAppName({}), null);
    assert.equal(deriveAppName({ message: 42 }), null);
});

test('ensureAppName names an Untitled draft in place and says how, and leaves a named draft alone', () => {
    const wrap = { def: emptyDefinition(), dataModel: null, _turnMessage: 'Build a professional invoice tracker for my team.' };
    const hint = ensureAppName(wrap);
    assert.equal(wrap.def.meta.name, 'Invoice tracker');
    assert.equal(hint, 'The app was still "Untitled app" — named "Invoice tracker" from your brief; call app_set_meta to change it.');
    assert.equal(ensureAppName(wrap), null, 'a named draft is left alone');
    // From the first table when the brief says nothing.
    const fromTable = { def: emptyDefinition(), dataModel: { tables: [{ name: 'Invoices' }] }, _turnMessage: brief('invoice-tracker') };
    assert.match(ensureAppName(fromTable), /named "Invoices" from your first table/);
    assert.equal(fromTable.def.meta.name, 'Invoices');
    // Nothing derivable: untouched, no hint.
    const bare = { def: emptyDefinition(), dataModel: null, _turnMessage: '' };
    const before = JSON.stringify(bare.def);
    assert.equal(ensureAppName(bare), null);
    assert.equal(JSON.stringify(bare.def), before);
    assert.equal(bare.def.meta.name, UNTITLED);
    // A named draft (the playbook pre-creates the row as the playbook title) never fires.
    const named = { def: emptyDefinition('Facturen goedkeuren'), _turnMessage: 'App name "Other"' };
    assert.equal(ensureAppName(named), null);
    assert.equal(named.def.meta.name, 'Facturen goedkeuren');
    assert.equal(ensureAppName({}), null);
    assert.equal(ensureAppName(null), null);
});

test('briefForNaming reads the FIRST human message of the session, never a follow-up or a synthetic turn sentence', () => {
    const first = 'Bouw een welkomstpagina met onze openingstijden';
    // Turn 1: no history — this turn's own text is the brief.
    assert.equal(briefForNaming(undefined, first), first);
    assert.equal(briefForNaming([], first), first);
    // Turn 2: the persisted first user entry is the brief, not "Maak de kop groter".
    const history = [
        { role: 'user', content: first },
        { role: 'assistant', content: 'Klaar.' },
        { role: 'user', content: 'Maak de kop groter' },
    ];
    assert.equal(briefForNaming(history, 'Maak de kop groter'), first);
    // A synthetic sentence (approval / continuation / image-only turn) is
    // skipped wherever it sits — an image-only first turn is persisted with
    // its attachment line, so the match is on the prefix.
    assert.equal(briefForNaming([{ role: 'user', content: 'Build the approved plan.' }, { role: 'user', content: first }], ''), first);
    assert.equal(briefForNaming([{ role: 'user', content: 'Look at the image(s) I attached.\n(the user attached 1 image on this turn)' }], ''), '');
    assert.equal(briefForNaming([], 'Continue with the next phase of the approved plan.'), '');
    // What the net makes of it: the follow-up text alone would have named the
    // app "Kop groter"; the brief names it from the ask.
    assert.equal(deriveAppName({ message: briefForNaming(history, 'Maak de kop groter') }).name, 'Welkomstpagina');
    assert.equal(deriveAppName({ message: briefForNaming([], 'Build the approved plan.') }), null);
});

test('the brief persisted on the snapshot outlives the HEAD trim of its messages', () => {
    // A long session: the store has evicted the first messages, so the
    // history opens with a follow-up — the persisted brief still names it.
    const first = 'Bouw een welkomstpagina met onze openingstijden';
    const evicted = [{ role: 'user', content: 'Maak de kop groter' }, { role: 'assistant', content: 'Gedaan.' }];
    assert.equal(briefForNaming(evicted, 'Nog groter', first), first);
    assert.equal(briefForNaming(evicted, 'Nog groter'), 'Maak de kop groter', 'without it the follow-up is all that is left');
    // A synthetic sentence is never persisted as the brief, nor read as one.
    assert.equal(briefForSnapshot('Build the approved plan.'), undefined);
    assert.equal(briefForSnapshot(''), undefined);
    assert.equal(briefForSnapshot(first), first);
    assert.equal(briefForSnapshot('x'.repeat(BRIEF_SNAPSHOT_MAX + 10)).length, BRIEF_SNAPSHOT_MAX, 'capped: the snapshot has a 64KB budget');
    assert.equal(briefForNaming(evicted, 'Nog groter', 'Continue with the next phase of the approved plan.'), 'Maak de kop groter');
});
