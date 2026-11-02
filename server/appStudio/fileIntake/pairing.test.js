/**
 * Pairing a drawing with its CAD file when the drawing carries a sheet number
 * ("3906852-1.pdf" beside "3906852.stp"), and refusing to guess when the
 * numbering could just as well name variants.
 *
 * Run: cd server && node --test appStudio/fileIntake/pairing.test.js
 */

const test = require('node:test');
const assert = require('node:assert');

const { pairFiles } = require('./pairing');
const { isSheetOf } = require('./naming');

const file = (name, kind) => ({ name, baseName: name.replace(/\.[^.]+$/, '').toLowerCase(), kind, descriptor: null, folder: '' });
const cad = (name) => file(name, 'cad');
const drawing = (name) => file(name, 'drawing');
const pairsOf = (files) => pairFiles(files, {}).pairs;

test('a seven-digit part number pairs with its sheet-1 drawing, marked fuzzy', () => {
    for (const n of ['3906852', '3906878']) {
        const pairs = pairsOf([drawing(`${n}-1.pdf`), cad(`${n}.stp`)]);
        assert.strictEqual(pairs.length, 1, n);
        assert.strictEqual(pairs[0].cadName, `${n}.stp`);
        assert.strictEqual(pairs[0].drawingName, `${n}-1.pdf`);
        assert.strictEqual(pairs[0].matchStatus, 'fuzzy');
    }
});

test('two such parts in one batch each find their own drawing', () => {
    const pairs = pairsOf([drawing('3906852-1.pdf'), cad('3906852.stp'), drawing('3906878-1.pdf'), cad('3906878.stp')]);
    assert.deepStrictEqual(
        pairs.map((p) => [p.cadName, p.drawingName]).sort(),
        [['3906852.stp', '3906852-1.pdf'], ['3906878.stp', '3906878-1.pdf']],
    );
});

test('sheet spellings: "_01", " sheet 2", "-blad-3"', () => {
    for (const name of ['3906852_01.pdf', '3906852 sheet 2.pdf', '3906852-blad-3.pdf']) {
        const pairs = pairsOf([drawing(name), cad('3906852.stp')]);
        assert.strictEqual(pairs.length, 1, name);
        assert.strictEqual(pairs[0].drawingName, name);
    }
});

test('12345-1.pdf beside 12345.stp AND 12345-2.stp: no quiet choice', () => {
    const pairs = pairsOf([drawing('12345-1.pdf'), cad('12345.stp'), cad('12345-2.stp')]);
    assert.ok(pairs.every((p) => !(p.cadName && p.drawingName)), 'nothing paired');
    assert.strictEqual(pairs.length, 3, 'three lines, each on its own');
});

test('two numbered drawings of one CAD file are not split between quietly either', () => {
    const pairs = pairsOf([drawing('3906852-1.pdf'), drawing('3906852-2.pdf'), cad('3906852.stp')]);
    assert.ok(pairs.every((p) => !(p.cadName && p.drawingName)));
});

test('isSheetOf: needs five digits on the short side and a pure sheet suffix', () => {
    assert.strictEqual(isSheetOf('3906852-1', '3906852'), true);
    assert.strictEqual(isSheetOf('1234-1', '1234'), false, 'four digits is too little signal');
    assert.strictEqual(isSheetOf('3906852-123', '3906852'), false, 'three digits is a variant, not a sheet');
    assert.strictEqual(isSheetOf('3906852-rev-a', '3906852'), false);
    assert.strictEqual(isSheetOf('3906852', '3906852-1'), false, 'the drawing carries the sheet, not the CAD file');
    assert.strictEqual(isSheetOf('3906852', '3906852'), false);
});
