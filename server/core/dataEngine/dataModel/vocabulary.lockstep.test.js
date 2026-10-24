/**
 * The source grammar of a model table is found in THREE places, and this file keeps them
 * tied together.
 *
 *   1. core/dataEngine/dataModel/vocabulary.js: THE source
 *   2. server side: appStudio/validate/refs.js, appStudio/dataModel/modelValidate.js and
 *      appStudio/datatableSource.js import (1) and are therefore by definition in step
 *   3. agent-hub/.../tables/tablesManagerModel.ts: a LITERAL copy, because there is no shared
 *      vocabulary module between server and client
 *
 * Copy 3 cannot import, so it is READ here. Without this test the drift is silent: add a third
 * mode tomorrow and the validator accepts it while the screen calls it "Unknown access" and the
 * rights layer refuses the whole table with a 422, an error that surfaces only when a user opens
 * the app. The direction is safe (narrowing), but safe-and-silent is exactly the kind of error
 * that stays lying around for a year.
 *
 * Same pattern as server/automation/notificationDefaults.test.js, which for the same reason reads
 * an agent-hub file.
 *
 * Run: cd server && node --test --test-reporter=tap core/dataEngine/dataModel/vocabulary.lockstep.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    TABLE_SOURCE_KINDS,
    TABLE_SOURCE_MODES,
    WRITABLE_TABLE_SOURCE_MODE,
} = require('./vocabulary');

// Sinds de split van TablesManager staan de modes en sourceIsWritable in het
// model-bestand naast het scherm.
const TABLES_MANAGER = path.resolve(
    __dirname, '../../../../agent-hub/src/components/admin/Studio/AppStudio/tables/tablesManagerModel.ts',
);

/** De letterlijke `const NAME = ['a', 'b'];` uit een agent-hub-bestand. */
function arrayLiteral(source, name) {
    const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source);
    assert.ok(m, `${name} niet gevonden in tablesManagerModel.ts — is hij hernoemd?`);
    return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

test('TablesManager kent exact dezelfde modes als het vocabulaire', () => {
    // Genuinely textual, as the file header already says: a .jsx file in agent-hub cannot be
    // require'd here (no JSX transform, no DOM), and that is precisely why copy 3 is a literal
    // copy rather than an import: there is nothing to call.
    const src = fs.readFileSync(TABLES_MANAGER, 'utf8');
    assert.deepEqual(arrayLiteral(src, 'TABLE_SOURCE_MODES'), [...TABLE_SOURCE_MODES]);
});

test('TablesManager noemt dezelfde ENE schrijfbare mode en dezelfde kind', () => {
    const src = fs.readFileSync(TABLES_MANAGER, 'utf8');
    // `sourceIsWritable` is the place where the screen decides whether to show the "edit rows"
    // button. It must name the same two words as vocabulary.js, otherwise the screen promises
    // something that the server refuses.
    const m = /function sourceIsWritable\(source[^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(src);
    assert.ok(m, 'sourceIsWritable niet gevonden in tablesManagerModel.ts');
    const body = m[1];
    assert.match(body, new RegExp(`source\\.mode === '${WRITABLE_TABLE_SOURCE_MODE}'`));
    for (const kind of TABLE_SOURCE_KINDS) {
        assert.match(body, new RegExp(`source\\.kind === '${kind}'`),
            `sourceIsWritable kent kind '${kind}' niet`);
    }
    // Exactly one kind comparison: a second kind in the vocabulary must force a choice here,
    // not quietly count as not writable.
    assert.equal((body.match(/source\.kind ===/g) || []).length, TABLE_SOURCE_KINDS.length);
});

test('het vocabulaire zelf blijft de kleinst mogelijke lijst', () => {
    // Not cosmetic: every value here is a right that is enforced somewhere, and
    // `WRITABLE_TABLE_SOURCE_MODE` must be one of them.
    assert.ok(TABLE_SOURCE_MODES.includes(WRITABLE_TABLE_SOURCE_MODE));
    assert.equal(TABLE_SOURCE_MODES.filter((m) => m !== WRITABLE_TABLE_SOURCE_MODE).length,
        TABLE_SOURCE_MODES.length - 1, 'er is precies ÉÉN schrijfbare mode');
});
