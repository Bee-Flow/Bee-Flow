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
