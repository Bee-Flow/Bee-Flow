// @typecheck strict
/**
 * The golden fixtures of the Windmill converter: each `fixtures/<name>.json`
 * is an input, `fixtures/<name>.golden.json` what the converter makes of it.
 * Shared by golden.test.js (compares) and regenGolden.mjs (rewrites).
 *
 *   <name>.flow.json   one flow (OpenFlow, the REST object or the Hub's { flow } wrapper)
 *   <name>-bundle.json { files: { path: text } }, zipped here the way an upload arrives
 */

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toBeeFlow, toIntermediate } from './index.mts';

const nodeRequire = createRequire(import.meta.url);
const JSZip = nodeRequire('jszip');

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/** Fixture names without the extension, sorted. */
export function fixtureNames() {
    return readdirSync(FIXTURE_DIR)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.golden.json'))
        .map((f) => f.slice(0, -'.json'.length))
        .sort();
}

/**
 * The converter input for a fixture.
 * @param {string} name
 * @returns {Promise<import('./bundle.mts').WindmillInput>}
 */
export async function inputOf(name) {
    const parsed = JSON.parse(readFileSync(path.join(FIXTURE_DIR, `${name}.json`), 'utf8'));
    if (!name.endsWith('-bundle')) return { kind: 'object', value: parsed, name: `f/fixtures/${name}` };
    const zip = new JSZip();
    for (const [file, text] of Object.entries(parsed.files)) zip.file(`export/${file}`, text);
    return { kind: 'zip', data: await zip.generateAsync({ type: 'nodebuffer' }) };
}

/**
 * What a golden file holds: every flow's automation fields, definition and report.
 * @param {string} name
 */
export async function goldenOf(name) {
    const bundle = await toIntermediate(await inputOf(name));
    const result = toBeeFlow(bundle);
    return {
        flows: result.flows.map((f) => {
            const { definition, ...automation } = f.envelope.automation;
            return { flowPath: f.flowPath, automation, definition, report: f.report };
        }),
        notMigrated: result.notMigrated,
        readWarnings: result.readWarnings,
    };
}

/** @param {string} name */
export function goldenPath(name) {
    return path.join(FIXTURE_DIR, `${name}.golden.json`);
}
