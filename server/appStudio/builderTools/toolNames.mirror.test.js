// @typecheck
'use strict';

/**
 * The web's list of AI builder tool names
 * (agent-hub/.../AppStudio/chat/appToolNames.generated.json) is the names of
 * TOOL_SCHEMAS, in order. appToolCallDisplay.test.ts checks every name in it
 * has a verb, so a tool added here without a web list update would never be
 * asked for one.
 *
 * The list is generated, not hand-kept: `node scripts/gen-app-catalog.mjs --tools`
 * (from the repository root, needs server/node_modules). It cannot join
 * lint:shared-mirror because loading the schemas loads the document store.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { TOOL_SCHEMAS, REGISTRY_TOOL_VERBS } = require('./schemas');

const WEB_LIST = path.join(__dirname, '../../../agent-hub/src/components/admin/Studio/AppStudio/chat/appToolNames.generated.json');
const WEB_VERBS = path.join(__dirname, '../../../agent-hub/src/components/admin/Studio/AppStudio/chat/appToolVerbs.generated.json');

test('the web tool-name list is the TOOL_SCHEMAS names, in order', () => {
    const web = JSON.parse(fs.readFileSync(WEB_LIST, 'utf8'));
    const names = TOOL_SCHEMAS.map((s) => s.function.name);
    assert.deepEqual(web, names, 'stale: run `node scripts/gen-app-catalog.mjs --tools` from the repository root and commit the result');
});

test('the web verb list is the chat verb of every registry tool (builderTools/tools/)', () => {
    const web = JSON.parse(fs.readFileSync(WEB_VERBS, 'utf8'));
    assert.deepEqual(web, REGISTRY_TOOL_VERBS, 'stale: run `node scripts/gen-app-catalog.mjs --tools` from the repository root and commit the result');
});
