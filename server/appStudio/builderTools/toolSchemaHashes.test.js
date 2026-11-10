/**
 * The bytes of every builder tool schema, pinned against a list captured BEFORE the catalogue
 * got its extension tier (__tests__/toolSchemaHashes.base.json: sha256 of JSON.stringify per tool, the full
 * menu and the small band's core projection).
 *
 * What it guards: a catalogue entry marked since 3 moves no byte of a schema except the enum it
 * joins (after the base values) and app_inspect_catalog's two extension parameters. So with
 * empty registries every schema is byte-identical to the capture, and with entries the full
 * schemas are compared WITHOUT their extension tier (schemaTiers.stripExtensionTier): a feature
 * that adds a registry file does not touch this list. The core projection is the base in both
 * cases. schemaTiers.test.js runs the same comparison with entries in the catalogue.
 *
 * Only the tools in the capture are compared, so a NEW tool does not fail here. A red test after
 * a deliberate change to an existing schema (a parameter, a wording): check the diff is the one
 * you meant, then write the list again, from server/:
 *   node -e "require('node:fs').writeFileSync('appStudio/builderTools/__tests__/toolSchemaHashes.base.json', JSON.stringify(require('./testUtils/appCatalogExtensions.testkit').baseToolSchemaHashes(), null, 4) + '\n')"
 *
 * Run: node --test appStudio/builderTools/toolSchemaHashes.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const pinned = require('./__tests__/toolSchemaHashes.base.json');
const { baseToolSchemaHashes, pinnedOnly } = require('../../testUtils/appCatalogExtensions.testkit');
const { hasExtensions } = require('../catalogTiers.mts');
const { inspectExtensionPropsOf } = require('./schemaTiers.mts');

test('with no extension entry the schemas AS SENT are the capture: nothing is stripped to get there', (t) => {
    // app_inspect_catalog gains nothing from an empty tier (pure, so this holds whatever ships).
    assert.deepEqual(inspectExtensionPropsOf([]), {});
    if (hasExtensions()) return t.skip('the shipped catalogue has extension entries: the stripped comparison below is the pin');
    const crypto = require('node:crypto');
    const { TOOL_SCHEMAS } = require('./schemas');
    const raw = Object.fromEntries(TOOL_SCHEMAS.map((/** @type {any} */ tool) => [tool.function.name, crypto.createHash('sha256').update(JSON.stringify(tool)).digest('hex')]));
    assert.deepEqual(pinnedOnly(raw, pinned.full), pinned.full);
});

test('every pinned tool schema of the full menu is byte-identical to the capture', () => {
    assert.ok(Object.keys(pinned.full).length >= 47);
    assert.deepEqual(pinnedOnly(baseToolSchemaHashes().full, pinned.full), pinned.full);
});

test('every pinned tool schema of the core projection is byte-identical to the capture', () => {
    assert.ok(Object.keys(pinned.core).length >= 18);
    assert.deepEqual(pinnedOnly(baseToolSchemaHashes().core, pinned.core), pinned.core);
});
