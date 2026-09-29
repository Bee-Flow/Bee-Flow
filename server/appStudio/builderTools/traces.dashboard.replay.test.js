'use strict';

/**
 * The invoice-dashboard turn, replayed.
 *
 * Recorded 2026-09-16 against the real tools (Gemma 4 26B-A4B, core menu) on
 * the brief that produced the user's broken dashboard: a page header, a card
 * of three stat tiles, a card of two charts, a card with a filter bar and a
 * grid. The turn shows the two defects that cost that build its layout, and
 * this file is what keeps them fixed:
 *
 *   call 2 — the whole screen in one nested call, and the JSON came back with
 *            keys that are not keys (`'"style"'`, `'"title"'`) from the second
 *            card on. Refused whole until 2026-09-17; now a PARTIAL apply: the
 *            header and the first card (three stat tiles) land, the group in
 *            which the JSON broke is reported at its path with the resend it
 *            needs, and the debris after it is dropped — never salvaged into
 *            a bare chart where a card was meant.
 *   call 3 — the same screen sent as three groups typed "section". Refused
 *            three times in a row (calls 3, 4, 5 are the same call) because
 *            `section` is not a component type. It now lands: `section` reads
 *            as `container`, and the repeat is caught as a duplicate batch
 *            instead of looping.
 *
 * Fixture shape: { name, recordedAt, model, brief, note, calls:[{n, tool,
 * args, observed}] } — `observed` is what the server answered AT THE TIME
 * (history, not an expectation). Never edit a call's args.
 *
 * Run: cd server && node --test --test-force-exit appStudio/builderTools/traces.dashboard.replay.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { applyToolCall } = require('../builderTools');
const { emptyDefinition } = require('../componentSpecs');
const { canonicalizeDataModel } = require('../dataModel');

const TRACE = require(path.join(__dirname, 'traces', '2026-09-16-invoice-dashboard.json'));
const call = (n) => TRACE.calls.find((c) => c.n === n);

/** The linked Facturen table the draft carried that turn. */
function dataModel() {
    return canonicalizeDataModel({
        tables: [{
            id: 'tbl_ab859b', key: 'facturen', name: 'Facturen',
            source: { kind: 'datatable', datatableId: 'dt_1', mode: 'read' },
            fields: [
                { id: 'f1', key: 'factuur_datum', name: 'Factuurdatum', type: 'date' },
                { id: 'f2', key: 'leverancier', name: 'Leverancier', type: 'text' },
                { id: 'f3', key: 'totaal_bedrag', name: 'Totaal bedrag', type: 'number' },
                { id: 'f4', key: 'btw_bedrag', name: 'BTW bedrag', type: 'number' },
                { id: 'f5', key: 'status', name: 'Status', type: 'text' },
            ],
        }],
    }).model;
}

function draft() {
    const wrap = {
        userId: 'u1', orgId: null, appId: null, version: null, builderSessionId: 'bs_trace',
        def: emptyDefinition('Facturen'), dataModel: dataModel(), dataModelVersion: 1,
        rowCounts: { tbl_ab859b: 142 }, datasetIds: [], _ownerDatatables: ['dt_1'],
    };
    return { wrap, sectionId: wrap.def.screens[0].sections[0].id };
}

/** The recorded call with its section id pointed at this draft's section. */
function mapped(args, sectionId) {
    return JSON.parse(JSON.stringify(args).split('sec_vn86vp').join(sectionId));
}

function types(nodes, depth = 0) {
    return (nodes || []).flatMap((n) => [`${'  '.repeat(depth)}${n.type}`, ...types(n.children, depth + 1)]);
}

test(`${TRACE.name}: the whole-screen call lands its whole part — header + first card — and reports the broken group at its path`, async () => {
    const d = draft();
    const r = await applyToolCall('app_add_components', mapped(call(2).args, d.sectionId), d.wrap);
    assert.ok(!r.error, `the whole part of the call lands: ${JSON.stringify(r)}`);
    assert.deepStrictEqual(r.added.map((a) => a.type), ['page_header', 'card', 'stat', 'stat', 'stat'], 'the header and the Samenvatting card with its three tiles');
    assert.strictEqual(r.ids.card_samenvatting, r.added[1].id);
    const laid = types(d.wrap.def.screens[0].sections[0].children);
    assert.deepStrictEqual(laid, ['page_header', 'card', '  stat', '  stat', '  stat'], 'nothing else — no bare chart, no fragment');
    // The group the JSON broke in (the "Verdeling" card: its first chart's
    // `type` swallowed the rest, and the card's own type came after its
    // children) is reported ONCE, at the path the model wrote it at, with
    // the resend it needs — never as a salvaged half.
    assert.strictEqual(r.failed.length, 1, JSON.stringify(r.failed));
    assert.deepStrictEqual([r.failed[0].index, r.failed[0].path], [1, 'components[1].children[1]']);
    assert.match(r.failed[0].error, /is a group whose JSON broke at its child 1 \(children\[0\]\) and whose own type was lost with it — nothing of it was applied/);
    assert.match(r.failed[0].error, /Resend that whole group as ONE call of its own/);
    assert.match(r.failed[0]._fixHint, /Resend ONLY components\[1\]\.children\[1\] as its own app_add_components call \(parentId unchanged\)/);
    // The debris after the break is counted, once, and the advice is the size rule.
    assert.ok(r._hints.some((h) => /The call's JSON arrived corrupted \(8 keys that are not a key, 4 fragments dropped\) — keep calls small: one card per call/.test(h)), JSON.stringify(r._hints));
    assert.ok(r._hints.some((h) => /1 entry failed and was skipped; the rest landed/.test(h)));
    // Sent again unchanged: nothing is minted twice — the landed part is
    // skipped with its ids in a hint, and the broken group is reported
    // again at its path, because it is STILL missing ("Nothing new" would
    // tell the model to move on without the Verdeling card).
    const again = await applyToolCall('app_add_components', mapped(call(2).args, d.sectionId), d.wrap);
    assert.match(String(again.error), /^components\[1\]\.children\[1\] is a group whose JSON broke/);
    assert.ok((again._hints || []).some((h) => /3 of 4 entries already landed from this exact batch \(page_header cmp_\w+, card cmp_\w+, stat cmp_\w+/.test(h)), JSON.stringify(again._hints));
    assert.strictEqual(d.wrap.def.screens[0].sections[0].children.length, 2);
    assert.strictEqual(types(d.wrap.def.screens[0].sections[0].children).length, 5, 'the card and its tiles were not minted twice');
});

test(`${TRACE.name}: the three groups typed "section" land, and the repeat is caught`, async () => {
    const d = draft();
    const first = await applyToolCall('app_add_components', mapped(call(3).args, d.sectionId), d.wrap);
    assert.ok(!first.error, `the call that looped three times must land: ${JSON.stringify(first.error)}`);
    assert.strictEqual(first.added.length, 14, 'header + three groups with everything inside them');
    for (const i of [1, 2, 3]) {
        assert.ok((first._hints || []).some((h) => h.includes(`components[${i}]: type "section" read as "container"`)),
            `the reading is reported for entry ${i}: ${JSON.stringify(first._hints)}`);
    }

    // Calls 4 and 5 are call 3 again — the loop. The duplicate guard answers
    // with the ids instead of adding the screen a second time.
    for (const n of [4, 5]) {
        const again = await applyToolCall('app_add_components', mapped(call(n).args, d.sectionId), d.wrap);
        assert.match(String(again.error), /Nothing new/, `call ${n} must be recognised as the same batch`);
        assert.ok(again.alreadyAdded && again.alreadyAdded.added.length, `call ${n} hands back what is already there`);
    }
    assert.strictEqual(d.wrap.def.screens[0].sections[0].children.length, 4, 'the screen was built once');
});

test(`${TRACE.name}: what the user sees is a header on top and the three groups under it`, async () => {
    const d = draft();
    await applyToolCall('app_add_components', mapped(call(3).args, d.sectionId), d.wrap);
    const laid = types(d.wrap.def.screens[0].sections[0].children);
    assert.strictEqual(laid[0], 'page_header', `the header comes first: ${laid.join(' | ')}`);
    assert.strictEqual(laid.filter((t) => t.trim() === 'card').length, 3, 'three cards');
    for (const t of ['stat', 'chart', 'filter_bar', 'data_grid']) {
        assert.ok(laid.some((l) => l.trim() === t), `${t} landed — ${laid.join(' | ')}`);
    }
});
