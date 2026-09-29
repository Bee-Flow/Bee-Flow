/**
 * Unit tests for builder-trace-from-log.mjs — the pure parse/dedupe/fixture
 * functions. REAL_LINE is one rejected line copied byte-for-byte from a
 * builder log of 2026-09-12 (session bs_mtzdxjly): the model's second
 * builder_add_steps batch, four steps, refused because the forEach'd
 * nextcloud_read_file had no path binding.
 */

import test from 'node:test';
import assert from 'node:assert';

import {
    parseRejectedLine, dedupeEntries, collectInspectedTools, buildFixture, fixturesFromLog,
    canonicalJson, TRUNCATION_MARKERS, DEFAULT_OUT_DIR,
} from './builder-trace-from-log.mjs';

const REAL_LINE = String.raw`[AutomationBuilder] rejected builder_add_steps session=bs_mtzdxjly: steps[1] ($read_file): nextcloud_read_file: required input "path" is not bound — the step would fail at run time. Inside this forEach bind it from the item, e.g. path: {kind:"ref", path:"loop.f.path"}. args={"steps":[{"spec":{"inputs":{"path":{"kind":"literal","value":"/Invoices-Test"}},"label":"Scan map /Invoices-Test","tool":"nextcloud_list_files"},"tempId":"list_files","type":"integration_action"},{"spec":{"forEach":{"itemVar":"f","overRef":"steps.$list_files.output.items"},"label":"Lees PDF per bestand","tool":"nextcloud_read_file"},"tempId":"read_file","type":"integration_action"},{"spec":{"fields":[{"description":"Factuurdatum in YYYY-MM-DD formaat","name":"datum","type":"string"},{"description":"Naam van de leverancier","name":"leverancier","type":"string"},{"description":"Het factuurnummer","name":"factuurnummer","type":"string"},{"description":"Bedrag exclusief btw (bijv. 1554.25)","name":"excl_btw","type":"number"},{"description":"Het btw bedrag (bijv. 310.85)","name":"btw","type":"number"},{"description":"Het totaalbedrag (bijv. 1865.10)","name":"totaal","type":"number"}],"forEach":{"itemVar":"e","overRef":"steps.$read_file.output.results"},"prompt":"Extraheer de factuurgegevens uit de tekst van dit document.\nTekst: {{loop.e.output.content}}\n\nBelangrijke regels:\n- Datum MOET in YYYY-MM-DD formaat zijn.\n- Bedragen MOETEN getallen zijn met een punt als decimaalteken (bijv. 1554.25).\n- Leverancier, factuurnummer, excl_btw, btw en totaal moeten exact worden geïdentificeerd."},"source":{"kind":"ref","path":"loop.e.output.content"},"tempId":"extract_data","type":"data_extraction"},{"spec":{"afterStepId":"$extract_data","datatableId":{"kind":"literal","value":"Facturen"},"fields":{"btw":{"kind":"ref","path":"loop.e.output.btw"},"datum":{"kind":"ref","path":"loop.e.output.datum"},"excl_btw":{"kind":"ref","path":"loop.e.output.excl_btw"},"factuurnummer":{"kind":"ref","path":"loop.e.output.factuurnummer"},"leverancier":{"kind":"ref","path":"loop.e.output.leverancier"},"totaal":{"kind":"ref","path":"loop.e.output.totaal"}},"forEach":{"itemVar":"e","overRef":"steps.$extract_data.output.results"},"op":"append"},"tempId":"add_row","type":"datatable"}],"type":"integration_action"}`;

/** The same line with its args cut the way chatStream.js cuts them. */
function truncated(line, marker) {
    const at = line.indexOf(' args={') + ' args='.length;
    return line.slice(0, at + 200) + marker;
}

test('a real rejected line becomes a fixture with the call as the model sent it', () => {
    const parsed = parseRejectedLine(REAL_LINE);
    assert.ok(parsed && !parsed.refused, 'line parses');
    assert.strictEqual(parsed.tool, 'builder_add_steps');
    assert.strictEqual(parsed.session, 'bs_mtzdxjly');
    assert.strictEqual(parsed.args.steps.length, 4);
    assert.match(parsed.error, /^steps\[1\] \(\$read_file\): nextcloud_read_file: required input "path" is not bound/);
    assert.ok(!parsed.error.includes(' args='), 'error text stops before the args');

    const fixture = buildFixture({ ...parsed, repeats: 1 }, { brief: 'Lees elke factuur', now: new Date('2026-09-13T10:00:00Z') });
    assert.strictEqual(fixture.name, 'bs_mtzdxjly-01-builder_add_steps');
    assert.strictEqual(fixture.session, 'bs_mtzdxjly');
    assert.strictEqual(fixture.recordedAt, '2026-09-13T10:00:00.000Z');
    assert.strictEqual(fixture.brief, 'Lees elke factuur');
    assert.strictEqual(fixture.tool, 'builder_add_steps');
    assert.strictEqual(fixture.args.steps.length, 4);
    assert.strictEqual(fixture.rejectedWith, parsed.error);
    assert.strictEqual(fixture.repeats, 1);
    assert.deepStrictEqual(fixture.context.setup, [{ tool: 'builder_propose_trigger', args: { kind: 'manual' } }]);
    assert.ok(fixture.context.inspected.includes('nextcloud_list_files'));
    assert.ok(fixture.context.inspected.includes('nextcloud_read_file'));
    assert.strictEqual(fixture.context.datatables, 'facturen');
    assert.deepStrictEqual(fixture.expect, { outcome: 'applied' });
    assert.ok(!('stepTypes' in fixture.expect), 'stepTypes is left for a human to fill');
});

test('the repeat=/failedIndex= markers chatStream prints stay out of the error text and land as fields', () => {
    // Before 2026-09-13 both markers were parsed into the error group, so
    // every generated fixture's rejectedWith began "repeat=N failedIndex=X ".
    const marked = REAL_LINE.replace('session=bs_mtzdxjly: ', 'session=bs_mtzdxjly: repeat=2 failedIndex=1 ');
    const parsed = parseRejectedLine(marked);
    assert.ok(parsed && !parsed.refused, 'line parses');
    assert.match(parsed.error, /^steps\[1\] \(\$read_file\): /);
    assert.ok(!parsed.error.includes('repeat='), 'the rung is not part of the error');
    assert.strictEqual(parsed.ladderRepeat, 2);
    assert.strictEqual(parsed.failedIndex, 1);
    assert.strictEqual(parsed.args.steps.length, 4);
    assert.strictEqual(buildFixture({ ...parsed, repeats: 1 }).rejectedWith, parsed.error);
    // Outside a batch the index is "-".
    const single = parseRejectedLine(marked.replace('failedIndex=1 ', 'failedIndex=- '));
    assert.strictEqual(single.failedIndex, null);
    assert.strictEqual(single.ladderRepeat, 2);
    // The marker-less line (older logs) still parses, with nothing to report.
    const bare = parseRejectedLine(REAL_LINE);
    assert.strictEqual(bare.ladderRepeat, null);
    assert.strictEqual(bare.failedIndex, null);
    assert.match(bare.error, /^steps\[1\]/);
});

test('a line cut by the log cap is refused, with either truncation marker', () => {
    for (const marker of TRUNCATION_MARKERS) {
        const parsed = parseRejectedLine(truncated(REAL_LINE, marker));
        assert.ok(parsed && parsed.refused, `refused with marker ${JSON.stringify(marker)}`);
        assert.match(parsed.refused, /cut by the log cap/);
        assert.ok(parsed.refused.includes(marker), 'the refusal names the marker it saw');
        assert.strictEqual(parsed.tool, 'builder_add_steps');
        assert.strictEqual(parsed.session, 'bs_mtzdxjly');
    }
    // The bare marker must not swallow the longer one's name.
    assert.ok(parseRejectedLine(truncated(REAL_LINE, '…[truncated]')).refused.includes('…[truncated]'));
});

test('a line whose args are not JSON is refused, not repaired', () => {
    const broken = REAL_LINE.slice(0, REAL_LINE.length - 3);  // drops the closing n"} — no marker, just not JSON
    const parsed = parseRejectedLine(broken);
    assert.ok(parsed && parsed.refused);
    assert.match(parsed.refused, /not valid JSON/);
});

test('lines that are not rejected-call lines are ignored', () => {
    assert.strictEqual(parseRejectedLine('[AutomationBuilder] usage session=bs_mtzdxjly model=x rounds=3'), null);
    assert.strictEqual(parseRejectedLine(''), null);
    assert.strictEqual(parseRejectedLine('[AutomationBuilder] rejected builder_add_steps session=bs_x: no args here'), null);
});

test('two identical lines collapse into one fixture with repeats 2', () => {
    const { fixtures, refused } = fixturesFromLog(`${REAL_LINE}\n${REAL_LINE}\n`, { now: new Date('2026-09-13T10:00:00Z') });
    assert.strictEqual(refused.length, 0);
    assert.strictEqual(fixtures.length, 1);
    assert.strictEqual(fixtures[0].repeats, 2);
    assert.strictEqual(fixtures[0].tool, 'builder_add_steps');
});

test('dedupe ignores key order but not values or session', () => {
    const base = { session: 'bs_a', tool: 'builder_add_steps', error: 'e', args: { steps: [{ tempId: 'x', type: 'ai_step' }], afterStepId: null } };
    const reordered = { ...base, args: { afterStepId: null, steps: [{ type: 'ai_step', tempId: 'x' }] } };
    const other = { ...base, args: { ...base.args, afterStepId: 'a_1' } };
    const otherSession = { ...base, session: 'bs_b' };
    const out = dedupeEntries([base, reordered, other, otherSession]);
    assert.strictEqual(out.length, 3);
    assert.strictEqual(out[0].repeats, 2);
    assert.strictEqual(canonicalJson(base.args), canonicalJson(reordered.args));
});

test('--session keeps only that session and the refused lines are reported with their line number', () => {
    const otherSession = REAL_LINE.replace('session=bs_mtzdxjly', 'session=bs_other');
    const text = [otherSession, truncated(REAL_LINE, '…'), REAL_LINE].join('\n');
    const { fixtures, refused, otherSessions } = fixturesFromLog(text, { session: 'bs_mtzdxjly' });
    assert.strictEqual(otherSessions, 1);
    assert.strictEqual(fixtures.length, 1);
    assert.deepStrictEqual(refused.map((r) => r.line), [2]);
});

test('all lines refused yields no fixture', () => {
    const { fixtures, refused } = fixturesFromLog(truncated(REAL_LINE, '…[truncated]'));
    assert.strictEqual(fixtures.length, 0);
    assert.strictEqual(refused.length, 1);
});

test('collectInspectedTools finds every spec.tool, once, in order', () => {
    const args = { steps: [
        { spec: { tool: 'nextcloud_read_file' } },
        { spec: { tool: 'nextcloud_list_files' } },
        { spec: { tool: 'nextcloud_read_file' } },
        { spec: { fields: [{ name: 'x' }] } },
        { spec: { inputs: { tool: 'not_a_spec_tool' } } },
    ] };
    assert.deepStrictEqual(collectInspectedTools(args), ['nextcloud_read_file', 'nextcloud_list_files']);
});

test('name prefix lands in the fixture name and the default out dir sits under automation/builderTools', () => {
    const parsed = parseRejectedLine(REAL_LINE);
    const f = buildFixture({ ...parsed, repeats: 3 }, { namePrefix: 'invoices loop', index: 1 });
    assert.strictEqual(f.name, 'invoices-loop-bs_mtzdxjly-02-builder_add_steps');
    assert.strictEqual(f.repeats, 3);
    assert.match(DEFAULT_OUT_DIR.replace(/\\/g, '/'), /\/automation\/builderTools\/traces$/);
});
