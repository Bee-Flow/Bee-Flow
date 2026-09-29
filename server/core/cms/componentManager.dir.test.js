/**
 * Where the component runtime looks (core/cms/componentManager.js).
 *
 * The routes that create and edit components (routes/components.js,
 * routes/ai/agentChat.js) write to <repo>/components — /components in the
 * container. componentManager moved into core/cms/ and kept a path that was
 * right one directory up, so it scanned server/components: the shipped
 * components never loaded, and updateComponent wrote into a second copy.
 * Found by validation batch 2a.
 *
 * Run: cd server && node --test core/cms/componentManager.dir.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { COMPONENTS_DIR } = require('./componentManager');

const REPO_COMPONENTS = path.resolve(__dirname, '..', '..', '..', 'components');

test('the runtime reads the directory the component routes write to', () => {
    assert.strictEqual(COMPONENTS_DIR, REPO_COMPONENTS);
});

test('and in a checkout, that is where the shipped catalog is', { skip: !fs.existsSync(REPO_COMPONENTS) && 'components/ is not checked out here' }, () => {
    const shipped = fs.readdirSync(COMPONENTS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() && fs.existsSync(path.join(COMPONENTS_DIR, e.name, 'component.json')))
        .map((e) => e.name);
    assert.ok(shipped.includes('get-date-time'), `expected the shipped components, found: ${shipped.join(', ')}`);
    assert.ok(!COMPONENTS_DIR.startsWith(path.resolve(__dirname, '..', '..') + path.sep),
        'the runtime must not look inside server/');
});
