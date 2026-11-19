/**
 * The pure rules of the 2BA integration (twobaPricing.mts, twobaLines.mts):
 * codes, units, the price per use unit, the line total, the match of a line
 * and the summary. No I/O.
 *
 * Run: node --test integrations/twobaPricing.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const p = require('./twobaPricing.mts');
const lines = require('./twobaLines.mts');

/** A trade item as normaliseTradeItem gives it, with the fields a test cares about. */
function item(over = {}) {
    return p.normaliseTradeItem({
        Id: 1, TradeItemId: 'A-1', GTIN: '08712345678906', Description: 'Cable',
        UseUnitMeasureUnitCode: 'MTR', PriceUnitMeasureUnitCode: 'MTR', OrderUnitMeasureUnitCode: 'RO',
        NumberOfUnitsInPriceBasis: 100, QuantityOfUseUnits: 100, PackageTypeCode: 'RO', StatusCode: '126',
        CurrencyCode: 'EUR', ...over,
    });
}
const price = (over = {}) => p.normalisePrice({ NetPriceInPriceUnit: 125.5, NetPricePerUseUnit: 1.255, Scenario: 3, ConditionId: 7, TermsType: 'BC', ...over });

test('GLN and GTIN: 13 digits with the GS1 check digit; GTIN-8/12/13/14', () => {
    assert.equal(p.isValidGln('8711389000001'), true);
    assert.equal(p.isValidGln('8711389000002'), false);
    assert.equal(p.isValidGln('871138900000'), false);
    assert.equal(p.isValidGln('87113890000x1'), false);
    assert.equal(p.isValidGtin('04048357465826'), true);
    assert.equal(p.isValidGtin('4048357465826'), true);
    assert.equal(p.isValidGtin('4048357465827'), false);
    assert.equal(p.isValidGtin('96385074'), true);
    assert.equal(p.sameGtin('04048357465826', '4048357465826'), true);
    assert.equal(p.sameGtin('', ''), false);
});

test('bill-of-materials units normalise to UN/ECE rec 20 codes', () => {
    for (const u of ['m', 'M', 'mtr', 'meter', 'Meters', 'm.', ' mtr. ']) assert.equal(p.normaliseUnit(u), 'MTR', u);
    for (const u of ['st', 'stuk', 'stuks', 'pcs', 'PCE', 'EA', 'x', 'C62', 'h87']) assert.equal(p.normaliseUnit(u), 'C62', u);
    assert.equal(p.normaliseUnit('rol'), 'RO');
    assert.equal(p.normaliseUnit('doos'), 'BX');
    assert.equal(p.normaliseUnit('m2'), 'MTK');
    assert.equal(p.normaliseUnit('kg'), 'KGM');
    assert.equal(p.normaliseUnit('haspel'), null);
    assert.equal(p.normaliseUnit(''), null);
    assert.equal(p.sameUnit('C62', 'PCE'), true);
    assert.equal(p.sameUnit('EA', 'pce'), true);
    assert.equal(p.sameUnit('MTR', 'C62'), false);
    assert.equal(p.sameUnit(null, 'MTR'), false);
});

test('scenario as number and name, from either form', () => {
    assert.deepEqual(p.scenarioOf(3), { scenario: 3, scenarioName: 'DiscountGroupPercentage' });
    assert.deepEqual(p.scenarioOf('5'), { scenario: 5, scenarioName: 'OriginalGrossPrice' });
    assert.deepEqual(p.scenarioOf('onrequest'), { scenario: 6, scenarioName: 'OnRequest' });
    assert.deepEqual(p.scenarioOf(null), { scenario: null, scenarioName: null });
});

test('dates: /Date(ms)/ with or without an offset, ISO text, epoch ms', () => {
    assert.equal(p.isoDate('/Date(1700000000000)/'), '2023-11-14T22:13:20.000Z');
    assert.equal(p.isoDate('/Date(1700000000000+0100)/'), '2023-11-14T22:13:20.000Z');
    assert.equal(p.isoDate('2026-01-01T00:00:00Z'), '2026-01-01T00:00:00.000Z');
    assert.equal(p.isoDate(0), '1970-01-01T00:00:00.000Z');
    assert.equal(p.isoDate('soon'), null);
    assert.equal(p.isoDate(null), null);
});

test('cents: rounded once, half away from zero, without float noise', () => {
    assert.equal(p.roundCents(2.675), 2.68);
    assert.equal(p.roundCents(30 * 1.255), 37.65);
    assert.equal(p.roundCents(0.1 + 0.2), 0.3);
    assert.equal(p.roundCents(1.005), 1.01);
});

test('EUR X per 100 m, 30 m ordered: 30 x X/100', () => {
    const r = lines.priceLine(item(), price(), 30, 'm');
    assert.equal(r.unitNetPrice, 1.255);
    assert.equal(r.lineTotalExVat, 37.65);
    assert.deepEqual(r.flags, []);
});

test('a piece item: quantity x price per piece; the piece codes are one unit', () => {
    const piece = item({ UseUnitMeasureUnitCode: 'PCE', PriceUnitMeasureUnitCode: 'PCE', NumberOfUnitsInPriceBasis: 1 });
    const r = lines.priceLine(piece, price({ NetPriceInPriceUnit: 4.1, NetPricePerUseUnit: 4.1 }), 12, 'stuks');
    assert.equal(r.unitNetPrice, 4.1);
    assert.equal(r.lineTotalExVat, 49.2);
    assert.deepEqual(r.flags, []);
});

test('no unit on the line: the quantity counts in use units', () => {
    assert.equal(lines.priceLine(item(), price(), 10).lineTotalExVat, 12.55);
});

test('without NetPricePerUseUnit the price per use unit is derived from the price unit', () => {
    const r = lines.priceLine(item(), price({ NetPricePerUseUnit: null }), 30, 'm');
    assert.equal(r.unitNetPrice, 1.255);
    assert.equal(r.lineTotalExVat, 37.65);
});

test('price_calc_mismatch when the two ways differ by more than a cent; the 2BA figure is kept', () => {
    const r = lines.priceLine(item(), price({ NetPricePerUseUnit: 1.3 }), 30, 'm');
    assert.equal(r.unitNetPrice, 1.3);
    assert.ok(r.flags.includes('price_calc_mismatch'));
    assert.deepEqual(lines.priceLine(item(), price({ NetPricePerUseUnit: 1.26 }), 30, 'm').flags, []);
    // Price unit is not the use unit: nothing to compare.
    const boxed = item({ PriceUnitMeasureUnitCode: 'BX' });
    assert.deepEqual(lines.priceLine(boxed, price({ NetPricePerUseUnit: 9 }), 1).flags, []);
});

test('unit_unknown and unit_mismatch: flagged, and no line total', () => {
    const unknown = lines.priceLine(item(), price(), 30, 'haspel');
    assert.ok(unknown.flags.includes('unit_unknown'));
    assert.equal(unknown.lineTotalExVat, null);
    assert.equal(unknown.unitNetPrice, 1.255);
    const mismatch = lines.priceLine(item(), price(), 2, 'rol');
    assert.ok(mismatch.flags.includes('unit_mismatch'));
    assert.equal(mismatch.lineTotalExVat, null);
    const noUseUnit = lines.priceLine(item({ UseUnitMeasureUnitCode: null }), price(), 2, 'm');
    assert.ok(noUseUnit.flags.includes('unit_unknown'));
});

test('no price, a price on request, scenario 5 and 6, discontinued', () => {
    assert.deepEqual(lines.priceLine(item(), null, 3, 'm').flags, ['no_price']);
    assert.ok(lines.priceLine(item(), price({ NetPricePerUseUnit: 0, NetPriceInPriceUnit: 0 }), 3).flags.includes('no_price'));
    const onRequest = lines.priceLine(item({ PriceOnRequestIndicator: true }), price(), 3);
    assert.deepEqual(onRequest.flags, ['price_on_request']);
    assert.equal(onRequest.unitNetPrice, null);
    assert.equal(onRequest.lineTotalExVat, null);
    assert.ok(lines.priceLine(item(), price({ Scenario: 5 }), 1).flags.includes('gross_only_no_condition'));
    const six = lines.priceLine(item(), price({ Scenario: 6 }), 1);
    assert.ok(six.flags.includes('on_request'));
    assert.ok(!six.flags.includes('no_price'));
    const old = lines.priceLine(item({ StatusCode: '94E', SuccessorTradeItemCode: 'A-2' }), price(), 1);
    assert.ok(old.flags.includes('discontinued'));
    assert.equal(old.lineTotalExVat, 1.26);
});

test('no quantity: a unit price but no line total', () => {
    const r = lines.priceLine(item(), price());
    assert.equal(r.unitNetPrice, 1.255);
    assert.equal(r.lineTotalExVat, null);
});

test('match: one code, zero / one / several hits', () => {
    assert.equal(lines.classifyMatch([], undefined).status, 'not_found');
    assert.equal(lines.classifyMatch([item()], undefined).status, 'matched');
    const many = lines.classifyMatch(undefined, [item(), item({ Id: 2, PackageTypeCode: 'BX' })]);
    assert.equal(many.status, 'multiple');
    assert.deepEqual(many.flags, ['multiple_matches']);
    assert.equal(many.candidates.length, 2);
});

test('match: both codes agree, disagree, or one finds nothing', () => {
    const same = lines.classifyMatch([item()], [item()], '8712345678906');
    assert.equal(same.status, 'matched');
    assert.deepEqual(same.flags, []);
    const other = lines.classifyMatch([item()], [item({ Id: 9, TradeItemId: 'B-9' })], '8712345678906');
    assert.equal(other.status, 'code_mismatch');
    assert.deepEqual(other.flags, ['codes_disagree']);
    assert.equal(other.item.tradeItemId, 'A-1');
    // Same article number, another packaging (no internal ids to compare).
    const pack = lines.classifyMatch([item({ Id: null })], [item({ Id: null, PackageTypeCode: 'BX', QuantityOfUseUnits: 500 })], '');
    assert.equal(pack.status, 'code_mismatch');
    assert.deepEqual(lines.classifyMatch([item()], [], 'x').flags, ['gtin_not_found']);
    const byGtinOnly = lines.classifyMatch([], [item()], 'x');
    assert.equal(byGtinOnly.status, 'matched');
    assert.deepEqual(byGtinOnly.flags, ['trade_item_id_not_found']);
    assert.equal(lines.classifyMatch([], [], 'x').status, 'not_found');
});

test('match: several hits for the article number are narrowed by the GTIN', () => {
    const a = item({ Id: 1, GTIN: '08712345678906' });
    const b = item({ Id: 2, GTIN: '08712345678913' });
    const r = lines.classifyMatch([a, b], [b], '8712345678913');
    assert.equal(r.status, 'matched');
    assert.equal(r.item.id, 2);
    assert.equal(lines.classifyMatch([a, b], [], '').status, 'multiple');
});

test('summary: counts per status and flag, the total summed in cents', () => {
    const s = lines.summarise([
        { status: 'matched', flags: [], lineTotalExVat: 37.65, currency: 'EUR' },
        { status: 'matched', flags: ['unit_mismatch'], lineTotalExVat: null, currency: 'EUR' },
        { status: 'not_found', flags: [], lineTotalExVat: null },
        { status: 'matched', flags: [], lineTotalExVat: 0.1, currency: 'EUR' },
        { status: 'matched', flags: [], lineTotalExVat: 0.2, currency: 'EUR' },
    ]);
    assert.equal(s.items, 5);
    assert.deepEqual(s.byStatus, { matched: 4, not_found: 1, multiple: 0, code_mismatch: 0 });
    assert.deepEqual(s.byFlag, { unit_mismatch: 1 });
    assert.equal(s.pricedLines, 3);
    assert.equal(s.linesNeedingReview, 2);
    assert.equal(s.totalExVat, 37.95);
    assert.equal(s.currency, 'EUR');
});
