// @typecheck strict
/**
 * No string in the dictionary names an AppAPI command that does not exist.
 *
 * AppAPI (the Nextcloud app that runs the Bee Flow connector) takes the
 * connector's values in the deploy options at install, or when the app is
 * registered again with --env. It has no command that changes a value of an
 * installed app, so a text that tells an administrator to run one ends in an
 * occ error and a pairing that never happens. The connector pins the same for
 * its own files (nextcloud-connector/test/installTimeValues.test.js).
 *
 * Pure: reads the merged English dictionary and the parsed Dutch catalogue.
 *
 * Run: cd server && node --test i18n/defaults/en.app-api-commands.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { GUI_DEFAULTS } = require('./en');

// Written in two halves so this file does not contain the command it bans.
const ABSENT_COMMAND = ['app_api:app:', 'setenv'].join('');

test('no English string names a command AppAPI does not have', () => {
    const hits = Object.entries(GUI_DEFAULTS)
        .filter(([, value]) => typeof value === 'string' && value.includes(ABSENT_COMMAND))
        .map(([key]) => key);
    assert.deepEqual(hits, []);
});

test('no Dutch string names it either', () => {
    const dir = path.join(__dirname, 'nl');
    const hits = [];
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        /** @type {{ translations?: Record<string, unknown> }} */
        const catalogue = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
        for (const [key, value] of Object.entries(catalogue.translations ?? {})) {
            if (typeof value === 'string' && value.includes(ABSENT_COMMAND)) hits.push(key);
        }
    }
    assert.deepEqual(hits, []);
});

test('the pairing instructions send the administrator to the setup page', () => {
    assert.match(GUI_DEFAULTS['nc_pairing.howto_enter_code'], /Bind to existing organisation/);
    assert.match(GUI_DEFAULTS['nc_pairing.howto_setup_page'], /setup page/);
});
