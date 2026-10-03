import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseCellRef, cellName, columnName, columnIndex, isFormula,
    evaluateSheet, evaluateCell, referencedCells, formatValue,
    SHEET_ERRORS, SHEET_FUNCTIONS,
} from './sheet.mjs';

/** Evaluate one formula in a sheet (extra cells optional) and return its result. */
const f = (formula, cells = {}) => evaluateCell({ ...cells, AAA9: formula }, 'AAA9');
const val = (formula, cells) => f(formula, cells).value;
const err = (formula, cells) => f(formula, cells).error;

describe('addresses', () => {
    test('parseCellRef', () => {
        assert.deepEqual(parseCellRef('A1'), { col: 0, row: 0 });
        assert.deepEqual(parseCellRef('b3'), { col: 1, row: 2 });
        assert.deepEqual(parseCellRef('$C$10'), { col: 2, row: 9 });
        assert.deepEqual(parseCellRef('A$1'), { col: 0, row: 0 });
        assert.deepEqual(parseCellRef('$AA1'), { col: 26, row: 0 });
        assert.deepEqual(parseCellRef('XFD1048576'), { col: 16383, row: 1048575 });
        for (const bad of ['', 'A', '1', 'A0', 'A-1', 'XFE1', 'A1048577', 'AAAA1', 'A1B', '1A', 'A 1', null, undefined, 5]) {
            assert.equal(parseCellRef(bad), null, String(bad));
        }
    });
    test('columnName / columnIndex / cellName round-trip', () => {
        assert.equal(columnName(0), 'A');
        assert.equal(columnName(25), 'Z');
        assert.equal(columnName(26), 'AA');
        assert.equal(columnName(51), 'AZ');
        assert.equal(columnName(52), 'BA');
        assert.equal(columnName(701), 'ZZ');
        assert.equal(columnName(702), 'AAA');
        assert.equal(columnIndex('A'), 0);
        assert.equal(columnIndex('aa'), 26);
        assert.equal(columnIndex('1'), -1);
        for (let i = 0; i < 2000; i++) assert.equal(columnIndex(columnName(i)), i);
        assert.equal(cellName(0, 0), 'A1');
        assert.equal(cellName(27, 9), 'AB10');
    });
    test('isFormula', () => {
        assert.equal(isFormula('=1'), true);
        assert.equal(isFormula('='), true);
        assert.equal(isFormula(' =1'), false);
        assert.equal(isFormula('1'), false);
        assert.equal(isFormula(''), false);
        assert.equal(isFormula(null), false);
    });
});

describe('raw input classification', () => {
    const r = evaluateSheet({
        A1: '42', A2: ' -3.5 ', A3: '+1e3', A4: '.5', A5: 'TrUe', A6: 'false', A7: 'hello', A8: '1,5', A9: '', A10: '1e999', A11: '0x10', a12: '7',
    });
    test('types', () => {
        assert.equal(r.A1.value, 42);
        assert.equal(r.A2.value, -3.5);
        assert.equal(r.A3.value, 1000);
        assert.equal(r.A4.value, 0.5);
        assert.equal(r.A5.value, true);
        assert.equal(r.A6.value, false);
        assert.equal(r.A7.value, 'hello');
        assert.equal(r.A8.value, '1,5');
        assert.equal(r.A10.value, '1e999');
        assert.equal(r.A11.value, '0x10');
    });
    test('empty cells are omitted, keys are normalised', () => {
        assert.ok(!('A9' in r));
        assert.equal(r.A12.value, 7);
        assert.ok(!('a12' in r));
    });
    test('result shape', () => {
        assert.deepEqual(r.A5, { value: true, error: null, display: 'TRUE' });
        assert.deepEqual(evaluateSheet({ A1: 'x' }).A1, { value: 'x', error: null, display: 'x' });
    });
    test('invalid keys and non-string inputs are ignored / stringified', () => {
        const s = evaluateSheet({ nope: '1', A1: 5, B1: null, C1: undefined, D1: {} });
        assert.deepEqual(Object.keys(s), ['A1']);
        assert.equal(s.A1.value, 5);
        assert.deepEqual(evaluateSheet(null), {});
    });
    test('evaluateCell on empty / invalid names', () => {
        assert.deepEqual(evaluateCell({}, 'A1'), { value: null, error: null, display: '' });
        assert.equal(evaluateCell({}, 'nonsense').error, '#REF!');
        assert.equal(evaluateCell({ B2: '=1+1' }, '$b$2').value, 2);
    });
});

describe('operators and precedence', () => {
    test('basic arithmetic', () => {
        assert.equal(val('=2+3*4'), 14);
        assert.equal(val('=(2+3)*4'), 20);
        assert.equal(val('=10-4-3'), 3);
        assert.equal(val('=100/5/2'), 10);
        assert.equal(val('=7/2'), 3.5);
        assert.equal(val('=1.5e2+.5'), 150.5);
    });
    test('power is left-associative', () => {
        assert.equal(val('=2^3^2'), 64);
        assert.equal(val('=2^3*2'), 16);
        assert.equal(val('=2*3^2'), 18);
    });
    test('unary minus binds tighter than power, like Excel', () => {
        assert.equal(val('=-2^2'), 4);
        assert.equal(val('=2^-1'), 0.5);
        assert.equal(val('=--3'), 3);
        assert.equal(val('=+3'), 3);
        assert.equal(val('=3--2'), 5);
        assert.equal(val('=-(1+2)'), -3);
    });
    test('percent', () => {
        assert.equal(val('=50%'), 0.5);
        assert.equal(val('=200*10%'), 20);
        assert.equal(val('=50%%'), 0.005);
        assert.equal(val('=(1+1)%'), 0.02);
        assert.equal(val('=-50%'), -0.5);
    });
    test('concatenation sits below addition and above comparison', () => {
        assert.equal(val('="a"&"b"'), 'ab');
        assert.equal(val('="n="&1+2'), 'n=3');
        assert.equal(val('="a"&"b"="ab"'), true);
        assert.equal(val('=1&2'), '12');
        assert.equal(val('=TRUE&"x"'), 'TRUEx');
    });
    test('whitespace is free', () => {
        assert.equal(val('=  1 +\t2 '), 3);
        assert.equal(val('= SUM( 1 , 2 )'), 3);
    });
    test('string escapes', () => {
        assert.equal(val('="say ""hi"""'), 'say "hi"');
        assert.equal(val('=""'), '');
        assert.equal(val('=LEN("a""b")'), 3);
        assert.equal(err('="open'), '#ERROR!');
    });
    test('literals are case-insensitive', () => {
        assert.equal(val('=true'), true);
        assert.equal(val('=False'), false);
        assert.equal(val('=sum(1,2)'), 3);
    });
});

describe('comparison', () => {
    test('numbers', () => {
        assert.equal(val('=1=1'), true);
        assert.equal(val('=1<>1'), false);
        assert.equal(val('=1<2'), true);
        assert.equal(val('=2<=2'), true);
        assert.equal(val('=3>2'), true);
        assert.equal(val('=2>=3'), false);
        assert.equal(val('=0.1+0.2=0.3'), true);
        assert.equal(val('=1+1=2'), true);
    });
    test('text is case-insensitive', () => {
        assert.equal(val('="abc"="ABC"'), true);
        assert.equal(val('="a"<"B"'), true);
        assert.equal(val('="a"<>"A"'), false);
    });
    test('mixed types: numbers < text < booleans', () => {
        assert.equal(val('=5<"a"'), true);
        assert.equal(val('="a"<TRUE'), true);
        assert.equal(val('=1="1"'), false);
    });
    test('empty cell takes the other side type', () => {
        assert.equal(val('=A1=0'), true);
        assert.equal(val('=A1=""'), true);
        assert.equal(val('=A1=FALSE'), true);
        assert.equal(val('=A1=B1'), true);
        assert.equal(val('=A1<1'), true);
    });
});

describe('coercion', () => {
    test('empty = 0 in arithmetic, "" in concatenation', () => {
        assert.equal(val('=A1+5'), 5);
        assert.equal(val('="x"&A1&"y"'), 'xy');
        assert.equal(val('=A1'), 0);
        assert.equal(val('=A1*B1'), 0);
    });
    test('booleans in arithmetic', () => {
        assert.equal(val('=TRUE+TRUE'), 2);
        assert.equal(val('=FALSE*5'), 0);
        assert.equal(val('=A1+1', { A1: 'true' }), 2);
    });
    test('numeric text is coerced, other text is #VALUE!', () => {
        assert.equal(val('="3"+4'), 7);
        assert.equal(val('=" 2.5 "*2'), 5);
        assert.equal(val('=A1+1', { A1: '  12 ' }), 13);
        assert.equal(err('="abc"+1'), '#VALUE!');
        assert.equal(err('=A1+1', { A1: 'abc' }), '#VALUE!');
        assert.equal(err('=""+1'), '#VALUE!');
        assert.equal(err('=-"abc"'), '#VALUE!');
        assert.equal(err('="x"%'), '#VALUE!');
    });
    test('a formula returning text keeps being text', () => {
        const s = evaluateSheet({ A1: '="7"', B1: '=A1+1', C1: '=A1&"!"' });
        assert.equal(s.A1.value, '7');
        assert.equal(s.B1.value, 8);
        assert.equal(s.C1.value, '7!');
    });
    test('numbers concatenate in display form', () => {
        assert.equal(val('=(0.1+0.2)&""'), '0.3');
        assert.equal(val('=1/4&""'), '0.25');
    });
});

describe('cell references', () => {
    const cells = { A1: '1', B1: '2', A2: '3', B2: '4' };
    test('plain, absolute and mixed refs are the same cell', () => {
        for (const ref of ['B2', '$B$2', 'B$2', '$B2', 'b2']) assert.equal(val(`=${ref}`, cells), 4, ref);
    });
    test('references to formula cells', () => {
        const s = evaluateSheet({ A1: '2', B1: '=A1*10', C1: '=B1+A1' });
        assert.equal(s.C1.value, 22);
    });
    test('forward references work', () => {
        const s = evaluateSheet({ A1: '=B1+1', B1: '=C1+1', C1: '5' });
        assert.equal(s.A1.value, 7);
    });
    test('out of range reference is #REF!', () => {
        assert.equal(err('=XFE1'), '#REF!');
        assert.equal(err('=A1048577'), '#REF!');
        assert.equal(err('=A0'), '#REF!');
        assert.equal(err('=ABCDEF1'), '#REF!');
        assert.equal(err('=SUM(A1:XFE1)'), '#REF!');
        assert.equal(val('=XFD1048576'), 0);
    });
});

describe('ranges', () => {
    const cells = { A1: '1', B1: '2', A2: '3', B2: '4', C1: 'text', C2: '' };
    test('corner order is normalised', () => {
        for (const r of ['A1:B2', 'B2:A1', 'A2:B1', 'B1:A2', '$A$1:$B$2']) assert.equal(val(`=SUM(${r})`, cells), 10, r);
    });
    test('a bare range outside a function is #VALUE!', () => {
        assert.equal(err('=A1:B2', cells), '#VALUE!');
        assert.equal(err('=A1:B2+1', cells), '#VALUE!');
        assert.equal(err('=LEN(A1:B2)', cells), '#VALUE!');
        assert.equal(err('=IF(A1:B2,1,2)', cells), '#VALUE!');
    });
    test('malformed ranges are parse errors', () => {
        assert.equal(err('=SUM(A1:)'), '#ERROR!');
        assert.equal(err('=SUM(A1:5)'), '#ERROR!');
        assert.equal(err('=SUM(A:A)'), '#ERROR!');
    });
    test('ranges over formula cells', () => {
        const s = evaluateSheet({ A1: '=B1+1', B1: '=C1+1', C1: '5', D1: '=SUM(A1:C1)' });
        assert.equal(s.D1.value, 7 + 6 + 5);
    });
    test('sparse scan of a huge, mostly empty range', () => {
        assert.equal(val('=SUM(A1:Z1000)', { B2: '5', Y999: '6' }), 11);
    });
});

describe('functions', () => {
    const cells = { A1: '1', A2: '2', A3: '3', A4: 'x', A5: '', A6: 'TRUE', B1: '10' };
    test('SUM', () => {
        assert.equal(val('=SUM(A1:A6)', cells), 6);
        assert.equal(val('=SUM(A1:A3,B1,100)', cells), 116);
        assert.equal(val('=SUM()'), 0);
        assert.equal(val('=SUM("3",TRUE)'), 4);
        assert.equal(err('=SUM("abc")'), '#VALUE!');
        assert.equal(val('=SUM(A4)', cells), 0);
        assert.equal(val('=SUM(A5:A5)', cells), 0);
    });
    test('AVERAGE', () => {
        assert.equal(val('=AVERAGE(A1:A3)', cells), 2);
        assert.equal(val('=AVERAGE(A1:A6)', cells), 2);
        assert.equal(val('=AVERAGE(A1:A3,B1)', cells), 4);
        assert.equal(err('=AVERAGE(A4:A5)', cells), '#DIV/0!');
        assert.equal(err('=AVERAGE()'), '#DIV/0!');
    });
    test('MIN / MAX', () => {
        assert.equal(val('=MIN(A1:A6)', cells), 1);
        assert.equal(val('=MAX(A1:A6,B1)', cells), 10);
        assert.equal(val('=MIN(-5,A1:A3)', cells), -5);
        assert.equal(val('=MIN(A4:A5)', cells), 0);
        assert.equal(val('=MAX()'), 0);
    });
    test('COUNT counts numbers only, COUNTA non-empty', () => {
        assert.equal(val('=COUNT(A1:A6)', cells), 3);
        assert.equal(val('=COUNTA(A1:A6)', cells), 5);
        assert.equal(val('=COUNT(A1:A3,1,"2","x",TRUE)', cells), 6);
        assert.equal(val('=COUNTA(A1:A2,1,"")', cells), 4);
        assert.equal(val('=COUNTA(Q1:Q9)'), 0);
        assert.equal(val('=COUNT()'), 0);
    });
    test('COUNTA counts a formula that returns an empty string', () => {
        assert.equal(val('=COUNTA(A1:A2)', { A1: '=""' }), 1);
    });
    test('IF', () => {
        assert.equal(val('=IF(TRUE,1,2)'), 1);
        assert.equal(val('=IF(FALSE,1,2)'), 2);
        assert.equal(val('=IF(0,1,2)'), 2);
        assert.equal(val('=IF(5,"y","n")'), 'y');
        assert.equal(val('=IF(FALSE,1)'), false);
        assert.equal(val('=IF("TRUE",1,2)'), 1);
        assert.equal(val('=IF(A1,1,2)'), 2);
        assert.equal(err('=IF("maybe",1,2)'), '#VALUE!');
        assert.equal(err('=IF(1)'), '#ERROR!');
        assert.equal(err('=IF(1,2,3,4)'), '#ERROR!');
        assert.equal(val('=IF(1>2,"a",IF(2>1,"b","c"))'), 'b');
    });
    test('IF is lazy', () => {
        assert.equal(val('=IF(TRUE,1,1/0)'), 1);
        assert.equal(val('=IF(FALSE,1/0,2)'), 2);
        assert.equal(err('=IF(FALSE,1,1/0)'), '#DIV/0!');
        assert.equal(val('=IF(TRUE,1,NOPE(1))'), 1);
        assert.equal(val('=IF(TRUE,1,A1)', { A1: '=IF(TRUE,1,A1)' }), 1);
        assert.equal(val('=IF(TRUE,1,B1)', { B1: '=1/0' }), 1);
        assert.equal(err('=IF(FALSE,1,B1)', { B1: '=1/0' }), '#DIV/0!');
        // an untaken branch that would be circular is not a cycle
        const s = evaluateSheet({ A1: '=IF(TRUE,1,B1)', B1: '=A1' });
        assert.equal(s.A1.value, 1);
        assert.equal(s.B1.value, 1);
    });
    test('AND / OR / NOT', () => {
        assert.equal(val('=AND(TRUE,1,TRUE)'), true);
        assert.equal(val('=AND(TRUE,0)'), false);
        assert.equal(val('=OR(FALSE,0,1)'), true);
        assert.equal(val('=OR(FALSE,0)'), false);
        assert.equal(val('=NOT(TRUE)'), false);
        assert.equal(val('=NOT(0)'), true);
        assert.equal(val('=AND(A1:A6)', cells), true); // text and empty ignored in ranges
        assert.equal(val('=OR(A4:A5,TRUE)', cells), true);
        assert.equal(err('=AND(A4:A5)', cells), '#VALUE!'); // nothing logical at all
        assert.equal(err('=AND("x")'), '#VALUE!');
        assert.equal(err('=NOT("x")'), '#VALUE!');
        assert.equal(err('=NOT()'), '#ERROR!');
    });
    test('ROUND', () => {
        assert.equal(val('=ROUND(2.5)'), 3);
        assert.equal(val('=ROUND(-2.5)'), -3);
        assert.equal(val('=ROUND(2.675,2)'), 2.68);
        assert.equal(val('=ROUND(1.005,2)'), 1.01);
        assert.equal(val('=ROUND(1234.567,-2)'), 1200);
        assert.equal(val('=ROUND(3.14159,3)'), 3.142);
        assert.equal(val('=ROUND(1E-7,8)'), 1e-7);
        assert.equal(val('=ROUND(2.5,0.9)'), 3);
        assert.equal(val('=ROUND(-0.4)'), 0);
        assert.equal(Object.is(val('=ROUND(-0.4)'), -0), false);
        assert.equal(err('=ROUND("x")'), '#VALUE!');
        assert.equal(err('=ROUND(1,2,3)'), '#ERROR!');
    });
    test('ABS', () => {
        assert.equal(val('=ABS(-4.5)'), 4.5);
        assert.equal(val('=ABS(3)'), 3);
        assert.equal(val('=ABS(A1)'), 0);
    });
    test('CONCAT / CONCATENATE', () => {
        assert.equal(val('=CONCAT("a",1,TRUE)'), 'a1TRUE');
        assert.equal(val('=CONCATENATE("a","b")'), 'ab');
        assert.equal(val('=CONCAT(A1:A4)', cells), '123x');
        assert.equal(val('=CONCAT()'), '');
        assert.equal(val('=CONCAT(Q1)'), '');
    });
    test('LEN / UPPER / LOWER / TRIM', () => {
        assert.equal(val('=LEN("héllo")'), 5);
        assert.equal(val('=LEN(12345)'), 5);
        assert.equal(val('=LEN(A1)'), 0);
        assert.equal(val('=UPPER("abC")'), 'ABC');
        assert.equal(val('=LOWER("AbC")'), 'abc');
        assert.equal(val('=TRIM("  a   b  ")'), 'a b');
        assert.equal(val('=UPPER(TRUE)'), 'TRUE');
        assert.equal(err('=LEN()'), '#ERROR!');
        assert.equal(err('=LEN("a","b")'), '#ERROR!');
    });
    test('SHEET_FUNCTIONS lists exactly what is callable', () => {
        for (const name of SHEET_FUNCTIONS) {
            assert.notEqual(err(`=${name}()`), '#NAME?', name);
        }
        assert.equal(new Set(SHEET_FUNCTIONS).size, SHEET_FUNCTIONS.length);
        assert.ok(SHEET_FUNCTIONS.includes('CONCATENATE'));
        assert.throws(() => SHEET_FUNCTIONS.push('X'));
    });
});

describe('error codes', () => {
    test('#DIV/0!', () => {
        assert.equal(err('=1/0'), '#DIV/0!');
        assert.equal(err('=1/A1'), '#DIV/0!');
        assert.equal(err('=0^-1'), '#DIV/0!');
        assert.equal(err('=AVERAGE()'), '#DIV/0!');
    });
    test('#NAME?', () => {
        assert.equal(err('=NOPE(1)'), '#NAME?');
        assert.equal(err('=constructor(1)'), '#NAME?');
        assert.equal(err('=toString()'), '#NAME?');
        assert.equal(err('=FOO'), '#NAME?');
        assert.equal(err('=1+bar'), '#NAME?');
    });
    test('#REF!', () => {
        assert.equal(err('=ZZZ1'), '#REF!');
    });
    test('#ERROR!', () => {
        for (const bad of ['=', '=1+', '=(1', '=1)', '=1 2', '=SUM(1,)', '=SUM(,1)', '=*2', '=1..2', '=@', '=A1:B2:C3', '=1;2', "='a'", '=SUM(1', '=#REF!']) {
            assert.equal(err(bad), '#ERROR!', bad);
        }
    });
    test('#VALUE!', () => {
        assert.equal(err('="a"*2'), '#VALUE!');
    });
    test('#NUM! for overflow and impossible math', () => {
        assert.equal(err('=10^400'), '#NUM!');
        assert.equal(err('=(-8)^0.5'), '#NUM!');
        assert.equal(err('=0^0'), '#NUM!');
        assert.equal(err('=1E308*10'), '#NUM!');
    });
    test('#CIRC!', () => {
        assert.equal(evaluateSheet({ A1: '=A1' }).A1.error, '#CIRC!');
    });
    test('SHEET_ERRORS lists them all and is frozen', () => {
        for (const code of ['#VALUE!', '#DIV/0!', '#NAME?', '#REF!', '#ERROR!', '#CIRC!']) assert.ok(SHEET_ERRORS.includes(code), code);
        assert.ok(Object.isFrozen(SHEET_ERRORS));
    });
    test('error cell display is the code and value is null', () => {
        assert.deepEqual(f('=1/0'), { value: null, error: '#DIV/0!', display: '#DIV/0!' });
    });
});

describe('error propagation', () => {
    test('through references', () => {
        const s = evaluateSheet({ A1: '=1/0', B1: '=A1+1', C1: '=B1*2', D1: '=NOPE()', E1: '=D1&"x"' });
        assert.equal(s.B1.error, '#DIV/0!');
        assert.equal(s.C1.error, '#DIV/0!');
        assert.equal(s.E1.error, '#NAME?');
    });
    test('through ranges and aggregates', () => {
        const s = evaluateSheet({ A1: '1', A2: '=1/0', A3: '3', B1: '=SUM(A1:A3)', B2: '=COUNT(A1:A3)', B3: '=CONCAT(A1:A3)' });
        assert.equal(s.B1.error, '#DIV/0!');
        assert.equal(s.B2.error, '#DIV/0!');
        assert.equal(s.B3.error, '#DIV/0!');
    });
    test('through comparison and IF condition', () => {
        assert.equal(err('=A1=1', { A1: '=1/0' }), '#DIV/0!');
        assert.equal(err('=IF(A1,1,2)', { A1: '=1/0' }), '#DIV/0!');
    });
    test('text that merely looks like an error code is plain text', () => {
        const s = evaluateSheet({ A1: '#DIV/0!', B1: '=A1&"?"' });
        assert.equal(s.A1.error, null);
        assert.equal(s.B1.value, '#DIV/0!?');
    });
});

describe('circular references', () => {
    test('direct two-cell cycle', () => {
        const s = evaluateSheet({ A1: '=B1', B1: '=A1' });
        assert.equal(s.A1.error, '#CIRC!');
        assert.equal(s.B1.error, '#CIRC!');
        assert.equal(s.A1.display, '#CIRC!');
    });
    test('self reference', () => {
        assert.equal(evaluateSheet({ A1: '=A1+1' }).A1.error, '#CIRC!');
        assert.equal(evaluateCell({ A1: '=SUM(A1:A3)' }, 'A1').error, '#CIRC!');
    });
    test('indirect cycle, dependents and bystanders', () => {
        const s = evaluateSheet({ A1: '=B1+1', B1: '=C1+1', C1: '=A1+1', D1: '=A1+1', E1: '=5', F1: '=E1*2' });
        for (const n of ['A1', 'B1', 'C1']) assert.equal(s[n].error, '#CIRC!', n);
        assert.equal(s.D1.error, '#CIRC!'); // reads a cycle cell, so it shows the same error
        assert.equal(s.E1.value, 5);
        assert.equal(s.F1.value, 10);
    });
    test('cycle through a range', () => {
        const s = evaluateSheet({ A1: '=SUM(B1:B2)', B2: '=A1' });
        assert.equal(s.A1.error, '#CIRC!');
        assert.equal(s.B2.error, '#CIRC!');
    });
    test('a cell that only feeds a cycle is not part of it', () => {
        const s = evaluateSheet({ A1: '=B1+C1', B1: '=A1', C1: '=7' });
        assert.equal(s.A1.error, '#CIRC!');
        assert.equal(s.B1.error, '#CIRC!');
        assert.equal(s.C1.value, 7);
    });
    test('two cycles sharing a cell', () => {
        const s = evaluateSheet({ A1: '=B1+C1', B1: '=A1', C1: '=A1' });
        for (const n of ['A1', 'B1', 'C1']) assert.equal(s[n].error, '#CIRC!', n);
    });
    test('diamond dependencies are not cycles', () => {
        const s = evaluateSheet({ A1: '1', B1: '=A1+1', C1: '=A1+2', D1: '=B1+C1', E1: '=D1+B1+C1' });
        assert.equal(s.D1.value, 5);
        assert.equal(s.E1.value, 10);
    });
});

describe('scale and limits', () => {
    test('a long dependency chain does not overflow the stack', () => {
        const cells = { A1: '1' };
        for (let i = 2; i <= 2000; i++) cells[`A${i}`] = `=A${i - 1}+1`;
        assert.equal(evaluateSheet(cells).A2000.value, 2000);
        assert.equal(evaluateCell(cells, 'A2000').value, 2000);
    });
    test('chain defined in reverse order, and much longer', () => {
        const n = 30000;
        const cells = {};
        for (let i = n; i >= 2; i--) cells[`A${i}`] = `=A${i - 1}+1`;
        cells.A1 = '1';
        assert.equal(evaluateSheet(cells)[`A${n}`].value, n);
    });
    test('a long chain that ends in a cycle', () => {
        const cells = { A1: '=A5000' };
        for (let i = 2; i <= 5000; i++) cells[`A${i}`] = `=A${i - 1}+1`;
        const s = evaluateSheet(cells);
        assert.equal(s.A1.error, '#CIRC!');
        assert.equal(s.A5000.error, '#CIRC!');
    });
    test('a wide fan-in over a range', () => {
        const cells = {};
        for (let i = 1; i <= 3000; i++) { cells[`A${i}`] = String(i); cells[`B${i}`] = `=A${i}*2`; }
        cells.C1 = '=SUM(B1:B3000)';
        assert.equal(evaluateSheet(cells).C1.value, 3000 * 3001);
    });
    test('formula length limit', () => {
        const ok = `=${'1+'.repeat(999)}1`; // 1999 chars after '='
        assert.equal(val(ok), 1000);
        const exact = `=${'1'.repeat(2000)}`;
        assert.notEqual(err(exact), '#ERROR!');
        assert.equal(err(`=${'1'.repeat(2001)}`), '#ERROR!');
        assert.equal(err(`=${' '.repeat(2001)}1`), '#ERROR!');
    });
    test('range size limit', () => {
        assert.equal(val('=SUM(A1:A50000)'), 0);
        assert.equal(err('=SUM(A1:A50001)'), '#REF!');
        assert.equal(val('=COUNTA(A1:AX1000)'), 0); // 50 * 1000 = 50000, still allowed
        assert.equal(err('=COUNTA(A1:AY1000)'), '#REF!'); // 51 * 1000
    });
    test('nesting depth limit', () => {
        const nest = (n) => `=${'('.repeat(n)}1${')'.repeat(n)}`;
        assert.equal(val(nest(100)), 1);
        assert.equal(err(nest(101)), '#ERROR!');
        assert.equal(val(`=${'-'.repeat(100)}1`), 1);
        assert.equal(err(`=${'-'.repeat(101)}1`), '#ERROR!');
        assert.equal(val(`=${'ABS('.repeat(100)}1${')'.repeat(100)}`), 1);
        assert.equal(err(`=${'ABS('.repeat(101)}1${')'.repeat(101)}`), '#ERROR!');
        assert.equal(err(`=${'('.repeat(1000)}1${')'.repeat(1000)}`), '#ERROR!');
    });
    test('very long flat operator chain still evaluates', () => {
        assert.equal(val(`=${'1+'.repeat(900)}1`), 901);
    });
    test('hostile input never throws', () => {
        const junk = ['=\u0000', '=((((', '="', '=A1:A1:A1', '=SUM(', '=)', '=,', '=1e', '=__proto__', '=A1.B1', '=\u{1F600}'];
        for (const j of junk) assert.doesNotThrow(() => evaluateSheet({ A1: j }), j);
    });
    test('__proto__ and friends are not cells', () => {
        const s = evaluateSheet(JSON.parse('{"__proto__":"1","A1":"=__proto__"}'));
        assert.deepEqual(Object.keys(s), ['A1']);
        assert.equal(s.A1.error, '#NAME?');
    });
});

describe('formatValue', () => {
    test('numbers', () => {
        assert.equal(formatValue(0.1 + 0.2), '0.3');
        assert.equal(formatValue(1 / 3), '0.3333333333');
        assert.equal(formatValue(2 / 3), '0.6666666667');
        assert.equal(formatValue(5), '5');
        assert.equal(formatValue(-0), '0');
        assert.equal(formatValue(1e-12), '0');
        assert.equal(formatValue(-1e-12), '0');
        assert.equal(formatValue(100), '100');
        assert.equal(formatValue(1234567.5), '1234567.5');
        assert.equal(formatValue(1e21), '1e+21');
        assert.equal(formatValue(Infinity), '#NUM!');
    });
    test('other types', () => {
        assert.equal(formatValue(true), 'TRUE');
        assert.equal(formatValue(false), 'FALSE');
        assert.equal(formatValue('hi'), 'hi');
        assert.equal(formatValue(null), '');
        assert.equal(formatValue(undefined), '');
        assert.equal(formatValue(null, '#REF!'), '#REF!');
    });
    test('the raw value stays a plain double, only the display is rounded', () => {
        const r = f('=0.1+0.2');
        assert.equal(r.value, 0.1 + 0.2);
        assert.equal(r.display, '0.3');
    });
});

describe('referencedCells', () => {
    test('scalars, ranges, absolute refs, dedupe, order', () => {
        assert.deepEqual(referencedCells('=A1+$B$2+a1'), ['A1', 'B2']);
        assert.deepEqual(referencedCells('=SUM(A1:B2)'), ['A1', 'B1', 'A2', 'B2']);
        assert.deepEqual(referencedCells('=SUM(B2:A1)+C3'), ['A1', 'B1', 'A2', 'B2', 'C3']);
        assert.deepEqual(referencedCells('=IF(A1,B1,C1)'), ['A1', 'B1', 'C1']);
        assert.deepEqual(referencedCells('=-A1%&"A2"'), ['A1']);
    });
    test('non-formulas, parse errors and bad refs', () => {
        assert.deepEqual(referencedCells('A1'), []);
        assert.deepEqual(referencedCells(''), []);
        assert.deepEqual(referencedCells('=A1+'), []);
        assert.deepEqual(referencedCells('=XFE1+A1'), ['A1']);
        assert.deepEqual(referencedCells(null), []);
    });
    test('huge ranges are not expanded', () => {
        assert.deepEqual(referencedCells('=SUM(A1:A50001)+B1'), ['B1']);
        assert.equal(referencedCells('=SUM(A1:A50000)').length, 50000);
    });
});
