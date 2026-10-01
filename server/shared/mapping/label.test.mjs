/** label.mjs: readable keys and language-free label parts. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WILD } from './source.mjs';
import { humanizeKey, itemNoun, labelParts, labelText, singularLabel } from './label.mjs';

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

test('singularLabel reads a list name as one item, and leaves what it is not sure of', () => {
    assert.equal(singularLabel('Orderregels'), 'Orderregel');
    assert.equal(singularLabel('Order lines'), 'Order line');
    assert.equal(singularLabel('Categories'), 'Category');
    assert.equal(singularLabel('Addresses'), 'Address');
    assert.equal(singularLabel('Boxes'), 'Box');
    assert.equal(singularLabel('Messages'), 'Message');
    assert.equal(singularLabel('IBANs'), 'IBAN');
    for (const same of ['Klanten', 'Status', 'Data', 'Address', 'Bus', 'Ids', '']) assert.equal(singularLabel(same), same);
});

test('itemNoun names one item of a list after its last key', () => {
    assert.equal(itemNoun({ root: 'steps', id: 's1', path: ['orderregels'] }), 'Orderregel');
    assert.equal(itemNoun({ root: 'steps', id: 's1', path: ['orders', WILD, 'order_lines'] }), 'Order line');
    assert.equal(itemNoun({ root: 'steps', id: 's1', path: ['orders', 0] }), 'Order');
    assert.equal(itemNoun({ root: 'steps', id: 's1', path: [] }), null);
    assert.equal(itemNoun(null), null);
});
