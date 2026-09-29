/**
 * The cell codec: serials ↔ ISO without a timezone, the paste-compatible
 * number/bool/date readers, a column's own date spelling honoured for the
 * ambiguous cells, and a read → write → read echo that is a no-op.
 */
const test = require('node:test');
const assert = require('node:assert');

// The codec is timezone-free by construction — every test below must hold
// in Amsterdam as in Los Angeles or UTC — and one shape is only visible off
// UTC: a pg DATE, which node-pg hands over as midnight in the SERVER's zone.
process.env.TZ = 'Europe/Amsterdam';

const cells = require('./cells');

test('serialToIso / isoToSerial use the 1899-12-30 epoch and are exact inverses', () => {
    assert.equal(cells.serialToIso(46037), '2026-01-15');
    assert.equal(cells.serialToIso(46037.57326388889), '2026-01-15T13:45:30.000Z');
    assert.equal(cells.serialToIso(46037, { time: true }), '2026-01-15T00:00:00.000Z');
    assert.equal(cells.isoToSerial('2026-01-15'), 46037);
    assert.ok(Math.abs(cells.isoToSerial('2026-01-15T13:45:30.000Z') - 46037.57326388889) < 1e-9);
    assert.equal(cells.serialToIso(cells.isoToSerial('1999-12-31')), '1999-12-31');
    assert.equal(cells.serialToIso(1), '1900-01-01');          // Excel's leap-year quirk honoured
    assert.equal(cells.isoToSerial('1900-01-01'), 1);
    assert.equal(cells.serialToIso('abc'), null);
    assert.equal(cells.isoToSerial('not a date'), null);
});

test('serials are read as wall clock whatever the process timezone says', () => {
    // The test runner may sit in any zone; a serial is TZ-free by construction.
    const d = cells.serialToDate(46037.5);
    assert.equal(d.toISOString(), '2026-01-15T12:00:00.000Z');
    assert.equal(cells.readCell(46037.5, { type: 'datetime' }), '2026-01-15T12:00:00.000Z');
    assert.equal(cells.readCell(46037.5, { type: 'date' }), '2026-01-15');
});

test('parseNumberish reads both decimal conventions and refuses identifiers', () => {
    assert.equal(cells.parseNumberish('1.234,56'), 1234.56);
    assert.equal(cells.parseNumberish('1,234.56'), 1234.56);
    assert.equal(cells.parseNumberish('1,234'), 1234);
    assert.equal(cells.parseNumberish('1,5'), 1.5);
    assert.equal(cells.parseNumberish('€ 12,50'), 12.5);
    assert.equal(cells.parseNumberish('$1,234,567'), 1234567);
    assert.equal(cells.parseNumberish('-3.75'), -3.75);
    assert.equal(cells.parseNumberish('21%'), 0.21);
    assert.equal(cells.parseNumberish(7), 7);
    assert.ok(Number.isNaN(cells.parseNumberish('0123')));
    assert.ok(Number.isNaN(cells.parseNumberish('1.234.56')));
    assert.ok(Number.isNaN(cells.parseNumberish('12a')));
    assert.ok(Number.isNaN(cells.parseNumberish('')));
    assert.ok(Number.isNaN(cells.parseNumberish(true)));
});

test('parseBoolish knows the Dutch spellings', () => {
    for (const v of ['ja', 'JA', 'waar', 'wel', 'yes', 'true', 'y', '1', 'x', true, 1]) assert.equal(cells.parseBoolish(v), true, String(v));
    for (const v of ['nee', 'onwaar', 'niet', 'no', 'false', 'n', '0', false, 0]) assert.equal(cells.parseBoolish(v), false, String(v));
    assert.equal(cells.parseBoolish('misschien'), null);
    assert.equal(cells.parseBoolish(''), null);
    assert.equal(cells.parseBoolish(2), null);
});

test('parseDateish is day-first unless that is impossible', () => {
    assert.equal(cells.parseDateish('2026-01-15'), '2026-01-15');
    assert.equal(cells.parseDateish('15-01-2026'), '2026-01-15');
    assert.equal(cells.parseDateish('15/01/2026'), '2026-01-15');
    assert.equal(cells.parseDateish('15.01.2026'), '2026-01-15');
    assert.equal(cells.parseDateish('03/04/2026'), '2026-04-03');       // ambiguous → day first
    assert.equal(cells.parseDateish('01/15/2026'), '2026-01-15');       // 15 cannot be a month
    assert.equal(cells.parseDateish('31-02-2026'), null);
    assert.equal(cells.parseDateish('15-01-26'), null);
    assert.equal(cells.parseDateish('gisteren'), null);
    assert.deepEqual(cells.parseDateishDetailed('15-01-2026'), { date: '2026-01-15', format: 'dd-mm-yyyy', ambiguous: false });
    assert.deepEqual(cells.parseDateishDetailed('01/15/2026'), { date: '2026-01-15', format: 'mm/dd/yyyy', ambiguous: false });
    // a pair both halves of which could be the month is read day-first AND says it guessed
    assert.deepEqual(cells.parseDateishDetailed('03/04/2026'), { date: '2026-04-03', format: 'dd/mm/yyyy', ambiguous: true });
    assert.deepEqual(cells.parseDateishDetailed('2026-03-04'), { date: '2026-03-04', format: 'yyyy-mm-dd', ambiguous: false });
});

test('the column\'s own spelling decides an ambiguous cell: an mm/dd column reads 03/04 as 4 March, and writes it back the same', () => {
    assert.notEqual(new Date(2026, 0, 15).getTimezoneOffset(), 0);   // the process really is in Amsterdam
    assert.equal(cells.parseDateish('03/04/2026', 'mm/dd/yyyy'), '2026-03-04');
    assert.equal(cells.parseDateish('03/04/2026', 'dd/mm/yyyy'), '2026-04-03');
    assert.equal(cells.parseDateish('03/04/2026'), '2026-04-03', 'no hint: day first');
    assert.equal(cells.parseDateish('13/04/2026', 'mm/dd/yyyy'), '2026-04-13', 'a day over 12 is a day whatever the hint says');
    assert.equal(cells.parseDateish('2026-03-04', 'mm/dd/yyyy'), '2026-03-04', 'ISO is ISO');
    assert.deepEqual(cells.parseDateishDetailed('03/04/2026', 'mm/dd/yyyy'), { date: '2026-03-04', format: 'mm/dd/yyyy', ambiguous: true }, 'the hint decides, the cell is still a guess');
    assert.equal(cells.parseDatetimeish('03/04/2026 09:30', 'mm/dd/yyyy'), '2026-03-04T09:30:00.000Z');
    // through the codec, from the columnMap entry
    assert.equal(cells.readCell('03/04/2026', { type: 'date', dateFormat: 'mm/dd/yyyy' }), '2026-03-04');
    assert.equal(cells.readCell('03/04/2026', { type: 'date', dateFormat: 'dd/mm/yyyy' }), '2026-04-03');
    assert.equal(cells.readCell('03/04/2026', { type: 'date' }), '2026-04-03');
    assert.equal(cells.readCell('03/04/2026 09:30', { type: 'datetime', dateFormat: 'mm/dd/yyyy' }), '2026-03-04T09:30:00.000Z');
    assert.equal(cells.readCell('03/04/2026 09:30', { type: 'date', dateFormat: 'mm/dd/yyyy' }), '2026-03-04');
    assert.equal(cells.writeCell('03/04/2026', { type: 'date', dateFormat: 'mm/dd/yyyy' }).toISOString(), '2026-03-04T00:00:00.000Z');
    assert.equal(cells.writeCell('03/04/2026 09:30', { type: 'datetime', dateFormat: 'mm/dd/yyyy' }).toISOString(), '2026-03-04T09:30:00.000Z');
    // the round trip the csv writer makes: 2026-03-04 → '03/04/2026' in an mm/dd column → 2026-03-04 again
    const { formatField } = require('./formats/csv');
    const entry = { type: 'date', dateFormat: 'mm/dd/yyyy' };
    const inFile = formatField(cells.writeCell('2026-03-04', entry), entry, {});
    assert.equal(inFile, '03/04/2026');
    assert.equal(cells.readCell(inFile, entry), '2026-03-04');
});

test('writeCell(date) takes the calendar day a Date names on the clock it was made on: a pg DATE (local midnight) as well as a UTC one', () => {
    // postgres-date: DATE '2026-01-15' → new Date(2026, 0, 15) → 23:00Z of the 14th in Amsterdam
    const pgDate = new Date(2026, 0, 15);
    assert.equal(pgDate.toISOString(), '2026-01-14T23:00:00.000Z');
    assert.equal(cells.writeCell(pgDate, { type: 'date' }).toISOString(), '2026-01-15T00:00:00.000Z', 'the 15th, not the 14th');
    // the codec's own Dates (a reader's cell) are UTC midnight and stay what they are
    assert.equal(cells.writeCell(new Date(Date.UTC(2026, 0, 15)), { type: 'date' }).toISOString(), '2026-01-15T00:00:00.000Z');
    // a genuine instant with a clock keeps its UTC day, as before
    assert.equal(cells.writeCell(new Date('2026-01-15T23:30:00Z'), { type: 'date' }).toISOString(), '2026-01-15T00:00:00.000Z');
    assert.equal(cells.writeCell('2026-01-15T23:30:00Z', { type: 'date' }).toISOString(), '2026-01-15T00:00:00.000Z');
    assert.throws(() => cells.writeCell(new Date('nope'), { type: 'date', header: 'Datum' }), (e) => e.code === 'spreadsheet_rejected' && /^Datum: /.test(e.message));
});

test('parseDatetimeish joins a date and a clock as a UTC wall clock', () => {
    assert.equal(cells.parseDatetimeish('15-01-2026 13:45'), '2026-01-15T13:45:00.000Z');
    assert.equal(cells.parseDatetimeish('2026-01-15T13:45:30'), '2026-01-15T13:45:30.000Z');
    assert.equal(cells.parseDatetimeish('2026-01-15 13:45:30'), '2026-01-15T13:45:30.000Z');
    assert.equal(cells.parseDatetimeish('2026-01-15'), '2026-01-15T00:00:00.000Z');
    assert.equal(cells.parseDatetimeish('2026-01-15T13:45:30+02:00'), '2026-01-15T11:45:30.000Z');
    assert.equal(cells.parseDatetimeish('15-01-2026 25:00'), null);
    assert.equal(cells.parseDatetimeish('nope'), null);
});

test('the read codec turns any cell into the declared type, or NULL when it does not fit', () => {
    const d = new Date(Date.UTC(2026, 0, 15));
    const dt = new Date(Date.UTC(2026, 0, 15, 13, 45, 30));
    assert.equal(cells.readCell(d, { type: 'date' }), '2026-01-15');
    assert.equal(cells.readCell(dt, { type: 'date' }), '2026-01-15');
    assert.equal(cells.readCell(dt, { type: 'datetime' }), '2026-01-15T13:45:30.000Z');
    assert.equal(cells.readCell(d, { type: 'datetime' }), '2026-01-15T00:00:00.000Z');
    assert.equal(cells.readCell('15-01-2026', { type: 'date' }), '2026-01-15');
    assert.equal(cells.readCell('15-01-2026 13:45', { type: 'date' }), '2026-01-15');
    assert.equal(cells.readCell('2026-01-15T13:45:30.000Z', { type: 'date' }), '2026-01-15');
    assert.equal(cells.readCell('15-01-2026 13:45', { type: 'datetime' }), '2026-01-15T13:45:00.000Z');
    assert.equal(cells.readCell(46037, { type: 'date' }), '2026-01-15');
    assert.equal(cells.readCell('1.234,56', { type: 'number' }), 1234.56);
    assert.equal(cells.readCell(12, { type: 'number' }), 12);
    assert.equal(cells.readCell('n.v.t.', { type: 'number' }), null);
    assert.equal(cells.readCell(true, { type: 'number' }), null);
    assert.equal(cells.readCell('ja', { type: 'bool' }), true);
    assert.equal(cells.readCell(0, { type: 'bool' }), false);
    assert.equal(cells.readCell('soms', { type: 'bool' }), null);
    assert.equal(cells.readCell('0123', { type: 'text' }), '0123');
    assert.equal(cells.readCell(12.5, { type: 'text' }), '12.5');
    assert.equal(cells.readCell(true, { type: 'text' }), 'true');
    assert.equal(cells.readCell(d, { type: 'text' }), '2026-01-15');
    assert.equal(cells.readCell(dt, { type: 'text' }), '2026-01-15T13:45:30.000Z');
    assert.equal(cells.readCell(' Acme ', { type: 'text' }), ' Acme ');
    assert.equal(cells.readCell('Open', { type: 'select' }), 'Open');
    assert.equal(cells.readCell('', { type: 'number' }), null);
    assert.equal(cells.readCell(null, { type: 'text' }), null);
    assert.equal(cells.readCell(undefined, {}), null);
});

test('the write codec is the inverse of the read codec: an echo is a no-op', () => {
    const cases = [
        [new Date(Date.UTC(2026, 0, 15)), { type: 'date' }],
        [new Date(Date.UTC(2026, 0, 15, 13, 45, 30)), { type: 'datetime' }],
        [1234.56, { type: 'number' }],
        [true, { type: 'bool' }],
        [false, { type: 'bool' }],
        ['0123', { type: 'text' }],
        ['Open', { type: 'select' }],
    ];
    for (const [raw, entry] of cases) {
        const read = cells.readCell(raw, entry);
        const written = cells.writeCell(read, entry);
        if (raw instanceof Date) assert.equal(written.getTime(), raw.getTime(), entry.type);
        else assert.strictEqual(written, raw, entry.type);
        assert.deepEqual(cells.readCell(written, entry), read, entry.type);
    }
});

test('the write codec is strict and names the column', () => {
    assert.equal(cells.writeCell(null, { type: 'number' }), null);
    assert.equal(cells.writeCell('', { type: 'date' }), null);
    assert.equal(cells.writeCell('12,5', { type: 'number' }), 12.5);
    assert.equal(cells.writeCell('ja', { type: 'bool' }), true);
    assert.equal(cells.writeCell('15-01-2026', { type: 'date' }).toISOString(), '2026-01-15T00:00:00.000Z');
    assert.equal(cells.writeCell('2026-01-15T13:45:30.000Z', { type: 'date' }).toISOString(), '2026-01-15T00:00:00.000Z');
    assert.equal(cells.writeCell('2026-01-15T13:45:30.000Z', { type: 'datetime' }).toISOString(), '2026-01-15T13:45:30.000Z');
    assert.equal(cells.writeCell(12, { type: 'text' }), '12');
    assert.equal(cells.writeCell({ a: 1 }, { type: 'text' }), '{"a":1}');
    for (const [v, entry, code] of [
        ['abc', { type: 'number', header: 'Bedrag' }, 'spreadsheet_rejected'],
        ['soms', { type: 'bool', header: 'Betaald' }, 'spreadsheet_rejected'],
        ['31-02-2026', { type: 'date', header: 'Datum' }, 'spreadsheet_rejected'],
        ['nope', { type: 'datetime', header: 'Tijdstip' }, 'spreadsheet_rejected'],
    ]) {
        assert.throws(() => cells.writeCell(v, entry), (e) => {
            assert.equal(e.name, 'SpreadsheetSourceError');
            assert.equal(e.status, 422);
            assert.equal(e.code, code);
            assert.equal(e.safe, true);
            assert.match(e.message, new RegExp(`^${entry.header}: `));
            return true;
        });
    }
});

test('formatOfNumFmt recognises money and percentages', () => {
    assert.equal(cells.formatOfNumFmt('0.00%'), 'percent');
    assert.equal(cells.formatOfNumFmt('[$€-413] #,##0.00'), 'currency');
    assert.equal(cells.formatOfNumFmt('€#,##0.00'), 'currency');
    assert.equal(cells.formatOfNumFmt('#,##0.00'), null);
    assert.equal(cells.formatOfNumFmt('General'), null);
    assert.equal(cells.formatOfNumFmt(undefined), null);
});
