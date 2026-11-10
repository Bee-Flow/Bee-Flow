/**
 * Cleaning definition.format and a formatOptions object, and the date pattern grammar.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cleanAppFormat, cleanFormatOptions, shapeProblems, cleanLanguage, cleanTimeZone, cleanCurrency } from './formatClean.mjs';
import { parseDatePattern, isDatePattern } from './datePattern.mjs';

const collect = () => {
    const repairs = [];
    return { repairs, push: (code, path, message) => repairs.push({ code, path, message }) };
};

test('a clean format stays as it is, keys in their fixed order', () => {
    const value = { timeZone: 'Europe/Amsterdam', dateFormat: 'dd-MM-yyyy', currencyDecimals: 2, currency: 'USD', language: 'en-US' };
    const { repairs, push } = collect();
    const out = cleanAppFormat(value, push);
    assert.deepEqual(Object.keys(out), ['language', 'currency', 'currencyDecimals', 'dateFormat', 'timeZone']);
    assert.deepEqual(repairs, []);
    assert.deepEqual(cleanAppFormat(out), out);
    assert.deepEqual(shapeProblems(out, cleanAppFormat, 'format'), []);
});

test('what can be repaired is repaired, the rest is dropped with a sentence', () => {
    const { repairs, push } = collect();
    const out = cleanAppFormat({ language: 'en-us', currency: ' usd ', currencyDecimals: '2', dateFormat: 'medium', timeZone: 'Mars/Base', extra: 1 }, push);
    assert.deepEqual(out, { language: 'en-US', currency: 'USD', currencyDecimals: 2, dateFormat: 'medium' });
    assert.deepEqual(repairs.map((r) => `${r.code} @ ${r.path}`), ['format.invalid @ format.timeZone', 'format.unknown_key @ format']);
});

test('nothing usable is no key at all', () => {
    assert.equal(cleanAppFormat({}), undefined);
    assert.equal(cleanAppFormat({ currency: 'dollars' }), undefined);
    assert.equal(cleanAppFormat('en-US'), undefined);
    assert.equal(cleanFormatOptions({ decimals: 11, compact: 'yes' }), undefined);
    assert.equal(cleanFormatOptions([]), undefined);
    assert.ok(shapeProblems({}, cleanFormatOptions, 'x').length > 0);
    assert.ok(shapeProblems({ decimals: '2' }, cleanFormatOptions, 'x').length > 0, 'a value the cleaner would change is not canonical');
});

test('formatOptions: every key, and a percent scale', () => {
    assert.deepEqual(
        cleanFormatOptions({ percentScale: 'fraction', compact: true, pattern: "d MMM 'at' HH:mm", decimals: 0, currency: 'eur' }),
        { currency: 'EUR', decimals: 0, pattern: "d MMM 'at' HH:mm", compact: true, percentScale: 'fraction' },
    );
    assert.equal(cleanFormatOptions({ percentScale: 'half' }), undefined);
});

test('language tags, time zones and currency codes are asked of Intl or read by character', () => {
    assert.equal(cleanLanguage('nl'), 'nl');
    assert.equal(cleanLanguage('EN-gb'), 'en-GB');
    assert.equal(cleanLanguage('not a tag'), undefined);
    assert.equal(cleanLanguage('x'.repeat(40)), undefined);
    assert.equal(cleanTimeZone('UTC'), 'UTC');
    assert.equal(cleanTimeZone('Europe/Amsterdam'), 'Europe/Amsterdam');
    assert.equal(cleanTimeZone('Europe/Nowhere'), undefined);
    assert.equal(cleanCurrency('US$'), undefined);
    assert.equal(cleanCurrency('ÜSD'), undefined);
});

test('the date pattern grammar refuses stray letters and unclosed quotes', () => {
    assert.ok(isDatePattern('dd-MM-yyyy'));
    assert.ok(isDatePattern("EEEE d MMMM yyyy 'om' HH:mm"));
    assert.ok(isDatePattern("h:mm a ''"));
    assert.equal(isDatePattern('dd-MM-yyyyy'), false, 'a lone y after yyyy is no token');
    assert.equal(isDatePattern('DD-MM-YYYY'), false);
    assert.equal(isDatePattern("dd 'unclosed"), false);
    assert.equal(isDatePattern(' - '), false, 'no token');
    assert.equal(isDatePattern(''), false);
    assert.equal(isDatePattern('d'.repeat(41)), false);
    assert.deepEqual(parseDatePattern("d'd'"), [{ token: 'd' }, { text: 'd' }]);
});
