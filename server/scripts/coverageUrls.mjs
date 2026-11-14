// @typecheck strict
/**
 * Give every script in a V8 coverage dump a `file://` URL before c8 reads it.
 *
 * V8 names a script by the URL node loaded it under. For an ordinary CommonJS
 * or ES module that is `file:///…/x.js`; for a `.mts` file loaded with
 * `require()` (type stripping) it is the bare path, `/…/x.mts`. c8 reports
 * both, but it only remembers the `file://` ones as "seen", and with
 * `all: true` (.c8rc.json) it adds an empty, all-zero report for every source
 * file it has not seen. For a required `.mts` file that empty report is laid
 * over the real one: every line outside a function body reads as uncovered,
 * and the file is flagged as "no data", so merging the shards
 * (merge-coverage.mjs) replaces its hits with another shard's zeroes. A file
 * its own test covers for 98% came out of the merged report at 0%.
 *
 * Rewriting the bare paths to `file://` URLs makes c8 treat those scripts like
 * any other. Dumps are rewritten in place; a dump that cannot be parsed is left
 * as it is (c8 skips it, as before).
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The dump with every absolute-path script URL as a `file://` URL.
 * @param {{ result?: { url: string }[] }} dump a parsed NODE_V8_COVERAGE file
 * @returns {number} how many URLs were rewritten
 */
export function normalizeScriptUrls(dump) {
    let rewritten = 0;
    for (const script of dump.result ?? []) {
        if (typeof script.url === 'string' && path.isAbsolute(script.url)) {
            script.url = pathToFileURL(script.url).href;
            rewritten++;
        }
    }
    return rewritten;
}

/**
 * Rewrite every `coverage-*.json` in a NODE_V8_COVERAGE directory.
 * @param {string} dir
 * @returns {number} how many URLs were rewritten in total
 */
export function normalizeCoverageDir(dir) {
    let rewritten = 0;
    for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(dir, name);
        let dump;
        try { dump = JSON.parse(readFileSync(file, 'utf8')); } catch { continue; }
        const n = normalizeScriptUrls(dump);
        if (n > 0) writeFileSync(file, JSON.stringify(dump));
        rewritten += n;
    }
    return rewritten;
}
