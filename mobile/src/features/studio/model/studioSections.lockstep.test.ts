/**
 * The Studio registry, held to the web's (textual lockstep).
 *
 * agent-hub/src/components/admin/Studio/studioApps.jsx is the single source
 * of truth for which sections Studio has, in what order, under which heading,
 * behind which gate and with which "New" entry. The phone's port
 * (registry.ts) must say the same, section by section. The web file is read
 * as TEXT — Metro cannot import it, and a lockstep must not need a bundler —
 * and each descriptor is cut out by its indentation.
 *
 * When this fails, the web side changed: update registry.ts to match (and
 * decide where the new section opens on the phone). Don't loosen the test.
 */

import fs from 'node:fs';
import path from 'node:path';

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';

import { STUDIO_CATEGORIES, STUDIO_SECTIONS } from './registry';

const WEB = path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/studioApps.jsx');
const src = fs.readFileSync(WEB, 'utf8');

/** The body of `export const STUDIO_APPS = [ … ];`, split into one string per descriptor. */
function webDescriptors(): string[] {
    const start = src.indexOf('export const STUDIO_APPS = [');
    const end = src.indexOf('\n];', start);
    const body = src.slice(start, end);
    return body.split(/\n {4}\{\n/).slice(1).map((chunk) => chunk.split(/\n {4}\},?\n?/)[0] ?? chunk);
}

const one = (block: string, re: RegExp): string | null => re.exec(block)?.[1] ?? null;

/** The gate expression: from `gate:` to the next top-level property of the descriptor. */
function gateText(block: string): string {
    const at = block.indexOf('\n        gate:');
    if (at < 0) return '';
    const rest = block.slice(at + 1);
    const next = rest.slice(1).search(/\n {8}[A-Za-z]+:|\n {8}\/\//);
    return next < 0 ? rest : rest.slice(0, next + 1);
}

function calls(gate: string, fn: string): string[] {
    return [...gate.matchAll(new RegExp(`\\b${fn}\\('([^']+)'\\)`, 'g'))].map((m) => m[1] as string);
}

interface WebSection {
    id: string;
    segment: string | null;
    legacy: string[];
    category: string | null;
    labelKey: string | null;
    labelFallback: string | null;
    descKey: string | null;
    descFallback: string | null;
    icon: string | null;
    kind: string | null;
    countKey: string;
    hiddenFromNav: boolean;
    gateCapability: string | null;
    lockOn: string;
    requires: { license: string[]; canUse: string[]; can: string[]; perms: string[] };
    create: { labelKey: string; labelFallback: string } | null;
}

function readWeb(block: string): WebSection {
    const id = one(block, /^ {8}id: '([^']+)'/m) as string;
    const createAt = block.indexOf('\n        create:');
    const create = createAt < 0 ? null : block.slice(createAt);
    const gate = gateText(block);
    return {
        id,
        segment: one(block, /^ {8}urlSegment: '([^']+)'/m),
        legacy: [...(one(block, /^ {8}legacySegments: \[([^\]]*)\]/m) ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1] as string),
        category: one(block, /^ {8}category: '([^']+)'/m),
        labelKey: one(block, /^ {8}labelKey: '([^']+)'/m),
        labelFallback: one(block, /^ {8}labelFallback: '([^']+)'/m),
        descKey: one(block, /^ {8}descKey: '([^']+)'/m),
        descFallback: one(block, /^ {8}descFallback: '((?:[^'\\]|\\.)*)'/m),
        icon: one(block, /^ {8}Icon: (\w+)/m),
        kind: one(block, /^ {8}kind: '([^']+)'/m),
        countKey: one(block, /^ {8}countKey: '([^']+)'/m) ?? id,
        hiddenFromNav: /^ {8}hiddenFromNav: true/m.test(block),
        gateCapability: one(block, /^ {8}gateCapability: '([^']+)'/m),
        lockOn: one(block, /^ {8}lockOn: '([^']+)'/m) ?? 'hide',
        requires: {
            license: calls(gate, 'hasLicenseFeature'),
            canUse: calls(gate, 'canUse'),
            can: calls(gate, 'can'),
            perms: calls(gate, 'hasPermission'),
        },
        create: create
            ? {
                  labelKey: one(create, /labelKey: '([^']+)'/) as string,
                  labelFallback: one(create, /labelFallback: '([^']+)'/) as string,
              }
            : null,
    };
}

const web = webDescriptors().map(readWeb);
const byId = new Map(STUDIO_SECTIONS.map((s) => [s.id, s]));

describe('the web registry is readable at all', () => {
    it('found the fourteen built-in sections', () => {
        // Without this every check below could pass by comparing nothing.
        expect(web.length).toBeGreaterThanOrEqual(14);
        expect(web.every((w) => w.id && w.segment)).toBe(true);
    });
});

describe('the phone registry against STUDIO_APPS', () => {
    it('has the same sections in the same order', () => {
        expect(STUDIO_SECTIONS.map((s) => s.id)).toEqual(web.map((w) => w.id));
    });

    it.each(web.map((w) => [w.id, w] as const))('%s: segment, heading, glyph, kind and count key', (id, w) => {
        const s = byId.get(id as never);
        expect({
            segment: s?.segment,
            legacy: [...(s?.legacySegments ?? [])],
            category: s?.category,
            icon: s?.icon,
            kind: s?.kind ?? null,
            countKey: s?.countKey,
            hiddenFromNav: s?.hiddenFromNav,
        }).toEqual({
            segment: w.segment,
            legacy: w.legacy,
            category: w.category,
            icon: w.icon,
            kind: w.kind,
            countKey: w.countKey,
            hiddenFromNav: w.hiddenFromNav,
        });
    });

    it.each(web.map((w) => [w.id, w] as const))('%s: label and description keys', (id, w) => {
        const s = byId.get(id as never);
        expect({ labelKey: s?.labelKey, descKey: s?.descKey, descFallback: s?.descFallback }).toEqual({
            labelKey: w.labelKey,
            descKey: w.descKey,
            descFallback: w.descFallback,
        });
        // The web gives some sections no English fallback (the key is enough
        // in a browser); the phone always carries one, and where the web has
        // one they must agree.
        if (w.labelFallback) expect(s?.labelFallback).toBe(w.labelFallback);
    });

    it.each(web.map((w) => [w.id, w] as const))('%s: the gate asks the same questions', (id, w) => {
        const s = byId.get(id as never);
        expect({
            license: [...(s?.requires.license ?? [])],
            canUse: [...(s?.requires.canUse ?? [])],
            can: [...(s?.requires.can ?? [])],
            perms: [...(s?.requires.perms ?? [])],
            gateCapability: s?.gateCapability ?? null,
            lockOn: s?.lockOn,
        }).toEqual({ ...w.requires, gateCapability: w.gateCapability, lockOn: w.lockOn });
    });

    it.each(web.map((w) => [w.id, w] as const))('%s: the New-menu entry', (id, w) => {
        const s = byId.get(id as never);
        const create = s?.create ? { labelKey: s.create.labelKey, labelFallback: s.create.labelFallback } : null;
        expect(create).toEqual(w.create);
    });
});

describe('STUDIO_CATEGORIES', () => {
    it('are the web headings, in order, with their keys', () => {
        const body = src.slice(src.indexOf('export const STUDIO_CATEGORIES = ['), src.indexOf('];', src.indexOf('export const STUDIO_CATEGORIES')));
        const webCategories = [...body.matchAll(/\{ id: '([^']+)', labelKey: '([^']+)', labelFallback: '([^']+)' \}/g)].map(
            ([, id, labelKey, labelFallback]) => ({ id, labelKey, labelFallback }),
        );
        expect(webCategories.length).toBe(4);
        expect(STUDIO_CATEGORIES.map((c) => ({ ...c }))).toEqual(webCategories);
    });
});

describe('the keys the registry borrows', () => {
    // The registry carries its keys as data, which the i18n guard's `t('…')`
    // scan cannot see; this is that check for them. The phone reads the
    // SERVER catalogue, the web the client's — a key in one only is broken
    // for somebody.
    const client = readDict(CLIENT_DICT);
    const server = readDict(SERVER_DICT);
    const keys = [
        ...STUDIO_CATEGORIES.map((c) => c.labelKey),
        ...STUDIO_SECTIONS.flatMap((s) => [s.labelKey, s.descKey, ...(s.create ? [s.create.labelKey] : [])]),
    ];

    it.each(keys.map((k) => [k]))('%s is in both English dictionaries', (key) => {
        expect({ key, client: client.has(key), server: server.has(key) }).toEqual({ key, client: true, server: true });
    });
});
