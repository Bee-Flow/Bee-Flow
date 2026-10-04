import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCell, evaluateSheet } from './sheet.mjs';

/** Evaluate one formula in a sheet (extra cells optional) and return its result. */
const f = (formula, cells = {}) => evaluateCell({ ...cells, AAA9: formula }, 'AAA9');
const val = (formula, cells) => f(formula, cells).value;
const err = (formula, cells) => f(formula, cells).error;

describe('IFERROR', () => {
    test('returns the value when there is no error', () => {
        assert.equal(val('=IFERROR(1+2, 99)'), 3);
    });
    test('returns the fallback on any formula error', () => {
        assert.equal(val('=IFERROR(1/0, 99)'), 99);
        assert.equal(val('=IFERROR(FOO, 99)'), 99);
        assert.equal(val('=IFERROR(A1, 99)', { A1: '=1/0' }), 99);
    });
});

describe('VLOOKUP', () => {
    const cells = {
        A1: 'apple', B1: '1',
        A2: 'banana', B2: '2',
        A3: 'cherry', B3: '3',
    };
    test('exact match', () => {
        assert.equal(val('=VLOOKUP("banana", A1:B3, 2, FALSE)', cells), 2);
    });
    test('exact match with omitted range_lookup', () => {
        assert.equal(val('=VLOOKUP("banana", A1:B3, 2)', cells), 2);
    });
    test('approximate match on sorted first column', () => {
        const nums = { A1: '10', B1: 'ten', A2: '20', B2: 'twenty', A3: '30', B3: 'thirty' };
        assert.equal(val('=VLOOKUP(25, A1:B3, 2, TRUE)', nums), 'twenty');
    });
    test('no exact match gives #N/A', () => {
        assert.equal(err('=VLOOKUP("pear", A1:B3, 2, FALSE)', cells), '#N/A');
    });
    test('column index out of range gives #REF!', () => {
        assert.equal(err('=VLOOKUP("apple", A1:B3, 5, FALSE)', cells), '#REF!');
    });
});

describe('COUNTIF / COUNTIFS', () => {
    const cells = {
        A1: '1', A2: '2', A3: '3', A4: 'apple', A5: 'banana', A6: '5',
    };
    test('COUNTIF numeric comparison', () => {
        assert.equal(val('=COUNTIF(A1:A6, ">2")', cells), 2);
    });
    test('COUNTIF equality with number', () => {
        assert.equal(val('=COUNTIF(A1:A6, 5)', cells), 1);
    });
    test('COUNTIF wildcard text', () => {
        assert.equal(val('=COUNTIF(A1:A6, "*a*")', cells), 2);
    });
    test('COUNTIFS multiple criteria', () => {
        const table = { A1: '1', B1: 'x', A2: '2', B2: 'x', A3: '3', B3: 'y' };
        assert.equal(val('=COUNTIFS(A1:A3, ">1", B1:B3, "x")', table), 1);
    });
});

describe('SUMIF / SUMIFS / AVERAGEIF / AVERAGEIFS', () => {
    const cells = {
        A1: 'apple', B1: '10',
        A2: 'banana', B2: '20',
        A3: 'apple', B3: '30',
    };
    test('SUMIF with criteria and sum range', () => {
        assert.equal(val('=SUMIF(A1:A3, "apple", B1:B3)', cells), 40);
    });
    test('SUMIF defaults sum range to criteria range', () => {
        assert.equal(val('=SUMIF(B1:B3, ">15")', cells), 50);
    });
    test('SUMIFS multiple criteria', () => {
        const table = {
            A1: 'apple', B1: 'red', C1: '10',
            A2: 'apple', B2: 'green', C2: '20',
            A3: 'banana', B3: 'yellow', C3: '30',
        };
        assert.equal(val('=SUMIFS(C1:C3, A1:A3, "apple", B1:B3, "green")', table), 20);
    });
    test('AVERAGEIF', () => {
        assert.equal(val('=AVERAGEIF(A1:A3, "apple", B1:B3)', cells), 20);
    });
    test('AVERAGEIFS', () => {
        const table = {
            A1: 'x', B1: '1', C1: '10',
            A2: 'x', B2: '2', C2: '20',
            A3: 'y', B3: '1', C3: '30',
        };
        assert.equal(val('=AVERAGEIFS(C1:C3, A1:A3, "x", B1:B3, "1")', table), 10);
    });
    test('no matches gives #DIV/0! for averages', () => {
        assert.equal(err('=AVERAGEIF(A1:A3, "pear", B1:B3)', cells), '#DIV/0!');
    });
});

describe('ROUNDUP / ROUNDDOWN', () => {
    test('ROUNDUP away from zero', () => {
        assert.equal(val('=ROUNDUP(1.2, 0)'), 2);
        assert.equal(val('=ROUNDUP(-1.2, 0)'), -2);
        assert.equal(val('=ROUNDUP(1.234, 2)'), 1.24);
    });
    test('ROUNDDOWN toward zero', () => {
        assert.equal(val('=ROUNDDOWN(1.8, 0)'), 1);
        assert.equal(val('=ROUNDDOWN(-1.8, 0)'), -1);
        assert.equal(val('=ROUNDDOWN(1.236, 2)'), 1.23);
    });
});

describe('TEXTJOIN', () => {
    test('joins values and ranges with a delimiter', () => {
        assert.equal(val('=TEXTJOIN(",", TRUE, "a", "b", "c")'), 'a,b,c');
    });
    test('ignores empty cells when asked', () => {
        const cells = { A1: 'a', A2: '', A3: 'b' };
        assert.equal(val('=TEXTJOIN("-", TRUE, A1:A3)', cells), 'a-b');
    });
    test('keeps empty cells when asked', () => {
        const cells = { A1: 'a', A2: '', A3: 'b' };
        assert.equal(val('=TEXTJOIN("-", FALSE, A1:A3)', cells), 'a--b');
    });
});

describe('date functions', () => {
    const fixed = new Date(Date.UTC(2026, 9, 3, 14, 30, 0)); // 2026-10-03

    test('DATE returns an Excel serial date', () => {
        const serial = val('=DATE(2026, 10, 3)');
        assert.equal(serial, 46298);
    });
    test('YEAR/MONTH/DAY read a serial date', () => {
        const cells = { A1: '46298' };
        assert.equal(val('=YEAR(A1)', cells), 2026);
        assert.equal(val('=MONTH(A1)', cells), 10);
        assert.equal(val('=DAY(A1)', cells), 3);
    });
    test('TODAY returns the current date as a serial', () => {
        const serial = evaluateSheet({ A1: '=TODAY()' }, { now: fixed }).A1.value;
        assert.equal(serial, 46298);
    });
    test('NOW returns the current date-time as a serial', () => {
        const serial = evaluateSheet({ A1: '=NOW()' }, { now: fixed }).A1.value;
        assert.ok(typeof serial === 'number');
        assert.ok(serial > 46297 && serial < 46299);
    });
});
