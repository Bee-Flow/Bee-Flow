// @vitest-environment node
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Compliance Center is token-only (redesign, Sep 2026): every colour is a
 * var(--…) — `--kind-compliance` for the area, `--success/--warning/--error`
 * for borders, dots and bars, the `--*-ink` pair for chip text. This is the
 * SOURCE scan that keeps it so, the sibling of
 * Studio/AppStudio/AppStudio.noPurple.test.jsx (which scans rendered HTML of
 * App Studio surfaces; the compliance tree sat outside both scans' roots,
 * which is how `#6366f1` and `#8b5cf6` got in).
 *
 * Two rules:
 *   1. No forbidden colour word or hex anywhere in the tree — ever.
 *   2. No raw hex colour in a compliance source file. The legacy pages still
 *      carry hexes until their Wave 1 rewrite lands, so they are listed in
 *      PENDING_HEX_FILES; a stream that rewrites a page REMOVES it from the
 *      list in the same change. A file NOT on the list must be clean, and the
 *      list may only shrink.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = [
    here,
    path.join(here, '..', '..', 'shared'),
];
// Only these shared files belong to the compliance contract; the rest of
// shared/ has its own tests and may legitimately carry hex (e.g. chart palettes).
const SHARED_FILES = new Set([
    'statusTone.js', 'SideDrawer.jsx', 'DeadlineClock.jsx', 'deadlineMath.js',
    'DataTable.jsx', 'FilterPills.jsx', 'Pager.jsx', 'NavCountBadge.jsx',
]);

// Same list as AppStudio.noPurple.test.jsx — keep them identical.
const FORBIDDEN = [
    /99\s*,\s*102\s*,\s*241/i, // rgb(99,102,241) = indigo-500
    /#6366f1/i,
    /#4f46e5/i,
    /#818cf8/i,
    /#7c3aed/i,
    /#a855f7/i,
    /#8b5cf6/i,
    /indigo/i,
    /violet/i,
    /purple/i,
];

// Legacy files that still carry raw hex. Wave 1 streams: delete your files
// from this list when you rewrite them. Adding a file here is not allowed.
// The eight legacy register/settings pages left with fe-6; only the two shared
// primitives remain.
// Empty, and it may only stay so. Skeleton.jsx and UserPicker.jsx carried their
// hex inside `var(--token, #fallback)` — dead code (index.css.tokenHygiene
// guarantees every token is declared) that was ALSO theme-wrong: a dark navy
// behind a light-mode skeleton, a white behind a dark-mode select. The
// fallbacks are gone rather than the hex recoloured.
const PENDING_HEX_FILES = new Set([]);

// The forbidden-word rule has the same grace period for the same files: the
// old pages named "#8b5cf6"/"#6366f1" and the word purple in comments. Those
// pages are gone (fe-6), so this list is empty — and may only stay so.
const PENDING_FORBIDDEN_FILES = new Set([]);

// A hex colour literal in source: #rgb, #rrggbb, #rrggbbaa. An all-digit run
// such as '#2038' is a request/incident id in copy, not a colour, so it is
// excluded — a real colour written with digits only (e.g. #123456) is not a
// palette anyone uses here.
const HEX = /#(?![0-9]{3,8}\b)[0-9a-f]{3,8}\b/i;
const TEST_FILE = /\.test\.(jsx?|tsx?)$/;

function walk(dir, acc = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, acc);
        else if (/\.(jsx?|tsx?|css)$/.test(entry.name) && !TEST_FILE.test(entry.name)) acc.push(full);
    }
    return acc;
}

function complianceSources() {
    const own = walk(here).map(f => ({ rel: path.relative(here, f).split(path.sep).join('/'), full: f }));
    const sharedDir = ROOTS[1];
    const shared = fs.readdirSync(sharedDir)
        .filter(f => SHARED_FILES.has(f))
        .map(f => ({ rel: `shared-primitives/${f}`, full: path.join(sharedDir, f) }));
    return [...own, ...shared];
}

describe('Compliance Center — no purple, no raw hex', () => {
    const files = complianceSources();

    it('the scan sees the tree', () => {
        expect(files.length).toBeGreaterThan(10);
        expect(files.some(f => f.rel === 'sections.js')).toBe(true);
    });

    it('no forbidden colour word or hex outside the shrinking legacy list', () => {
        const offenders = [];
        for (const { rel, full } of files) {
            if (PENDING_FORBIDDEN_FILES.has(rel)) continue;
            const src = fs.readFileSync(full, 'utf8');
            for (const re of FORBIDDEN) if (re.test(src)) offenders.push(`${rel}: ${re}`);
        }
        expect(offenders).toEqual([]);
    });

    it('no raw hex colour in any file that is not on the legacy list', () => {
        const offenders = [];
        for (const { rel, full } of files) {
            if (PENDING_HEX_FILES.has(rel)) continue;
            const src = fs.readFileSync(full, 'utf8');
            const hits = [...src.matchAll(new RegExp(HEX.source, 'gi'))].map(m => m[0]);
            if (hits.length) offenders.push(`${rel}: ${[...new Set(hits)].join(', ')}`);
        }
        expect(offenders).toEqual([]);
    });

    it('the legacy lists only shrink: every listed file still exists (delete the entry when the page goes)', () => {
        const stale = [];
        for (const rel of [...PENDING_HEX_FILES, ...PENDING_FORBIDDEN_FILES]) {
            if (!fs.existsSync(path.join(here, rel))) stale.push(rel);
        }
        expect(stale).toEqual([]);
    });

    it('never reads a --status-* token (agent-hub never declared one)', () => {
        const offenders = [];
        for (const { rel, full } of files) {
            // A READ of the token (`var(--status-…)`), not a comment that names it.
            if (/var\(\s*--status-/.test(fs.readFileSync(full, 'utf8'))) offenders.push(rel);
        }
        expect(offenders).toEqual([]);
    });
});
