/**
 * deriveTitle / ensureDraftTitle — the six briefs in scripts/builder-briefs/
 * and the rules between them.
 *
 * Run: cd server && node --test --test-force-exit automation/builderTools/deriveTitle.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { deriveTitle, ensureDraftTitle, TITLE_IN_BRIEF_RE, UNTITLED_AUTOMATION, MAX_TITLE } = require('./deriveTitle');

const BRIEFS = path.join(__dirname, '..', '..', 'scripts', 'builder-briefs');
// Loaded once, by name, into a plain object — not a function that reads on
// every call. Named apart from the `brief` property key used throughout this
// file's own fixtures (`{ brief: '...' }`): the two are unrelated, and
// sharing a name with something this common made every `{ brief: ... }`
// literal below look like a reference to this loader.
const BRIEF_FIXTURES = Object.fromEntries(
    fs.readdirSync(BRIEFS).map((f) => [f.replace(/\.json$/, ''), JSON.parse(fs.readFileSync(path.join(BRIEFS, f), 'utf8')).brief]),
);
const loadBriefFixture = (name) => BRIEF_FIXTURES[name];

test('the six briefs derive the titles a person would pick', () => {
    const expected = {
        // (a) the playbook briefs state their title
        'playbook-invoice-routine': 'Facturen inlezen',
        'playbook-invoice-approvals': 'Facturen goedkeuren',
        'playbook-invoice-app': 'Facturen',
        // (c) the first sentence that says what it does, boilerplate skipped
        'invoices-facturen': 'Lees elke PDF-factuur in de Nextcloud-map /Invoices-Test',
        'invoice-tracker': 'Create an app with tables',
        'facturen-app': 'Bouw een facturen-dashboard op mijn Studio-tabel "Facturen"…',
    };
    for (const [name, want] of Object.entries(expected)) {
        assert.equal(deriveTitle({ brief: loadBriefFixture(name) }), want, name);
    }
});

test('a stated title wins over every other rule, in four spellings and three quote styles', () => {
    assert.equal(deriveTitle({ brief: 'Build a thing that does a lot of things every day. Title "Daily digest".' }), 'Daily digest');
    assert.equal(deriveTitle({ brief: 'Titel: "Facturen goedkeuren" graag' }), 'Facturen goedkeuren');
    assert.equal(deriveTitle({ brief: 'Naam “Nieuwe klanten” — verder niets' }), 'Nieuwe klanten');
    assert.equal(deriveTitle({ brief: "## Do the invoices\nName 'Invoice run'" }), 'Invoice run');
    assert.equal(deriveTitle({ brief: 'Give it the title "Ochtendbriefing" please, and run it daily.' }), 'Ochtendbriefing', 'title is a statement wherever it stands');
    assert.equal(deriveTitle({ brief: '- Name: "Weekly digest"\n- every Monday' }), 'Weekly digest', 'a list item is a statement');
    // An apostrophe inside a single-quoted title is part of it, not its end.
    assert.equal(deriveTitle({ brief: "Title: 'It's a test of the naming'" }), "It's a test of the naming");
    assert.equal(deriveTitle({ brief: 'Titel: ‘’s Ochtends de post’' }), '’s Ochtends de post');
    // The same pattern the playbook stage mirrors client-side.
    assert.equal(TITLE_IN_BRIEF_RE.exec(loadBriefFixture('playbook-invoice-routine'))[1], 'Facturen inlezen');
    assert.equal(TITLE_IN_BRIEF_RE.exec(loadBriefFixture('playbook-invoice-app'))[1], 'Facturen');
});

test('"name" mid-sentence is a field, not a title statement — the sentence rule names the routine instead', () => {
    // Each of these passed the ≤60 / not-default checks as "From",
    // "Leverancier" and "It" before the statement form, and nothing
    // downstream repairs a wrong title.
    assert.equal(deriveTitle({ brief: 'Put the sender name "From" and the subject in a Slack message every morning at 9' }),
        'Put the sender name "From" and the subject in a Slack…');
    assert.equal(deriveTitle({ brief: 'Maak een tabel met kolom naam "Leverancier" en zet elke factuur erin' }),
        'Maak een tabel met kolom naam "Leverancier" en zet elke…');
    assert.equal(deriveTitle({ brief: 'Read the column name "Datum" and the title "Totaal" of every row into a note.' }),
        'Totaal', 'title (not name) is still a statement mid-sentence');
    for (const b of ['the sender name "From" goes first', 'kolom naam "Leverancier"', 'subtitle "Nope"', 'Title "ab"', `Title "${'y'.repeat(121)}"`]) {
        assert.equal(TITLE_IN_BRIEF_RE.exec(b), null, `no statement in: ${b.slice(0, 40)}`);
    }
});

test('the playbook stage mirrors the pattern byte for byte', () => {
    // agent-hub seeds the routine's title from the brief before the first
    // build turn with the SAME regex; the two are in different packages, so
    // the pin reads the source — a drift here is a routine named two ways.
    const stage = path.join(__dirname, '..', '..', '..', 'agent-hub', 'src', 'components', 'admin', 'Studio', 'Playbooks', 'stages', 'RoutineStage.jsx');
    const src = fs.readFileSync(stage, 'utf8');
    const m = /export const TITLE_IN_BRIEF_RE = \/(.*)\/([a-z]*);/.exec(src);
    assert.ok(m, 'RoutineStage.jsx exports TITLE_IN_BRIEF_RE as a literal');
    assert.equal(m[1], TITLE_IN_BRIEF_RE.source);
    assert.equal(m[2], TITLE_IN_BRIEF_RE.flags);
});

test('a heading names the routine, its quoted part first, and a generic heading is skipped', () => {
    assert.equal(deriveTitle({ brief: '## Build an automation "Facturen goedkeuren"\nI start it by hand.' }), 'Facturen goedkeuren');
    assert.equal(deriveTitle({ brief: '## Weekly invoice digest\nEvery Monday, search Gmail and email me.' }), 'Weekly invoice digest');
    assert.equal(deriveTitle({ brief: '## Build an automation\nI start it by hand: manual trigger.\n1. Read every PDF invoice in the folder and extract the fields.' }),
        'Read every PDF invoice in the folder and extract the fields');
});

test('the first sentence: boilerplate skipped, the imperative stripped, cut on a word boundary with an ellipsis', () => {
    assert.equal(deriveTitle({ brief: 'Maak een routine die ik met de hand start. Lees elke factuur en zet hem in de tabel.' }), 'Lees elke factuur en zet hem in de tabel');
    assert.equal(deriveTitle({ brief: 'Create a routine that searches my Gmail for unread invoices every morning.' }), 'Searches my Gmail for unread invoices every morning');
    const long = deriveTitle({ brief: 'Every weekday at 8am, search my Gmail for unread invoices and email me a summary of them.' });
    assert.ok(long.length <= MAX_TITLE && long.endsWith('…'), long);
    assert.ok(!/\s…$/.test(long), 'no space before the ellipsis');
});

test('with nothing usable in the brief the definition names it, and with nothing at all it is still not the default', () => {
    const def = { trigger: { kind: 'manual' }, steps: [{ type: 'integration_action', tool: 'nextcloud_list_files' }, { type: 'datatable', label: 'Append row to Facturen' }] };
    assert.equal(deriveTitle({ brief: 'ok', def }), 'Manual: nextcloud_list_files → Append row to Facturen');
    const ev = { trigger: { kind: 'app_event', appEvent: { provider: 'gmail', event: 'mail.new' } }, steps: [{ type: 'ai_step', label: 'Draft reply' }] };
    assert.equal(deriveTitle({ brief: '', def: ev }), 'gmail mail.new: Draft reply');
    assert.equal(deriveTitle({ brief: 'ok', def: { trigger: { kind: 'manual' }, steps: [{ type: 'note', text: 'todo' }] } }), 'New routine', 'a note is not a step');
    assert.equal(deriveTitle({}), 'New routine');
    assert.equal(deriveTitle({ brief: `Title "${UNTITLED_AUTOMATION}"` }), 'New routine', 'never the default, even when the brief says so');
});

test('every derived title is ≤ 60 chars, whatever the brief', () => {
    const briefs = Object.values(BRIEF_FIXTURES);
    briefs.push('x'.repeat(500), `Title "${'y'.repeat(200)}"`, `## ${'z '.repeat(80)}`);
    for (const b of briefs) {
        const t = deriveTitle({ brief: b });
        assert.ok(t.length <= MAX_TITLE && t.length > 0, `${t.length}: ${t}`);
        assert.notEqual(t, UNTITLED_AUTOMATION);
    }
});

test('ensureDraftTitle names an untitled draft once and leaves a chosen title alone', () => {
    const wrap = { title: UNTITLED_AUTOMATION, def: { trigger: { kind: 'manual' }, steps: [] } };
    assert.deepEqual(ensureDraftTitle(wrap, { brief: loadBriefFixture('playbook-invoice-routine') }), { derived: true, title: 'Facturen inlezen' });
    assert.equal(wrap.title, 'Facturen inlezen');
    assert.deepEqual(ensureDraftTitle(wrap, { brief: 'Title "Other"' }), { derived: false, title: 'Facturen inlezen' }, 'a named draft keeps its name');
    const empty = { title: '', def: {} };
    assert.deepEqual(ensureDraftTitle(empty, { brief: '' }), { derived: true, title: 'New routine' });
    const chosen = { title: 'Mine', def: {} };
    assert.deepEqual(ensureDraftTitle(chosen, { brief: 'Title "Theirs"' }), { derived: false, title: 'Mine' });
});
