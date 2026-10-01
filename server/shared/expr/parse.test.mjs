/**
 * The lenient readers behind number() and formatDate(). Run from server/:
 *   node --test shared/expr/parse.test.mjs
 *
 * The rule both readers serve: a value the engine could already read keeps
 * its result, and only a value that used to give null is now read the way a
 * person or another system wrote it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLocaleNumber, parseDate, epochFromNumber, EPOCH_SECONDS_BELOW } from './parse.mjs';

test('parseLocaleNumber — Dutch and euro notation', () => {
    assert.equal(parseLocaleNumber('12,5'), 12.5);
    assert.equal(parseLocaleNumber('1.554,25'), 1554.25);
    assert.equal(parseLocaleNumber('€ 1.554,25'), 1554.25);
    assert.equal(parseLocaleNumber('€1.554,25'), 1554.25);
    assert.equal(parseLocaleNumber('1 554,25 €'), 1554.25);
    assert.equal(parseLocaleNumber('1\u00a0554,25'), 1554.25);         // NBSP between groups
    assert.equal(parseLocaleNumber('1\u202f500\u202f000'), 1500000);  // narrow NBSP, as French formatting writes it
    assert.equal(parseLocaleNumber('1 500 000'), 1500000);
    assert.equal(parseLocaleNumber('-€ 12,50'), -12.5);
    assert.equal(parseLocaleNumber('€ -12,50'), -12.5);
    assert.equal(parseLocaleNumber('1.234.567'), 1234567);
    assert.equal(parseLocaleNumber('1.234.567,89'), 1234567.89);
    assert.equal(parseLocaleNumber('1,234,567.89'), 1234567.89);
    assert.equal(parseLocaleNumber('1,234.5'), 1234.5);
    assert.equal(parseLocaleNumber('1,234'), 1.234);                    // a lone comma is a decimal comma
    // Next to a euro sign, a lone separator before exactly three digits groups
    // thousands: an amount has cents, and execDataExtraction reads it so too.
    assert.equal(parseLocaleNumber('€ 1.554'), 1554);
    assert.equal(parseLocaleNumber('€1.554'), 1554);
    assert.equal(parseLocaleNumber('1.554 €'), 1554);
    assert.equal(parseLocaleNumber('€ 1,554'), 1554);
    assert.equal(parseLocaleNumber('-€ 12.500'), -12500);
    assert.equal(parseLocaleNumber('€ 0,125'), 0.125, 'a zero integer part is a decimal');
    assert.equal(parseLocaleNumber('€ 1.55'), 1.55, 'two digits after the mark are cents');
    assert.equal(parseLocaleNumber('€ 1234,567'), 1234.567, 'four integer digits cannot be a thousands group');
});

test('parseLocaleNumber — what is not one number stays null', () => {
    for (const text of ['', 'abc', '12,', ',5', '1.23.4', '1.234,567.8', '12,5,6.7', '€', '--5', '1 2 3', '12 5', '1 23,4', '12%']) {
        assert.equal(parseLocaleNumber(text), null, JSON.stringify(text));
    }
    assert.equal(parseLocaleNumber(12.5), null, 'only text is read; numbers never reach this reader');
    assert.equal(parseLocaleNumber(null), null);
});

test('parseDate — ISO keeps its reading, with the zone it was written in', () => {
    assert.deepEqual(parseDate('2026-09-02'), { epoch: Date.UTC(2026, 8, 2), offset: null });
    assert.deepEqual(parseDate('2026-9-2 7:05'), { epoch: Date.UTC(2026, 8, 2, 7, 5), offset: null });
    assert.deepEqual(parseDate('2026-09-01T00:30:00Z'), { epoch: Date.UTC(2026, 8, 1, 0, 30), offset: null });
    assert.deepEqual(parseDate('2026-09-01T00:30:00+02:00'), { epoch: Date.UTC(2026, 7, 31, 22, 30), offset: 120 });
    assert.deepEqual(parseDate('2026-09-01T00:30:00-0530'), { epoch: Date.UTC(2026, 8, 1, 6, 0), offset: -330 });
});

test('parseDate — RFC 2822, the Date header Gmail passes on', () => {
    assert.deepEqual(parseDate('Tue, 01 Sep 2026 10:00:00 +0200'), { epoch: Date.UTC(2026, 8, 1, 8, 0), offset: 120 });
    assert.deepEqual(parseDate('Wed, 13 May 2026 09:15:00 +0200 (CEST)'), { epoch: Date.UTC(2026, 4, 13, 7, 15), offset: 120 });
    assert.deepEqual(parseDate('1 Sep 2026 10:00 GMT'), { epoch: Date.UTC(2026, 8, 1, 10, 0), offset: null });
    assert.deepEqual(parseDate('1 sep 2026 10:00:00 EST'), { epoch: Date.UTC(2026, 8, 1, 15, 0), offset: -300 });
    assert.deepEqual(parseDate('01 Sep 2026 10:00:00'), { epoch: Date.UTC(2026, 8, 1, 10, 0), offset: null });
    assert.equal(parseDate('31 Feb 2026 10:00 GMT'), null, 'a day the month does not have');
    assert.equal(parseDate('1 Sep 2026 25:00 GMT'), null);
    assert.equal(parseDate('1 Sep 2026 10:00 CEST'), null, 'a zone name RFC 2822 does not define is not guessed');
    assert.equal(parseDate('Sep 2, 2026'), null, 'prose stays unread: Date.parse would read it differently per engine');
});

test('parseDate — unix timestamps: a number below 1e11 is seconds', () => {
    assert.equal(EPOCH_SECONDS_BELOW, 1e11);
    assert.equal(epochFromNumber(1756720800), 1756720800000);
    assert.equal(epochFromNumber(1757376000000), 1757376000000);
    assert.deepEqual(parseDate(1756720800), { epoch: 1756720800000, offset: null });
    assert.deepEqual(parseDate('1756720800'), { epoch: 1756720800000, offset: null });
    assert.deepEqual(parseDate('1756720800000'), { epoch: 1756720800000, offset: null });
    assert.equal(parseDate('20260901'), null, 'eight digits read as yyyymmdd by people, never as seconds');
    assert.equal(parseDate(NaN), null);
    assert.equal(parseDate(1757376000000000000), null, 'a nanosecond epoch is out of range, not a date');
});
