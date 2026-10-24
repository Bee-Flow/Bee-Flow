// @typecheck
const test = require('node:test');
const assert = require('node:assert');
const { buildExportHTML } = require('./exportTemplate');

test('the export HTML loads nothing from the network', () => {
    const html = buildExportHTML('<p>Hello</p><div data-type="mermaid-diagram" data-code="Z3JhcGggVEQ="></div>', { title: 'Plan' });
    assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i);
    assert.doesNotMatch(html, /<script[^>]+src=/i);
    assert.doesNotMatch(html, /@import|googleapis|jsdelivr/i);
    assert.match(html, /<p>Hello<\/p>/);
});

// Characterisation: the whole document, byte for byte (hash), for fixed input.
test('the export HTML is stable for fixed input', () => {
    const crypto = require('node:crypto');
    const html = buildExportHTML('<p>Hello</p>', { title: 'Plan <A>', author: 'Ann & Bo', date: '1 Jan 2026' });
    assert.strictEqual(crypto.createHash('sha256').update(html).digest('hex'), 'f2bac525de16ddf659578638fc4e2bda191fb954a5560c46d01320d09f6c2885');
    assert.match(html, /<title>Plan &lt;A&gt;<\/title>/);
});
