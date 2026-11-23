'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chartFieldsOf } = require('./sheetChartFields');

test('chartFieldsOf stores ranges and the anchor as grid cell names', () => {
    const out = chartFieldsOf({ type: 'bar', dataRange: ' $b$2:c4 ', categoriesRange: 'a2:$A$4', anchor: '$e$20' });
    assert.equal(out.dataRange, 'B2:C4');
    assert.equal(out.categoriesRange, 'A2:A4');
    assert.equal(out.anchor, 'E20');
});
