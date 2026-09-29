/**
 * Unit tests for the /map-json-fields pure helpers:
 * validateMapJsonRequest (request guardrails) and verifyMappedFields
 * (deterministic server-side verification of the model's proposals).
 *
 * Run: node routes/ai/automationBuilder.mapJson.test.js
 *
 * No HTTP/DB needed — we exercise the exported `_test` helpers directly.
 * (Requiring the route opens a DB pool, so we process.exit at the end.)
 */

const assert = require('assert');
const { validateMapJsonRequest, verifyMappedFields, verifyMapJsonItemsRef, MAP_JSON_FIELDS_TOOL } = require('./automationBuilder')._test;

(async () => {
    // ── validateMapJsonRequest ──

    // instruction guardrails
    assert.ok(validateMapJsonRequest({ sample: { a: 1 } }).error, 'missing instruction rejected');
    assert.ok(validateMapJsonRequest({ sample: { a: 1 }, instruction: '   ' }).error, 'blank instruction rejected');
    assert.ok(/too long/.test(validateMapJsonRequest({ sample: { a: 1 }, instruction: 'x'.repeat(2001) }).error), 'instruction over 2000 chars rejected');

    // sample guardrails
    assert.ok(/not valid JSON/.test(validateMapJsonRequest({ sample: '{oops', instruction: 'the id' }).error), 'invalid JSON string sample → 400 message');
    assert.ok(validateMapJsonRequest({ instruction: 'the id' }).error, 'missing sample rejected');
    assert.ok(validateMapJsonRequest({ sample: 42, instruction: 'the id' }).error, 'scalar sample rejected');
    assert.ok(validateMapJsonRequest({ sample: null, instruction: 'the id' }).error, 'null sample rejected');
    {
        const big = { blob: 'x'.repeat(200_001) };
        assert.ok(/too large/.test(validateMapJsonRequest({ sample: big, instruction: 'the id' }).error), 'oversized sample rejected');
    }

    // string samples parse (whitespace tolerated); object/array pass through
    {
        const r = validateMapJsonRequest({ sample: '  {"a": {"b": 1}} ', instruction: 'the b' });
        assert.ok(!r.error, r.error);
        assert.deepStrictEqual(r.sample, { a: { b: 1 } });
        assert.strictEqual(r.truncated, false);
    }
    {
        const r = validateMapJsonRequest({ sample: [{ id: 1 }], instruction: 'each id' });
        assert.ok(!r.error);
        assert.deepStrictEqual(r.sample, [{ id: 1 }]);
    }

    // secrets root scrub — a runState-shaped paste never ships its secrets
    {
        const r = validateMapJsonRequest({
            sample: { trigger: { output: {} }, secrets: { apiKey: 'sk-LEAK' } },
            instruction: 'the trigger fields',
        });
        assert.ok(!r.error);
        assert.ok(!('secrets' in r.sample), 'secrets key deleted from the sample');
        assert.ok(!r.sampleText.includes('sk-LEAK'), 'secret value absent from the serialized text');
    }

    // model-text truncation: >60k serialization is cut and flagged
    {
        const r = validateMapJsonRequest({ sample: { blob: 'x'.repeat(150_000) }, instruction: 'the blob' });
        assert.ok(!r.error);
        assert.strictEqual(r.truncated, true);
        assert.ok(r.sampleText.length <= 60_000, 'model text bounded to 60k');
    }

    // existingFields sanitized: rows without a name dropped, strings clamped
    {
        const r = validateMapJsonRequest({
            sample: { a: 1 }, instruction: 'the a',
            existingFields: [{ name: 'kept', path: 'a', description: 'd' }, { path: 'no_name' }, 'junk', { name: 'n'.repeat(100) }],
        });
        assert.strictEqual(r.existingFields.length, 2);
        assert.strictEqual(r.existingFields[0].name, 'kept');
        assert.strictEqual(r.existingFields[1].name.length, 64);
    }

    // ── verifyMappedFields ──

    const sample = {
        order: { customer: { email: 'a@b.c' } },
        items: [{ sku: 'X1', qty: 2 }, { sku: 'X2', qty: 1 }],
    };

    // verified rows get sampleValue; unverifiable paths return verified:false
    {
        const out = verifyMappedFields([
            { name: 'customer_email', path: 'order.customer.email', description: 'The e-mail' },
            { name: 'all_skus', path: 'items[*].sku' },
            { name: 'ghost', path: 'order.nope.deep' },
        ], sample);
        assert.strictEqual(out.length, 3);
        assert.deepStrictEqual(out[0], { name: 'customer_email', path: 'order.customer.email', description: 'The e-mail', verified: true, sampleValue: 'a@b.c' });
        assert.strictEqual(out[1].verified, true);
        assert.strictEqual(out[1].sampleValue, '["X1","X2"]');
        assert.deepStrictEqual(out[2], { name: 'ghost', path: 'order.nope.deep', description: '', verified: false }, 'unverified rows returned WITHOUT sampleValue');
    }

    // name-regex filtering + dedupe: invalid or repeated names are skipped
    {
        const out = verifyMappedFields([
            { name: '9bad', path: 'order' },
            { name: 'ok_name', path: 'order' },
            { name: 'ok_name', path: 'items' },
            { name: 'a'.repeat(65), path: 'order' },
            { path: 'order' },
            'junk',
        ], sample);
        assert.strictEqual(out.length, 1);
        assert.strictEqual(out[0].name, 'ok_name');
        assert.strictEqual(out[0].path, 'order');
    }

    // sampleValue truncation at 200 chars
    {
        const out = verifyMappedFields([{ name: 'big', path: 'blob' }], { blob: 'z'.repeat(500) });
        assert.strictEqual(out[0].verified, true);
        assert.strictEqual(out[0].sampleValue.length, 201, '200 chars + ellipsis');
        assert.ok(out[0].sampleValue.endsWith('…'));
    }

    // prototype-chain paths never verify (same block as the runtime)
    {
        const out = verifyMappedFields([{ name: 'ctor', path: 'constructor' }], sample);
        assert.strictEqual(out[0].verified, false);
    }

    // root-array samples verify with leading-bracket paths
    {
        const out = verifyMappedFields([{ name: 'first_id', path: '[0].id' }], [{ id: 7 }]);
        assert.strictEqual(out[0].verified, true);
        assert.strictEqual(out[0].sampleValue, '7');
    }

    // model output is untrusted: non-array input yields []
    assert.deepStrictEqual(verifyMappedFields(null, sample), []);
    assert.deepStrictEqual(verifyMappedFields('junk', sample), []);

    // cap at 50 rows
    {
        const many = Array.from({ length: 60 }, (_, i) => ({ name: `f_${i}`, path: 'order' }));
        assert.strictEqual(verifyMappedFields(many, sample).length, 50);
    }

    // ── forced-tool shape sanity ──
    assert.strictEqual(MAP_JSON_FIELDS_TOOL.function.name, 'return_field_mappings');
    assert.deepStrictEqual(MAP_JSON_FIELDS_TOOL.function.parameters.required, ['fields']);
    assert.deepStrictEqual(MAP_JSON_FIELDS_TOOL.function.parameters.properties.fields.items.required, ['name', 'path']);

    // ── grouped proposals (itemsRef) ──
    // "grouped per meeting" must map to one row per entry, not a flat list.
    {
        const cal = { results: [
            { title: 'Daily Scrum', attendees: [{ email: 'a@x.nl', name: null }, { email: 'b@x.nl', name: 'Bee' }] },
            { title: 'Weekstart',   attendees: [{ email: 'c@x.nl', name: null }] },
        ] };

        // an itemsRef is accepted only when it really resolves to a list
        assert.strictEqual(verifyMapJsonItemsRef('results', cal), 'results');
        assert.strictEqual(verifyMapJsonItemsRef('results[0]', cal), '', 'a single entry is not a list');
        assert.strictEqual(verifyMapJsonItemsRef('nope', cal), '', 'unresolvable ref dropped');
        assert.strictEqual(verifyMapJsonItemsRef('', cal), '');
        assert.strictEqual(verifyMapJsonItemsRef(null, cal), '');

        // grouped: paths are verified against ONE entry
        const rows = verifyMappedFields([
            { name: 'meeting_title', path: 'title' },
            { name: 'attendee_emails', path: 'attendees[*].email' },
            { name: 'attendee_names', path: 'attendees[*].name' },
        ], cal, { itemsRef: 'results' });
        const byName = Object.fromEntries(rows.map(r => [r.name, r]));
        assert.strictEqual(byName.meeting_title.verified, true);
        assert.strictEqual(byName.meeting_title.sampleValue, 'Daily Scrum', 'sample comes from entry 1, not the whole list');
        assert.strictEqual(byName.attendee_emails.matchCount, 2);
        assert.strictEqual(byName.attendee_emails.itemCount, 2);
        // a path that exists but is mostly empty is reported, not hidden
        assert.strictEqual(byName.attendee_names.verified, true);
        assert.strictEqual(byName.attendee_names.matchCount, 2, 'both entries have a names array (values may be null)');

        // ungrouped verification is unchanged (no match counters)
        const flat = verifyMappedFields([{ name: 'titles', path: 'results[*].title' }], cal);
        assert.strictEqual(flat[0].verified, true);
        assert.strictEqual(flat[0].matchCount, undefined);
    }

    // a field missing from entry 1 but present later still verifies
    {
        const s2 = { rows: [{ a: 1 }, { a: 2, b: 'here' }] };
        const [row] = verifyMappedFields([{ name: 'b', path: 'b' }], s2, { itemsRef: 'rows' });
        assert.strictEqual(row.verified, true, 'a late-appearing field is still usable');
        assert.strictEqual(row.matchCount, 1);
        assert.strictEqual(row.sampleValue, 'here');
    }

    // itemsRef is offered to the model
    assert.ok(MAP_JSON_FIELDS_TOOL.function.parameters.properties.itemsRef, 'tool exposes itemsRef');

    console.log('automationBuilder.mapJson.test.js: all helper tests passed');
    process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
