#!/usr/bin/env node
/**
 * The server and the shared browser must run the same Playwright.
 *
 * The server's chromium.connect() to the long-lived bf-browser pod (built from
 * server/pwt-runner) is refused with HTTP 428 when the two versions differ, so
 * a one-sided bump ships either a server or a browser that cannot export a PDF,
 * render a thumbnail or ingest an SPA. Four places name that version:
 *
 *   - the base image tag in server/pwt-runner/Dockerfile
 *   - playwright in server/package.json
 *   - playwright and @playwright/test in server/pwt-runner/package.json
 *
 * Dependabot moves none of them by version (.github/dependabot.yml), so the
 * bump is a hand edit, and this check is what refuses a hand edit that missed
 * one. It runs in BOTH image jobs of build-push-ghcr.yml, because either side
 * can change alone: `server` fires on server/**, `pwt-runner` only on
 * server/pwt-runner/**. It is also picked up by `npm run test:scripts`.
 *
 * Exact strings, not semver: a caret range in either manifest can resolve to
 * a different minor than the base image carries, which is the mismatch this
 * exists to stop. A place it cannot read fails the check, it never skips.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
    try {
        return fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
        return null;
    }
}

function pin(rel, name) {
    const text = read(rel);
    if (text === null) return '';
    const pkg = JSON.parse(text);
    return (pkg.dependencies || {})[name] || (pkg.devDependencies || {})[name] || '';
}

const dockerfile = read('server/pwt-runner/Dockerfile') || '';
const from = /^FROM mcr\.microsoft\.com\/playwright:v([^-@\s]+)/m.exec(dockerfile);

const seen = {
    'server/pwt-runner/Dockerfile base image': from ? from[1] : '',
    'server/package.json playwright': pin('server/package.json', 'playwright'),
    'server/pwt-runner/package.json playwright': pin('server/pwt-runner/package.json', 'playwright'),
    'server/pwt-runner/package.json @playwright/test': pin('server/pwt-runner/package.json', '@playwright/test'),
};

for (const [where, v] of Object.entries(seen)) console.log(`${where}: ${v || '<missing>'}`);

const versions = new Set(Object.values(seen));
if (versions.size !== 1 || versions.has('')) {
    console.error(
        'playwright-lockstep: the Playwright versions above disagree or one is missing. ' +
            'chromium.connect() refuses a mismatch with HTTP 428; bump all of them in one change.',
    );
    if (process.env.GITHUB_ACTIONS) console.log('::error::Playwright versions disagree (listed above)');
    process.exit(1);
}

console.log(`playwright-lockstep: all four name ${[...versions][0]}`);
