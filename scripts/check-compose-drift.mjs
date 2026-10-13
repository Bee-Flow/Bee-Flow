#!/usr/bin/env node
/**
 * The compose files must agree where they describe the same thing.
 *
 * The stack comes in several files (the local build stack, the dev stack, the
 * registry stack that selfhost.sh runs, the module-hub overlay, the security
 * override). Each repeats a few facts nobody keeps in one place, and a copy
 * that is bumped in one file only ships a stack that behaves differently
 * depending on how it was started. Two checks:
 *
 *   1. images: the same third-party image (pgvector, redis, rustfs, umami,
 *      ollama, ...) carries the same tag in every file that names it. Bee Flow's
 *      own images (`${REGISTRY}/x:${TAG}`, `ghcr.io/bee-flow/*`, `beeflow-*`)
 *      take their tag from the environment and are out of scope.
 *   2. profiles: every profile a compose file declares is in ALL_PROFILES of
 *      selfhost.sh (which --stop / --down / --uninstall use to reach every
 *      sidecar), and every ALL_PROFILES entry is declared in
 *      docker-compose.from-registry.yml, the file selfhost.sh runs. A profile
 *      missing from the list leaves its containers running after --down. A
 *      profile of a file selfhost.sh never runs goes in OTHER_PROFILES, with why.
 *
 * Reads the files as text (no YAML dependency, nothing to install). A file it
 * cannot read fails the check, it never skips. Run: npm run lint:compose-drift
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './entry-point.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const FILES = [
    'docker-compose.yml',
    'docker-compose.dev.yml',
    'docker-compose.from-registry.yml',
    'docker-compose.hub.local.yml',
    'docker-compose.security.override.yml',
];

/** The file selfhost.sh runs, and so the one ALL_PROFILES describes. */
export const SELFHOST_FILE = 'docker-compose.from-registry.yml';

/** Profiles that are not in ALL_PROFILES on purpose: { file, profile, why }. */
export const OTHER_PROFILES = [
    {
        file: 'docker-compose.dev.yml',
        profile: 'hub',
        why: 'the dev stack runs the private license-server beside the server; selfhost.sh never runs docker-compose.dev.yml',
    },
];

const FIRST_PARTY = [/^\$\{/, /^ghcr\.io\/bee-flow\//, /^beeflow-/];

const unquote = (s) => s.trim().replace(/^["']|["']$/g, '');

/**
 * The image refs and profile names of one compose file.
 * @param {string} text
 * @returns {{ images: string[], profiles: string[] }}
 */
export function parseCompose(text) {
    const images = [];
    const profiles = [];
    const lines = text.split('\n').map((l) => l.replace(/\s+#.*$/, '').replace(/^\s*#.*$/, ''));
    for (let i = 0; i < lines.length; i++) {
        const img = /^\s+image:\s*(\S.*?)\s*$/.exec(lines[i]);
        if (img) images.push(unquote(img[1]));
        const inline = /^\s+profiles:\s*\[(.*)\]\s*$/.exec(lines[i]);
        if (inline) {
            for (const p of inline[1].split(',')) if (unquote(p)) profiles.push(unquote(p));
            continue;
        }
        const block = /^(\s+)profiles:\s*$/.exec(lines[i]);
        if (block) {
            for (let j = i + 1; j < lines.length; j++) {
                const item = /^\s*-\s*(\S.*?)\s*$/.exec(lines[j]);
                if (!item) {
                    if (lines[j].trim() === '') continue;
                    break;
                }
                profiles.push(unquote(item[1]));
            }
        }
    }
    return { images, profiles };
}

/** `redis:7-alpine` -> { repo: 'redis', tag: '7-alpine' }; no tag -> '(none)'. */
export function splitImage(ref) {
    const at = ref.indexOf('@');
    const name = at === -1 ? ref : ref.slice(0, at);
    const digest = at === -1 ? '' : ref.slice(at);
    const colon = name.lastIndexOf(':');
    const hasTag = colon > name.lastIndexOf('/');
    const repo = hasTag ? name.slice(0, colon) : name;
    const tag = (hasTag ? name.slice(colon + 1) : '') + digest;
    return { repo, tag: tag || '(none)' };
}

export const isThirdParty = (ref) => !FIRST_PARTY.some((re) => re.test(ref));

/**
 * @param {Record<string, { images: string[] }>} parsed file -> parsed compose
 * @returns {string[]} one message per image that carries different tags
 */
export function imageProblems(parsed) {
    /** repo -> tag -> files */
    const seen = new Map();
    for (const [file, { images }] of Object.entries(parsed)) {
        for (const ref of images.filter(isThirdParty)) {
            const { repo, tag } = splitImage(ref);
            if (!seen.has(repo)) seen.set(repo, new Map());
            const tags = seen.get(repo);
            if (!tags.has(tag)) tags.set(tag, new Set());
            tags.get(tag).add(file);
        }
    }
    const problems = [];
    for (const [repo, tags] of seen) {
        if (tags.size < 2) continue;
        const detail = [...tags].map(([tag, files]) => `${tag} in ${[...files].join(', ')}`).join('; ');
        problems.push(`image ${repo} has different tags: ${detail}`);
    }
    return problems;
}

/** The profile names in selfhost.sh's ALL_PROFILES, or null when it has none. */
export function allProfiles(selfhostText) {
    const m = /^ALL_PROFILES="([^"]*)"/m.exec(selfhostText);
    return m ? m[1].split(/\s+/).filter(Boolean) : null;
}

/**
 * @param {Record<string, { profiles: string[] }>} parsed
 * @param {string[]} all ALL_PROFILES of selfhost.sh
 * @returns {string[]}
 */
export function profileProblems(parsed, all, other = OTHER_PROFILES) {
    const problems = [];
    for (const [file, { profiles }] of Object.entries(parsed)) {
        for (const p of new Set(profiles)) {
            if (all.includes(p)) continue;
            if (other.some((o) => o.file === file && o.profile === p)) continue;
            problems.push(`${file} declares profile "${p}", which is not in ALL_PROFILES of selfhost.sh (add it there, or to OTHER_PROFILES with the reason)`);
        }
    }
    const declared = new Set(parsed[SELFHOST_FILE]?.profiles ?? []);
    for (const p of all) {
        if (!declared.has(p)) problems.push(`ALL_PROFILES of selfhost.sh lists "${p}", which ${SELFHOST_FILE} does not declare`);
    }
    for (const o of other) {
        if (!(parsed[o.file]?.profiles ?? []).includes(o.profile)) {
            problems.push(`OTHER_PROFILES names "${o.profile}" in ${o.file}, which no longer declares it; remove the entry`);
        }
        if (all.includes(o.profile)) problems.push(`OTHER_PROFILES names "${o.profile}", which is in ALL_PROFILES now; remove the entry`);
    }
    return problems;
}

/** @returns {string[]} one message per problem; empty when the files agree */
export function check(root = ROOT, files = FILES) {
    const problems = [];
    const parsed = {};
    for (const file of files) {
        try {
            parsed[file] = parseCompose(fs.readFileSync(path.join(root, file), 'utf8'));
        } catch {
            problems.push(`${file}: cannot read`);
        }
    }
    let all = null;
    try {
        all = allProfiles(fs.readFileSync(path.join(root, 'selfhost.sh'), 'utf8'));
    } catch {
        problems.push('selfhost.sh: cannot read');
    }
    if (all === null && !problems.some((p) => p.startsWith('selfhost.sh'))) problems.push('selfhost.sh: no ALL_PROFILES="..." line');
    problems.push(...imageProblems(parsed));
    if (all) problems.push(...profileProblems(parsed, all));
    return problems;
}

if (isEntryPoint(import.meta.url)) {
    const problems = check();
    for (const p of problems) console.error(`compose-drift: ${p}`);
    if (problems.length && process.env.GITHUB_ACTIONS) console.log('::error::compose files drifted (see log)');
    if (!problems.length) console.log(`compose-drift: ${FILES.length} compose files agree on third-party image tags and profiles`);
    process.exit(problems.length ? 1 : 0);
}
