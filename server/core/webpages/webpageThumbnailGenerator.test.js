const test = require('node:test');
const assert = require('node:assert/strict');

// The store behind the generator pulls the database in at load; a recording pool stands in.
require('../../testUtils/routeHarness').recordDb();
const { composeDoc } = require('./webpageThumbnailGenerator');

test('composeDoc: the author\'s CSS and JS go into a full document byte for byte ("$&", "$$")', () => {
    const js = 'const esc = s => s.replace(/[.*+?]/g, "\\\\$&"); el.textContent = `$${total}`;';
    const css = 'a::after { content: "$$ $&"; }';
    const doc = composeDoc('<html><head><title>t</title></head><body><p>hi</p></body></html>', css, js);
    assert.ok(doc.includes(`<script>\n${js}\n</script>\n</body>`), doc);
    assert.ok(doc.includes(`<style>\n${css}\n</style>\n</head>`), doc);
});
