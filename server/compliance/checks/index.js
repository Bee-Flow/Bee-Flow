/**
 * Check auto-registration — requires every check file under one directory per
 * built-in framework (frameworks.js `checks_dir`: gdpr/, aia/, iso27001/,
 * nis2/, cra/, data-act/, pld/, eaa/, dora/, machinery/) and registers it with
 * the compliance registry. A directory that does not exist yet is skipped —
 * the growing set of frameworks lands its checks framework by framework.
 */

const fs = require('fs');
const path = require('path');
const registry = require('../registry');
const frameworks = require('../frameworks');
const log = require('../../telemetry/log');

// Every directory the loader looks at, in framework order. Exported so the
// registry contract test walks exactly the same list.
const CHECK_DIRS = Object.freeze(frameworks.listBuiltin().map(f => f.checks_dir));

const _loadedDirs = [];

function _loadDir(dir) {
    const abs = path.join(__dirname, dir);
    if (!fs.existsSync(abs)) return false;
    for (const file of fs.readdirSync(abs)) {
        if (!file.endsWith('.js')) continue;
        // Tests live NEXT TO their source in this repo, so the checks directories
        // hold *.test.js files too — and this loader runs at BOOT. Requiring a
        // test file executes its module body in the live process: one that
        // stubs the require cache (testUtils/stubRequire) replaces a shared
        // module's exports for everything loaded afterwards. That is not
        // hypothetical — a colocated check test replaced db.js's exports with a
        // four-function mock, so every store required later lost makeStoreInit
        // and the server crash-looped on boot. The registration error was
        // caught and logged; the poisoning was not.
        if (/\.(test|spec)\.js$/.test(file)) continue;
        try {
            const check = require(path.join(abs, file));
            registry.register(check);
        } catch (e) {
            log.error(`[ComplianceChecks] Failed to load ${dir}/${file}:`, e.message);
        }
    }
    return true;
}

for (const dir of CHECK_DIRS) {
    if (_loadDir(dir)) _loadedDirs.push(dir);
}

log.info(`[ComplianceChecks] Registered ${registry.getAll().length} checks from ${_loadedDirs.length}/${CHECK_DIRS.length} framework dirs`);

/** The directories that existed and were loaded (a subset of CHECK_DIRS). */
function loadedDirs() { return _loadedDirs.slice(); }

// The registry's API, plus what this loader knows about the directory layout.
// Spread, not mutation: the registry module stays the plain check store.
module.exports = { ...registry, CHECK_DIRS, loadedDirs };
