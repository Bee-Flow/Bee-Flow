#!/usr/bin/env node
/**
 * The mobile job in ci.yml deliberately does NOT fire on server/package.json.
 *
 * The server half of its `mobile:` filter lists the server files mobile reads
 * instead of server/**, and leaves the server's dependency manifests out, so
 * dependabot's server bumps stop re-running the whole mobile pipeline for a
 * change that cannot alter a mobile test outcome. That exclusion is only safe
 * while these invariants hold, and they live outside the mobile tree:
 *
 *   1. server/ stays CommonJS, and so does every module root (modules/<id>/
 *      server/ holds the same tree as server/; modules/package.json makes its
 *      .js files CommonJS). mobile/src/features/automate/catalogLockstep
 *      .test.ts `require()`s server/appStudio/componentSpecs.js from a
 *      CommonJS jest-expo context. Flip `"type"` to `"module"` and that
 *      require breaks — on a commit for which the mobile job no longer fires
 *      to tell you.
 *   2. mobile's jest config still loads the server tree untransformed
 *      (SERVER_DIR in transformIgnorePatterns), because the server's
 *      node_modules are not installed in the mobile CI job.
 *   3. every server/ and agent-hub/ pattern in ci.yml's `changes` job names the
 *      module roots too (`{server,modules/*\/server}/<tree path>`,
 *      `{agent-hub,modules/*\/frontend}/src/<tree path>`): a file keeps its tree
 *      path when it moves into a module, and a filter that names only the core
 *      root stops firing for it without a word. Only the server package's own
 *      manifests stay plain (a module root has none).
 *
 * So they are asserted HERE, in a check that runs on commits touching only
 * server/package.json. Its runner is the `server` job in
 * .github/workflows/ci.yml, which fires on all of server/ (and on ci.yml)
 * with no manifest exclusion — i.e. on exactly the commits the mobile job
 * skips — and it is additionally picked up by `npm run test:scripts`.
 *
 * It asserts INVARIANTS, not a mirror of which server files the mobile tests
 * read (mobile/src/meta/serverClosure.test.ts keeps that list complete).
 *
 * Fail loudly, never skip: the server job's own header states the principle
 * — "a suite that self-skips when a container is missing protects nothing
 * where the bug gets written".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The root-aware prefixes: the core root and every module root in one brace list. */
const SERVER_ROOTS = '{server,modules/*/server}/';
const WEB_ROOTS = '{agent-hub,modules/*/frontend}/';
/** The server package's own manifests: no module root has them, so they stay plain. */
const CORE_ONLY = new Set(['server/package.json', 'server/package-lock.json']);

/** Problems with one package.json that has to say `"type": "commonjs"`. */
function commonjsProblems(rel, why) {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return [`${rel} is missing at ${file}`];
    const type = JSON.parse(fs.readFileSync(file, 'utf8')).type;
    if (type === 'commonjs') return [];
    return [`${rel} has "type": ${JSON.stringify(type)}, expected "commonjs". ${why}`];
}

function moduleTypeProblems() {
    const why =
        'mobile/src/features/automate/catalogLockstep.test.ts require()s ' +
        'server/appStudio/componentSpecs.js from a CommonJS jest-expo context, and ' +
        'the mobile CI job does not fire on this file to tell you it broke.';
    const out = commonjsProblems('server/package.json', why);
    // The module roots hold the same tree; their .js files get their type here.
    if (fs.existsSync(path.join(ROOT, 'modules'))) out.push(...commonjsProblems('modules/package.json', why));
    return out;
}

function jestConfigProblems() {
    const jestConfigPath = path.join(ROOT, 'mobile/jest.config.js');
    if (!fs.existsSync(jestConfigPath)) {
        return [`mobile/jest.config.js is missing at ${jestConfigPath} — this check refuses to pass without reading it`];
    }
    const config = fs.readFileSync(jestConfigPath, 'utf8');
    // Inside the ARRAY, not merely somewhere in the file: the `const
    // SERVER_DIR = …` declaration would satisfy a bare `includes` while the
    // entry that actually does the work had been deleted from the list.
    const array = /transformIgnorePatterns:\s*\[([\s\S]*?)\]/.exec(config);
    if (!array) return ['mobile/jest.config.js no longer has a transformIgnorePatterns array'];
    if (array[1].includes('SERVER_DIR')) return [];
    return [
        "mobile/jest.config.js no longer mentions SERVER_DIR in transformIgnorePatterns. Without it the server's " +
            'uninstalled node_modules become reachable through Babel in the mobile CI job, ' +
            "and the mobile CI job's server-manifest exclusion stops being safe.",
    ];
}

/**
 * The quoted patterns of the `changes` job in a workflow text, with their line
 * numbers. Line-based, like the mobile tests that read the same file.
 */
function changesPatterns(text) {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => /^ {2}changes:\s*$/.test(l));
    if (start === -1) return null;
    const out = [];
    for (let i = start + 1; i < lines.length && !/^ {2}\S/.test(lines[i]); i += 1) {
        const m = /^\s+-\s+'([^']+)'\s*$/.exec(lines[i]);
        if (m) out.push({ line: i + 1, pattern: m[1] });
    }
    return out;
}

/** Why a filter pattern is not root-aware, or null when it is. */
function rootAwareProblem(pattern) {
    const bare = pattern.startsWith('!') ? pattern.slice(1) : pattern;
    if (CORE_ONLY.has(bare)) return null;
    if (bare.startsWith('server/')) return `names only the core root; write '${SERVER_ROOTS}${bare.slice('server/'.length)}'`;
    if (bare.startsWith('agent-hub/')) return `names only the core root; write '${WEB_ROOTS}${bare.slice('agent-hub/'.length)}'`;
    return null;
}

function filterProblems() {
    const rel = '.github/workflows/ci.yml';
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return [`${rel} is missing at ${file} — this check refuses to pass without reading it`];
    const patterns = changesPatterns(fs.readFileSync(file, 'utf8'));
    if (!patterns || patterns.length === 0) return [`${rel} has no \`changes\` job with quoted filter patterns`];
    return patterns.flatMap(({ line, pattern }) => {
        const why = rootAwareProblem(pattern);
        return why ? [`${rel}:${line} '${pattern}' ${why}, so the filter still fires when the file moves to a module root`] : [];
    });
}

const problems = [...moduleTypeProblems(), ...jestConfigProblems(), ...filterProblems()];

if (problems.length > 0) {
    for (const p of problems) console.error(`server-manifest: ${p}`);
    process.exit(1);
}

console.log(
    'server-manifest: server/ and modules/ are CommonJS, mobile/jest.config.js still loads the server untransformed, ' +
        "and ci.yml's filters name the module roots",
);
