// @typecheck noImplicitAny
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { synthesizeLegacyContent } = require('./legacyContent');

const BAD = [
    { footer: { columns: 'x' } },
    { header: { nav: 'x' } },
    { header: { ctas: 'x' } },
    { footer: { columns: [{ links: 'x' }] } },
    { footer: { socials: 'x' } },
    { header: { nav: [{ label: 'A', children: 'x', dropdown: { layout: 'columns', columns: [{ items: 'x' }] } }] } },
    { footer: { columns: ['x', null, { heading: 'ok', links: [5] }] } },
];

for (const eff of BAD) {
    test(`a wrong-typed list does not throw: ${JSON.stringify(eff).slice(0, 60)}`, () => {
        assert.doesNotThrow(() => synthesizeLegacyContent({ page: { blocks: [] }, ...eff }));
    });
}

test('valid lists still flatten', () => {
    const out = synthesizeLegacyContent({
        page: { blocks: [] },
        footer: { columns: [{ heading: 'H', links: [{ label: 'L', link: { href: '/a' } }] }] },
    });
    assert.deepStrictEqual(out.footer.columns, [{ heading: 'H', links: [{ label: 'L', href: '/a' }] }]);
});
