const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { buildExportHTML } = require('./exportTemplate');

const serverCopy = path.resolve(__dirname, '../assets/brand/BeeFlow-logo-Icon-2026.svg');
const frontendCopy = path.resolve(__dirname, '../../agent-hub/src/assets/BeeFlow-logo-Icon-2026.svg');

// The server image's build context is ./server, so the PDF export cannot
// read the logo from agent-hub. This copy must stay identical to the original.
test('the server logo is byte-identical to the agent-hub original', { skip: !fs.existsSync(frontendCopy) && 'agent-hub not present' }, () => {
    assert.ok(fs.readFileSync(serverCopy).equals(fs.readFileSync(frontendCopy)));
});

test('the export embeds the logo as a non-empty data URI', () => {
    const html = buildExportHTML('<p>Hi</p>', { title: 'Plan' });
    const m = html.match(/<img src="(data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+)" class="bee-logo"/);
    assert.ok(m, 'logo <img> is rendered instead of the emoji fallback');
    assert.ok(m[1].length > 'data:image/svg+xml;base64,'.length);
});
