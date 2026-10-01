/** label.mjs: readable keys and language-free label parts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WILD } from './source.mjs';
import { humanizeKey, labelParts, labelText } from './label.mjs';

test('humanizeKey reads identifiers as words and keeps what a person typed', () => {
    assert.equal(humanizeKey('first_name'), 'First name');
    assert.equal(humanizeKey('messageId'), 'Message ID');
    assert.equal(humanizeKey('htmlUrl'), 'HTML URL');
    assert.equal(humanizeKey('E-mail adres'), 'E-mail adres');
    assert.equal(humanizeKey('Order ID'), 'Order ID');
    assert.equal(humanizeKey('AFAS'), 'AFAS');
    assert.equal(humanizeKey('line-items'), 'Line-items');
    assert.equal(humanizeKey(''), '');
    assert.equal(humanizeKey(null), '');
});

test('labelParts never carries a path, a bracket or a [*]', () => {
    const parts = labelParts(['orders', WILD, 'unit_price']);
    assert.deepStrictEqual(parts, [{ key: 'orders', text: 'Orders' }, { each: true }, { key: 'unit_price', text: 'Unit price' }]);
    assert.deepStrictEqual(labelParts(['lines', 0]), [{ key: 'lines', text: 'Lines' }, { index: 0 }]);
    assert.deepStrictEqual(labelParts(null), []);
    assert.equal(labelText(parts), 'Orders › Unit price');
    assert.equal(labelText(labelParts(['Klant', 'Adres', 'Postcode']), ' / '), 'Klant / Adres / Postcode');
});
