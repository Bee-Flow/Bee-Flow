// @typecheck
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

test('a github header button reaches the renderer with its own fields', () => {
    const out = synthesizeLegacyContent({
        page: { blocks: [] },
        header: {
            ctas: [
                { id: 'g', kind: 'github', label: 'GitHub', repoUrl: 'https://github.com/example/repo', starsFallback: 12, starsText: 'sterren', newTabText: 'opent in nieuw tabblad', style: 'ghost' },
                { id: 'l', label: 'Book', link: { href: '/demo' } },
            ],
        },
    });
    const [github, plain] = out.header.ctas;
    assert.strictEqual(github.kind, 'github');
    assert.strictEqual(github.repoUrl, 'https://github.com/example/repo');
    assert.strictEqual(github.starsFallback, 12);
    assert.strictEqual(github.starsText, 'sterren');
    assert.strictEqual(github.newTabText, 'opent in nieuw tabblad');
    assert.strictEqual(plain.kind, undefined);
    assert.strictEqual(plain.repoUrl, undefined);
});
