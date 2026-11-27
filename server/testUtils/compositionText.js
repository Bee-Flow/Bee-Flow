// @typecheck strict
/**
 * The text of the server's composition, for the tests that look for a mount or
 * a registration by a needle in the source (`"require('./routes/studioAppUsage')"`):
 * server/index.js, followed by every first-party composition file
 * (`firstParty/<id>.js` of each module root, joined over the roots by
 * moduleRoots.cjs listTreeDir, in name order).
 *
 * The plan moves the mount and registration lines of the modules out of
 * index.js into those files. A test that reads index.js alone would then lose
 * its needle; one that reads compositionText() still finds it, wherever the
 * line went. Today no composition file exists and the text is index.js.
 *
 * Behaviour (what is mounted, in which order) is pinned by
 * boot/composition.mounts.characterisation.test.js; this is for the tests that
 * check the wording of a line.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { listTreeDir } = require('../moduleRoots.cjs');

const SERVER = path.resolve(__dirname, '..');
const COMPOSITION_FILE = /\.(?:c?js|mts)$/;
const TEST_FILE = /\.(?:test|testkit)\.[cm]?[jt]s$/;

/**
 * The composition files: name order, tests left out.
 * @param {(dir: string) => Array<{ name: string, abs: string }>} [list] the tree listing (a test seam)
 * @returns {string[]} absolute paths
 */
function compositionFiles(list = listTreeDir) {
    return list('firstParty')
        .filter((e) => COMPOSITION_FILE.test(e.name) && !TEST_FILE.test(e.name) && fs.statSync(e.abs).isFile())
        .map((e) => e.abs);
}

/**
 * index.js, then every composition file, separated by a newline.
 * @param {{ list?: (dir: string) => Array<{ name: string, abs: string }>, read?: (file: string) => string }} [opts] test seams
 * @returns {string}
 */
function compositionText({ list = listTreeDir, read = (file) => fs.readFileSync(file, 'utf8') } = {}) {
    return [path.join(SERVER, 'index.js'), ...compositionFiles(list)].map((file) => read(file)).join('\n');
}

module.exports = { compositionText, compositionFiles };
