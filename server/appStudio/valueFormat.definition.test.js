'use strict';
/**
 * Value formatting in the definition: the top-level `format` key and `formatOptions` on table
 * and data_grid columns, on a chart and on a stat. Optional, emitted only when present,
 * schema 3, and a definition without them keeps its bytes and its version.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

const specs = require('./componentSpecs');
const { canonicalizeAppDefinition } = require('./canonicalize');
const { validateAppDefinition } = require('./validate');
const { buildPublicDefinition } = require('./publicAccess');
const { requiredSchemaVersion } = require('./schemaSince.mts');
const { inspectExtensions } = require('./builderPrompt/extensionIndex.mts');

const node = (id, type, props) => ({ id, type, props, style: { span: 12 }, visible: true });

/** One screen with a table, a grid, a chart and a stat; `extra` is merged into each. */
function appWith({ format, column, chart, stat } = {}) {
    const def = specs.emptyDefinition('Money');
    const col = { key: 'amount', label: 'Amount', format: 'currency', ...column };
    def.screens[0].sections[0].children.push(
        node('n_table0001', 'table', { columns: [col] }),
        node('n_grid00001', 'data_grid', { columns: [col] }),
        node('n_chart0001', 'chart', { valueFormat: 'currency', ...chart }),
        node('n_stat00001', 'stat', { label: 'Revenue', ...stat }),
    );
    if (format !== undefined) def.format = format;
    return def;
}

const canon = (def) => canonicalizeAppDefinition(def);
const children = (def) => def.screens[0].sections[0].children;
const errorsOf = (def) => validateAppDefinition(def).errors.map((e) => `${e.code} @ ${e.path}`);

test('without format and formatOptions nothing is written and the base version stays', () => {
    const { def } = canon(appWith());
    assert.equal('format' in def, false);
    for (const n of children(def)) {
        assert.equal('formatOptions' in n.props, false, n.type);
        for (const c of n.props.columns || []) assert.equal('formatOptions' in c, false);
    }
    assert.equal(def.schemaVersion, specs.SCHEMA_VERSION_BASE);
    assert.equal(requiredSchemaVersion(def), specs.SCHEMA_VERSION_BASE);
    // null means not set, also for the new keys.
    const nulls = canon(appWith({ column: { formatOptions: null }, chart: { formatOptions: null }, stat: { formatOptions: null } })).def;
    assert.deepEqual(children(nulls).map((n) => n.props), children(def).map((n) => n.props));
    assert.equal('format' in nulls, false);
});

test('a grid in USD with two decimals: canonical, valid, schema 3, and stable', () => {
    const input = appWith({
        format: { language: 'en-US', currency: 'usd', currencyDecimals: 2, dateFormat: 'd MMM yyyy', timeZone: 'Europe/Amsterdam' },
        column: { formatOptions: { decimals: 2, compact: false } },
        chart: { formatOptions: { compact: true } },
        stat: { formatOptions: { currency: 'GBP', decimals: 1 } },
    });
    const { def } = canon(input);
    assert.deepEqual(def.format, { language: 'en-US', currency: 'USD', currencyDecimals: 2, dateFormat: 'd MMM yyyy', timeZone: 'Europe/Amsterdam' });
    const [table, grid, chart, stat] = children(def);
    assert.deepEqual(table.props.columns[0].formatOptions, { decimals: 2, compact: false });
    assert.deepEqual(grid.props.columns[0].formatOptions, { decimals: 2, compact: false });
    assert.deepEqual(chart.props.formatOptions, { compact: true });
    assert.deepEqual(stat.props.formatOptions, { currency: 'GBP', decimals: 1 });
    assert.equal(def.schemaVersion, 3);
    assert.deepEqual(errorsOf(def), []);
    const again = canon(JSON.parse(JSON.stringify(def)));
    assert.equal(JSON.stringify(again.def), JSON.stringify(def));
    assert.deepEqual(again.repairs, []);
});

test('the format key alone, and one formatOptions alone, each make it schema 3', () => {
    assert.equal(canon(appWith({ format: { language: 'nl-NL' } })).def.schemaVersion, 3);
    assert.equal(canon(appWith({ column: { formatOptions: { decimals: 0 } } })).def.schemaVersion, 3);
    assert.equal(canon(appWith({ stat: { formatOptions: { compact: true } } })).def.schemaVersion, 3);
});

test('what cannot be used is dropped with a repair, and nothing usable drops the key', () => {
    const { def, repairs } = canon(appWith({
        format: { currency: 'dollars', timeZone: 'Moon/Base' },
        column: { formatOptions: { decimals: 99, pattern: 'YYYY' } },
        stat: { formatOptions: 'two decimals' },
    }));
    assert.equal('format' in def, false);
    assert.equal('formatOptions' in children(def)[0].props.columns[0], false);
    assert.equal('formatOptions' in children(def)[3].props, false);
    const codes = repairs.map((r) => `${r.code} @ ${r.path}`);
    assert.ok(codes.includes('format.invalid @ format.currency'), codes.join('\n'));
    assert.ok(codes.some((c) => c.startsWith('formatOptions.invalid @ screens[0].sections[0].children[0].props.columns[0].formatOptions.decimals')), codes.join('\n'));
    assert.ok(codes.some((c) => c.startsWith('formatOptions.invalid @ screens[0].sections[0].children[3].props.formatOptions')), codes.join('\n'));
    assert.equal(def.schemaVersion, specs.SCHEMA_VERSION_BASE);
});

test('canonical bytes handed in directly must already be clean', () => {
    const { def } = canon(appWith({ format: { currency: 'USD' }, column: { formatOptions: { decimals: 2 } }, chart: { formatOptions: { compact: true } } }));
    def.format.currency = 'usd';
    children(def)[1].props.columns[0].formatOptions.decimals = '2';
    children(def)[2].props.formatOptions = { compact: 'yes' };
    const errors = errorsOf(def);
    assert.ok(errors.includes('format.invalid @ format'), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('prop.object_invalid @ screens[0].sections[0].children[1].props.columns[0].formatOptions')), errors.join('\n'));
    assert.ok(errors.some((e) => e.startsWith('prop.object_invalid @ screens[0].sections[0].children[2].props.formatOptions')), errors.join('\n'));
});

test('a public page formats like the app: format is a public key', () => {
    const { def } = canon(appWith({ format: { currency: 'USD', currencyDecimals: 2 } }));
    const surface = { title: 'Form', entryScreenId: def.screens[0].id, screens: [], actionIds: new Set() };
    assert.deepEqual(buildPublicDefinition(def, surface).format, { currency: 'USD', currencyDecimals: 2 });
    assert.equal('format' in buildPublicDefinition(canon(appWith()).def, surface), false);
});

test('the AI builder reads every new entry in full through app_inspect_catalog', () => {
    const names = ['format', 'table.columns[].formatOptions', 'data_grid.columns[].formatOptions', 'chart.formatOptions', 'stat.formatOptions'];
    const answer = inspectExtensions(names, undefined);
    assert.deepEqual(answer.unknown, []);
    for (const name of names) assert.ok(answer.entries[name] && answer.entries[name].length > 80, name);
    assert.match(answer.entries.format, /currencyDecimals/);
    assert.match(answer.entries['table.columns[].formatOptions'], /percentScale/);
});
