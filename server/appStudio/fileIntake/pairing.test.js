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
const { partTokens, samePartByTokens } = require('./partTokens.mts');

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

// ── Last tier: the same part in different words (partTokens.mts) ─────────────

test('"<name>_drawing.pdf" beside "<name>_8mm.dxf": seven parts, seven fuzzy pairs', () => {
    const names = ['base_back', 'base_front', 'side_left', 'side_right', 'top_plate', 'bottom_plate', 'rib_middle'];
    const files = names.flatMap((n) => [drawing(`${n}_drawing.pdf`), cad(`${n}_8mm.dxf`)]);
    const pairs = pairsOf(files);
    assert.equal(pairs.length, 7);
    for (const n of names) {
        const p = pairs.find((x) => x.cadName === `${n}_8mm.dxf`);
        assert.equal(p?.drawingName, `${n}_drawing.pdf`, n);
        assert.equal(p.matchStatus, 'fuzzy');
    }
});

test('a CAD name with one extra word inside a long identical name pairs, marked fuzzy', () => {
    const d = '202699001_J-100200_SIDE PLATE CUTTING DRAWING_120 x 80 x 6_REV--.pdf';
    const c = '202699001_J-100200_LASER_SIDE PLATE CUTTING DRAWING_120 x 80 x 6_REV--.stp';
    const pairs = pairsOf([drawing(d), cad(c)]);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0].drawingName, pairs[0].cadName, pairs[0].matchStatus], [d, c, 'fuzzy']);
});

test('"part_a_drawing.pdf" beside "part_a_5mm.dxf" AND "part_a_8mm.dxf" stays unpaired', () => {
    const pairs = pairsOf([drawing('part_a_drawing.pdf'), cad('part_a_5mm.dxf'), cad('part_a_8mm.dxf')]);
    assert.equal(pairs.length, 3);
    assert.ok(pairs.every((p) => !(p.cadName && p.drawingName)));
});

test('two drawings that both fit one CAD file: no quiet choice', () => {
    const pairs = pairsOf([drawing('bracket_drawing.pdf'), drawing('bracket_tekening.pdf'), cad('bracket_6mm.dxf')]);
    assert.ok(pairs.every((p) => !(p.cadName && p.drawingName)));
});

test('one shared word is not enough of a part number; nor is an extra NUMBER', () => {
    assert.equal(pairsOf([drawing('plate_drawing.pdf'), cad('plate_8mm.dxf')]).some((p) => p.cadName && p.drawingName), false);
    assert.equal(samePartByTokens('12345-1', '12345'), false, 'a sheet or variant number is never "one more word"');
    assert.equal(samePartByTokens('99887_drawing', '99887_t6'), true, 'five digits are enough');
});

test('partTokens drops kind-of-file words, sheet, revision and thickness', () => {
    assert.deepEqual(partTokens('202699001-j-100200-side-plate-cutting-drawing-120-x-80-x-6-rev'),
        ['202699001', 'j', '100200', 'side', 'plate', 'cutting', '120', '80', '6']);
    assert.deepEqual(partTokens('frame-sheet-2-rev-b-8.5mm'), ['frame']);
    assert.deepEqual(partTokens('frame-blad1-revisiec-t10-dwg'), ['frame']);
});

test('exact, prefix and sheet-number pairs are unchanged by the last tier', () => {
    const pairs = pairsOf([
        drawing('TN2306-06-9100-001.pdf'), cad('TN2306-06-9100-001.step'),
        drawing('3906852-1.pdf'), cad('3906852.stp'),
    ]);
    const by = new Map(pairs.map((p) => [p.cadName, p]));
    assert.equal(by.get('TN2306-06-9100-001.step').matchStatus, 'exact');
    assert.equal(by.get('3906852.stp').drawingName, '3906852-1.pdf');
});

test('isSheetOf: needs five digits on the short side and a pure sheet suffix', () => {
    assert.strictEqual(isSheetOf('3906852-1', '3906852'), true);
    assert.strictEqual(isSheetOf('1234-1', '1234'), false, 'four digits is too little signal');
    assert.strictEqual(isSheetOf('3906852-123', '3906852'), false, 'three digits is a variant, not a sheet');
    assert.strictEqual(isSheetOf('3906852-rev-a', '3906852'), false);
    assert.strictEqual(isSheetOf('3906852', '3906852-1'), false, 'the drawing carries the sheet, not the CAD file');
    assert.strictEqual(isSheetOf('3906852', '3906852'), false);
});
