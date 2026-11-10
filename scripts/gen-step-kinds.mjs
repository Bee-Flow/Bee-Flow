#!/usr/bin/env node
/**
 * Write server/shared/appDefinition/stepKinds.generated.mjs from the App Studio step registry
 * (server/appStudio/componentSpecs/steps/<kind>.js), or check that it is current.
 *
 * The text itself is rendered by server/appStudio/stepKindsGen.mts (the server test
 * stepRegistry.test.js compares against the same function); this script is what puts it in
 * `npm run gen:shared` and in `npm run lint:shared-mirror`, so a registry file added without
 * regenerating fails check:fast and not only the server suite. It runs BEFORE the shared
 * mirror: the browser's copy of the file is made from the one written here.
 *
 * The registry is dependency-free plain data, so this needs no server/node_modules.
 *
 *   node scripts/gen-step-kinds.mjs            write the file when it differs
 *   node scripts/gen-step-kinds.mjs --check    exit 1 when it is stale; writes nothing
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = 'server/appStudio/stepKindsGen.mts';
export const STEP_KINDS_OUT = 'server/shared/appDefinition/stepKinds.generated.mjs';

/**
 * @param {{ check?: boolean, root?: string, render?: () => string, log?: (line: string) => void, error?: (line: string) => void }} [opts]
 * @returns {Promise<number>} the exit code
 */
export async function run({ check = false, root = ROOT, render, log = console.log, error = console.error } = {}) {
    const renderText = render || (await import(path.join(ROOT, GENERATOR))).renderStepKindsFile;
    const wanted = renderText();
    const file = path.join(root, STEP_KINDS_OUT);
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (current === wanted) {
        log('gen-step-kinds: 1 file up to date.');
        return 0;
    }
    if (check) {
        error(`gen-step-kinds: ${STEP_KINDS_OUT} is out of date with the step registry (server/appStudio/componentSpecs/steps/). Run \`npm run gen:shared\` and commit the result.`);
        return 1;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, wanted);
    log(`gen-step-kinds: wrote ${STEP_KINDS_OUT}`);
    return 0;
}

if (isEntryPoint(import.meta.url)) {
    run({ check: process.argv.includes('--check') }).then((code) => process.exit(code), (e) => {
        console.error(`gen-step-kinds: ${e.message}`);
        process.exit(1);
    });
}
