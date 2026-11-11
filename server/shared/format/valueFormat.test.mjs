/**
 * The shared value formatter: the legacy path is the old code, value for value, and each key of
 * `format` / `formatOptions` changes only what it names.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LEGACY, formatContext, formatNumber, formatDate, makeValueFormatter, localeDateArgs, withFieldDisplay } from './valueFormat.mjs';

// The formatter the runtime had before this module (agent-hub runtime/chartPalette.ts), verbatim.
function oldMakeValueFormatter(valueFormat) {
    return (raw) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return raw == null ? '' : String(raw);
        if (valueFormat === 'percent') {
            return `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
        }
        if (valueFormat === 'currency') {
            return n.toLocaleString(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
        }
        return n.toLocaleString();
    };
}

const NUMBERS = [0, -0, 1, -1, 0.5, 0.05, 0.123456, 12.345, 1234.5, -1234.567, 1e6, 123456789.987, 1e21, 2.5e-7, '42', '1234.5', '', ' ', null, undefined, 'abc', NaN, Infinity, -Infinity, true, false, [], [3], {}];
const DATES = ['2026-03-01', '2026-03-01T00:00:00Z', '2026-12-31T23:59:59.999Z', '1999-01-01T12:30:00+05:00', 0, 1767225600000, 'not a date', '', new Date('2026-07-04T09:05:03Z')];

test('without format and formatOptions every number is written exactly as before', () => {
    for (const kind of ['number', 'percent', 'currency', undefined, 'bogus']) {
        const old = oldMakeValueFormatter(kind);
        for (const ctx of [undefined, null, {}, { app: null, options: null }, { app: {}, options: {} }, { app: { language: null }, options: { decimals: undefined } }]) {
            const fmt = makeValueFormatter(kind, ctx);
            for (const v of NUMBERS) assert.equal(fmt(v), old(v), `${kind} ${JSON.stringify(ctx)} ${String(v)}`);
        }
    }
});

test('without a context every date is written exactly as before', () => {
    for (const v of DATES) {
        const d = new Date(v);
        const valid = !Number.isNaN(d.getTime());
        assert.equal(formatDate(v, 'date', null), valid ? d.toLocaleDateString() : null);
        assert.equal(formatDate(v, 'datetime', null), valid ? d.toLocaleString() : null);
        assert.equal(formatDate(v, 'date', formatContext({}, {})), valid ? d.toLocaleDateString() : null);
    }
    assert.equal(LEGACY.number(1234.5), (1234.5).toLocaleString());
});

test('a format that sets one key keeps the legacy choice for every other key', () => {
    const app = { language: 'en-US' };
    const ctx = formatContext(app);
    assert.equal(formatNumber(1234.5, 'currency', ctx), (1234.5).toLocaleString('en-US', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }));
    assert.equal(formatNumber(12.345, 'percent', ctx), '12.3%');
    assert.equal(formatNumber(1234.5678, 'number', ctx), '1,234.568');
    // Only a time zone: the number paths are the viewer's locale, as before.
    const tzOnly = formatContext({ timeZone: 'UTC' });
    for (const v of [0, 1234.5, -9.99]) {
        assert.equal(formatNumber(v, 'currency', tzOnly), LEGACY.currency(v));
        assert.equal(formatNumber(v, 'percent', tzOnly), LEGACY.percent(v));
        assert.equal(formatNumber(v, 'number', tzOnly), LEGACY.number(v));
    }
});

test('an amount in USD with two decimals, from the app or from the column', () => {
    const fromApp = formatContext({ language: 'en-US', currency: 'USD', currencyDecimals: 2 });
    assert.equal(formatNumber(1234.5, 'currency', fromApp), '$1,234.50');
    const fromColumn = formatContext({ language: 'en-US' }, { currency: 'USD', decimals: 2 });
    assert.equal(formatNumber(1234.5, 'currency', fromColumn), '$1,234.50');
    // The column wins over the app.
    const both = formatContext({ language: 'en-US', currency: 'GBP', currencyDecimals: 0 }, { currency: 'USD', decimals: 2 });
    assert.equal(formatNumber(3, 'currency', both), '$3.00');
    assert.equal(makeValueFormatter('currency', { app: { language: 'en-US', currency: 'USD', currencyDecimals: 2 } })(99), '$99.00');
});

test('decimals, compact and the percent scale', () => {
    const en = { language: 'en-US' };
    assert.equal(formatNumber(2, 'number', formatContext(en, { decimals: 2 })), '2.00');
    assert.equal(formatNumber(1234567, 'number', formatContext(en, { compact: true })), '1.2M');
    assert.equal(formatNumber(1500, 'currency', formatContext({ ...en, currency: 'USD' }, { compact: true })), '$2K');
    assert.equal(formatNumber(25, 'percent', formatContext(en, { decimals: 1 })), '25.0%');
    assert.equal(formatNumber(0.256, 'percent', formatContext(en, { percentScale: 'fraction' })), '25.6%');
    assert.equal(formatNumber(0.25, 'percent', formatContext(en, { percentScale: 'fraction', decimals: 0 })), '25%');
    assert.equal(formatNumber(1234.5, 'number', formatContext({ language: 'nl-NL' }, { decimals: 2 })), '1.234,50');
});

test('date patterns, styles, the app time zone and calendar dates', () => {
    const moment = '2026-07-04T21:05:03Z';
    const utc = { language: 'en-US', timeZone: 'UTC' };
    assert.equal(formatDate(moment, 'date', formatContext(utc, { pattern: 'dd-MM-yyyy' })), '04-07-2026');
    assert.equal(formatDate(moment, 'datetime', formatContext(utc, { pattern: "EEE d MMM yy 'at' h:mm a" })), 'Sat 4 Jul 26 at 9:05 PM');
    assert.equal(formatDate(moment, 'date', formatContext({ ...utc, dateFormat: 'yyyy/MM/dd' })), '2026/07/04');
    assert.equal(formatDate(moment, 'datetime', formatContext({ ...utc, dateFormat: 'yyyy/MM/dd' })), '2026/07/04 21:05');
    assert.equal(formatDate(moment, 'date', formatContext({ ...utc, dateFormat: 'long' })), 'July 4, 2026');
    // Amsterdam is two hours ahead in July: the moment is on the next day there.
    assert.equal(formatDate(moment, 'datetime', formatContext({ language: 'en-US', timeZone: 'Europe/Amsterdam', dateFormat: 'dd-MM-yyyy' })), '04-07-2026 23:05');
    assert.equal(formatDate('2026-07-04T23:30:00Z', 'date', formatContext({ language: 'en-US', timeZone: 'Europe/Amsterdam' }, { pattern: 'd MMMM' })), '5 July');
    assert.equal(formatDate('2026-07-04T23:30:00Z', 'date', formatContext({ language: 'nl-NL', timeZone: 'Europe/Amsterdam' }, { pattern: 'EEEE d MMMM' })), 'zondag 5 juli');
    // A calendar date never moves to the day before, whatever the zone.
    assert.equal(formatDate('2026-03-01', 'date', formatContext({ timeZone: 'America/New_York' }, { pattern: 'yyyy-MM-dd' })), '2026-03-01');
    assert.equal(formatDate('not a date', 'date', formatContext(utc)), null);
});

test('a value Intl refuses falls back to the legacy text', () => {
    const bad = formatContext({ timeZone: 'Not/AZone', language: 'en-US' });
    const d = new Date('2026-01-02T03:04:05Z');
    assert.equal(formatDate(d, 'datetime', bad), d.toLocaleString());
    assert.equal(formatNumber(5, 'currency', formatContext({}, { currency: 'TOOLONG' })), formatNumber(5, 'currency', formatContext({}, { decimals: undefined, currency: 'EUR' })));
});

test('a chart time axis keeps its own options and gains the app language and zone', () => {
    const opts = { day: 'numeric', month: 'short' };
    assert.deepEqual(localeDateArgs(null, opts), [undefined, opts]);
    assert.deepEqual(localeDateArgs({}, opts), [undefined, opts]);
    assert.equal(localeDateArgs({}, opts)[1], opts);
    assert.deepEqual(localeDateArgs({ language: 'de-DE', timeZone: 'UTC' }, opts), ['de-DE', { ...opts, timeZone: 'UTC' }]);
});

test('the field display hook: the column keys win, bad values are left out', () => {
    assert.equal(withFieldDisplay(undefined, undefined), undefined);
    assert.deepEqual(withFieldDisplay(undefined, { currency: 'USD', decimals: 2, unit: ' kg ', dateStyle: 'medium' }), { currency: 'USD', decimals: 2, unit: 'kg', dateStyle: 'medium' });
    assert.deepEqual(withFieldDisplay({ decimals: 0 }, { currency: 'usd', decimals: 2, dateStyle: 'nope' }), { decimals: 0 });
    const ctx = formatContext({ language: 'en-US' }, withFieldDisplay({}, { decimals: 1, unit: 'kg' }));
    assert.equal(formatNumber(72, 'number', ctx), '72.0 kg');
    assert.equal(formatDate('2026-07-04', 'date', formatContext({ language: 'en-US' }, withFieldDisplay({}, { dateStyle: 'medium' }))), 'Jul 4, 2026');
});
