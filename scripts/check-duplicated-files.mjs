#!/usr/bin/env node
/**
 * Files that exist twice on purpose must stay byte-identical.
 *
 * Some build contexts cannot see each other (a Docker context, a package that
 * ships on its own), so a file is copied instead of shared. A copy that drifts
 * is a bug nobody notices until the two sides disagree. Each entry below names
 * such a pair and why it exists; this check fails when the bytes differ or one
 * side is missing. It never skips a pair it cannot read.
 *
 * To add a pair: append it to PAIRS with a reason. Run: npm run lint:duplicated-files
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** @type {{ a: string, b: string, why: string }[]} */
export const PAIRS = [
    {
        a: 'server/terminal-runner/Dockerfile',
        b: 'hub-module-sdk/modules/security_scan/assets/terminal-runner/Dockerfile',
        why: 'the security_scan module packs its own copy of the terminal-runner image recipe',
    },
    {
        a: 'server/assets/brand/BeeFlow-logo-Icon-2026.svg',
        b: 'agent-hub/src/assets/BeeFlow-logo-Icon-2026.svg',
        why: 'the server embeds the logo in exports; the agent-hub image cannot see server/',
    },
];

/**
 * @param {string} root repository root
 * @param {{ a: string, b: string, why?: string }[]} pairs
 * @returns {string[]} one message per problem; empty when every pair matches
 */
export function checkPairs(root, pairs) {
    const problems = [];
    for (const { a, b } of pairs) {
        let bufA;
        let bufB;
        try {
            bufA = fs.readFileSync(path.join(root, a));
        } catch {
            problems.push(`${a}: cannot be read (pair with ${b})`);
            continue;
        }
        try {
            bufB = fs.readFileSync(path.join(root, b));
        } catch {
            problems.push(`${b}: cannot be read (pair with ${a})`);
            continue;
        }
        if (!bufA.equals(bufB)) problems.push(`${a} and ${b} differ; they must stay byte-identical (copy one over the other)`);
    }
    return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const problems = checkPairs(ROOT, PAIRS);
    if (problems.length > 0) {
        for (const p of problems) console.error(`❌ ${p}`);
        process.exit(1);
    }
    console.log(`✅ ${PAIRS.length} duplicated file pairs are byte-identical`);
}
