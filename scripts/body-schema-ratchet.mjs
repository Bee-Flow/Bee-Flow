#!/usr/bin/env node
/**
 * Body-schema ratchet: the number of mutating routes (POST, PUT, PATCH) whose
 * chain has no `validate({ body })` may only go down.
 *
 * A route that reads `req.body` without a schema checks it by hand, if at all:
 * a misspelled key is ignored under a 200, a wrong type reaches the store, and
 * the handler's types are whatever it guesses. With a schema the refusal is a
 * worded 400 and `req.body` is typed by it (core/http/validate.js).
 *
 * Source: docs/static/openapi.json, the spec scripts/gen-api-reference.mjs
 * builds from the app's real router (scripts/api-reference-walk.cjs). An
 * operation there has a `requestBody` exactly when its chain carries a body
 * schema. The spec is committed and `lint:api-reference` fails on a stale one,
 * so reading it here needs neither the server's node_modules nor a second walk
 * of the router. After adding a schema: `npm run gen:api-reference`, then
 * `--update` to lower the budget.
 *
 * A route without a JSON body (an upload, a signed raw webhook, an action that
 * takes nothing) still counts: an action that takes nothing gets a closed empty
 * schema (`bodyOf({})`), so a body sent to it is refused by name.
 *
 * Usage:
 *   node scripts/body-schema-ratchet.mjs            gate
 *   node scripts/body-schema-ratchet.mjs --update   lower the budget to the measured count
 *   node scripts/body-schema-ratchet.mjs --list     the routes without a body schema, and coverage per method
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SPEC_REL = 'docs/static/openapi.json';
export const BUDGET_REL = 'server/.body-schema-ratchet.json';
export const MUTATING = ['post', 'put', 'patch'];

/**
 * Per mutating method: operations, those with a body schema, and the ones without.
 * @param {{ paths?: Record<string, Record<string, { requestBody?: unknown }>> }} spec
 */
export function measure(spec) {
    /** @type {Record<string, { total: number, withSchema: number }>} */
    const perMethod = {};
    /** @type {string[]} */
    const missing = [];
    for (const [route, ops] of Object.entries(spec.paths || {})) {
        for (const [method, op] of Object.entries(ops || {})) {
            if (!MUTATING.includes(method)) continue;
            const m = (perMethod[method.toUpperCase()] ||= { total: 0, withSchema: 0 });
            m.total += 1;
            if (op && op.requestBody) m.withSchema += 1;
            else missing.push(`${method.toUpperCase()} ${route}`);
        }
    }
    missing.sort();
    return { perMethod, missing, count: missing.length };
}

/** @param {{ total: number, withSchema: number }} m */
const percent = (m) => (m.total ? `${((100 * m.withSchema) / m.total).toFixed(1)}%` : '-');

/**
 * @param {string[]} argv
 * @param {{ root?: string, out?: (s: string) => void, err?: (s: string) => void }} [deps]
 * @returns {number} exit code
 */
export function main(argv, { root = ROOT, out = (s) => process.stdout.write(s), err = (s) => process.stderr.write(s) } = {}) {
    const specPath = path.join(root, SPEC_REL);
    const budgetPath = path.join(root, BUDGET_REL);
    const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
    const { perMethod, missing, count } = measure(spec);
    const budget = fs.existsSync(budgetPath) ? JSON.parse(fs.readFileSync(budgetPath, 'utf8')).budget : null;

    if (argv.includes('--list')) {
        for (const r of missing) out(`${r}\n`);
        const all = Object.values(perMethod).reduce((a, m) => ({ total: a.total + m.total, withSchema: a.withSchema + m.withSchema }), { total: 0, withSchema: 0 });
        for (const [method, m] of Object.entries(perMethod).sort()) out(`${method}: ${m.withSchema}/${m.total} with a body schema (${percent(m)})\n`);
        out(`all: ${all.withSchema}/${all.total} (${percent(all)}); ${count} without, budget ${budget ?? 'none'}\n`);
        return 0;
    }
    if (argv.includes('--update')) {
        if (budget !== null && count > budget) {
            err(`body-schema ratchet: ${count} routes without a body schema, above the budget of ${budget}; --update only lowers it.\n`);
            return 1;
        }
        fs.writeFileSync(budgetPath, `${JSON.stringify({ budget: count }, null, 2)}\n`);
        out(`body-schema ratchet: budget ${budget ?? 'none'} -> ${count}\n`);
        return 0;
    }
    if (budget === null) {
        err(`body-schema ratchet: ${BUDGET_REL} is missing; run with --update once.\n`);
        return 1;
    }
    if (count > budget) {
        err(`body-schema ratchet: ${count} mutating routes without a body schema, the budget is ${budget}. `
            + 'Give the new route a validate({ body }) schema (core/http/schemaParts.js: bodyOf), '
            + 'run `npm run gen:api-reference`, and see `--list`.\n');
        return 1;
    }
    out(`body-schema ratchet: ${count} without a body schema (budget ${budget})${count < budget ? '; run --update to lower the budget' : ''}\n`);
    return 0;
}

if (isEntryPoint(import.meta.url)) process.exitCode = main(process.argv.slice(2));
