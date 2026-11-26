#!/usr/bin/env node
/**
 * Link every module root to the core's installed packages.
 *
 * A module has no dependencies of its own: modules/<id>/server uses server/node_modules
 * and modules/<id>/frontend uses agent-hub/node_modules. This script creates the link
 * modules/<id>/server/node_modules -> server/node_modules (and the frontend one) so tsc,
 * the IDE, jest, vitest and plain node find those packages from a module root. A relative
 * symlink on POSIX, a junction on Windows; a link whose target is not installed is skipped.
 * Idempotent. With no module directory it does nothing.
 *
 * Usage: node scripts/link-module-node-modules.mjs           (npm run modules:link)
 *        node scripts/link-module-node-modules.mjs --check   exit 1 when a link is missing or points elsewhere
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Module root kind -> the core directory whose node_modules it uses. */
export const CORE_FOR = { server: 'server', frontend: 'agent-hub' };

/** The links that should exist: `[{ link, target }]`, absolute paths, target installed. */
export function plannedLinks(root = ROOT) {
    const modulesDir = path.join(root, 'modules');
    if (!fs.existsSync(modulesDir)) return [];
    const links = [];
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        for (const [kind, core] of Object.entries(CORE_FOR)) {
            const dir = path.join(modulesDir, entry.name, kind);
            const target = path.join(root, core, 'node_modules');
            if (fs.existsSync(dir) && fs.existsSync(target)) links.push({ link: path.join(dir, 'node_modules'), target });
        }
    }
    return links;
}

/** 'ok' | 'missing' | 'wrong' for one planned link. */
export function linkState({ link, target }) {
    let stat;
    try {
        stat = fs.lstatSync(link);
    } catch {
        return 'missing';
    }
    if (!stat.isSymbolicLink()) return 'wrong';
    try {
        return fs.realpathSync(link) === fs.realpathSync(target) ? 'ok' : 'wrong';
    } catch {
        return 'wrong';
    }
}

/** Create one link (replacing a link that points elsewhere, never a real directory). */
export function makeLink({ link, target }, platform = process.platform) {
    const state = linkState({ link, target });
    if (state === 'ok') return 'ok';
    if (state === 'wrong') {
        if (!fs.lstatSync(link).isSymbolicLink()) throw new Error(`${link} exists and is not a link; remove it by hand`);
        fs.unlinkSync(link);
    }
    if (platform === 'win32') fs.symlinkSync(target, link, 'junction');
    else fs.symlinkSync(path.relative(path.dirname(link), target), link);
    return 'created';
}

function main(argv) {
    const check = argv.includes('--check');
    let bad = 0;
    for (const planned of plannedLinks()) {
        const rel = path.relative(ROOT, planned.link);
        if (check) {
            const state = linkState(planned);
            if (state !== 'ok') {
                bad++;
                console.error(`${rel}: ${state}`);
            }
        } else {
            console.log(`${rel}: ${makeLink(planned)}`);
        }
    }
    if (bad) {
        console.error(`${bad} module link(s) missing or wrong: run npm run modules:link`);
        process.exit(1);
    }
}

if (isEntryPoint(import.meta.url)) main(process.argv.slice(2));
