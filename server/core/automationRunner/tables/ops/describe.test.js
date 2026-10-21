'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./testKit');

const N = 40;
const DATA = Array.from({ length: N }, (_, i) => ({
    rid: `r${i}`,
    contact: `person${i}@example.test`,
    team: ['red', 'blue', 'green'][i % 3],
    rating: String(i % 6),
    amount: `${(i * 3.7).toFixed(1).replace('.', ',')}`,
    when: `2026-0${(i % 9) + 1}-1${i % 9}`,
    topics: i % 2 ? 'sun;rain' : 'sun',
    comment: `free text number ${i} about something`,
    empty: i % 2 ? '' : null,
}));
const describeOf = async (extra = {}, rows = DATA, runExtra = {}) => {
    const { result, rows: out } = await run([{ op: 'describe', ...extra }], rows, runExtra);
    return { description: result.description, out, result };
};
const col = (d, key) => d.columns.find((c) => c.key === key);

test('describe classifies columns and leaves the rows alone', async () => {
    const { description: d, out } = await describeOf();
    assert.equal(out.length, N);
    assert.equal(d.rowCount, N);
    assert.equal(col(d, 'rid').kind, 'identifier');
    assert.equal(col(d, 'team').kind, 'single');
    assert.equal(col(d, 'rating').kind, 'scale');
    assert.equal(col(d, 'amount').kind, 'numeric');
    assert.equal(col(d, 'when').kind, 'date');
    assert.equal(col(d, 'topics').kind, 'multi');
    assert.equal(col(d, 'comment').kind, 'identifier');
    assert.equal(col(d, 'empty').kind, 'empty');
});

test('describe gives options, ranges and split suitability', async () => {
    const { description: d } = await describeOf();
    const team = col(d, 'team');
    assert.deepEqual(team.options.map((o) => o.value).sort(), ['blue', 'green', 'red']);
    assert.equal(team.options.reduce((s, o) => s + o.count, 0), N);
    assert.equal(team.usableAsSplit, true);
    const topics = col(d, 'topics');
    assert.equal(topics.separator, ';');
    assert.deepEqual(topics.options.map((o) => [o.value, o.count]), [['sun', 40], ['rain', 20]]);
    const rating = col(d, 'rating');
    assert.deepEqual([rating.min, rating.max, rating.usableAsSplit], [0, 5, true]);
    assert.equal(rating.options[0].value, '0');
    const amount = col(d, 'amount');
    assert.equal(amount.min, 0);
    assert.ok(amount.mean > 50 && amount.usableAsSplit === false);
    assert.deepEqual([col(d, 'empty').filled, col(d, 'empty').empty], [0, N]);
});

test('describe hides sample values for identifiers and personal-looking columns', async () => {
    const { description: d } = await describeOf();
    for (const key of ['rid', 'contact']) {
        assert.deepEqual(col(d, key).sampleValues, []);
    }
    assert.equal(col(d, 'contact').looksPersonal, true);
    assert.equal(col(d, 'rid').looksPersonal, true);
    assert.equal(col(d, 'team').looksPersonal, false);
    assert.deepEqual(col(d, 'team').sampleValues, ['red', 'blue', 'green']);
    assert.ok(!JSON.stringify(d).includes('example.test'));
});

test('describe spots phone-shaped values and respects sampleValues and columns', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ phone: `+31 6 1234 56${i}0`, note: `n${i % 2}` }));
    const { description: d } = await describeOf({ columns: ['phone', 'note'], sampleValues: 1 }, rows);
    assert.equal(col(d, 'phone').looksPersonal, true);
    assert.deepEqual(col(d, 'phone').sampleValues, []);
    assert.equal(col(d, 'note').sampleValues.length, 1);
    const only = await describeOf({ columns: ['note'] }, rows);
    assert.equal(only.description.columns.length, 1);
});

test('describe passes the source provenance through', async () => {
    const { description } = await describeOf({}, DATA, { provenance: { exported: '2026-01-01', origin: 'sheet' } });
    assert.deepEqual(description.provenance, { exported: '2026-01-01', origin: 'sheet' });
    const none = await describeOf();
    assert.equal(none.description.provenance, null);
});

test('describe uses a chosen separator and caps long options lists', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ a: `x/y${i % 2}`, b: `v${i}` }));
    const { description: d } = await describeOf({ separator: '/' }, rows);
    assert.equal(col(d, 'a').kind, 'multi');
    assert.equal(col(d, 'a').separator, '/');
    const many = await describeOf({ maxOptions: 2 }, DATA);
    assert.notEqual(col(many.description, 'team').kind, 'single');
});

test('describe on an unknown column is table_op_invalid', async () => {
    await assert.rejects(run([{ op: 'describe', columns: ['ghost'] }], DATA), (e) => e.errorClass === 'table_op_invalid' && e.field === 'columns[0]');
});
