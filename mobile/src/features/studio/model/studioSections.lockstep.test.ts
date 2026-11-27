/**
 * The Studio registry, held to the web's.
 *
 * agent-hub/src/components/admin/Studio/studioSections.ts (STUDIO_SECTIONS, the
 * data half of studioRegistry's STUDIO_APPS) and studioGates.ts (STUDIO_CATEGORIES) are the single source of truth for which
 * sections Studio has, in what order, under which heading, behind which gate
 * and with which "New" entry; studioApps.jsx, where both used to live,
 * re-exports them. The phone's port (registry.ts) must say the same, section
 * by section. The web's sections are read from its GUI inventory golden
 * (studioSections.inventory.golden.json, recorded from the running registry by
 * studioSections.inventory.test.ts beside it; a gate there is the list of the
 * questions it asks, in the order it asks them, found by running it). Only the
 * barrel's re-export is still read as text.
 *
 * When this fails, the web side changed: update registry.ts to match (and
 * decide where the new section opens on the phone). Don't loosen the test.
 */

import { CLIENT_DICT, SERVER_DICT, readDict } from '@/core/i18n/dictionaryText';
import { readWebFile, webGolden } from '@/shared/testing/webModule';

import { STUDIO_CATEGORIES, STUDIO_SECTIONS } from './registry';

/** A section as studioSections.inventory.test.ts records it (the fields this test reads). */
interface GoldenSection {
    id: string;
    urlSegment: string;
    legacySegments?: string[];
    category?: string;
    labelKey?: string;
    labelFallback?: string;
    descKey?: string;
    descFallback?: string;
    icon?: string;
    kind?: string;
    countKey?: string;
    hiddenFromNav?: boolean;
    gateCapability?: string;
    lockOn?: string;
    gate: string[] | { any: string[] } | { legs: string[] };
    create?: { labelKey: string; labelFallback: string };
}

interface StudioGolden {
    sections: GoldenSection[];
    categories: { id: string; labelKey: string; labelFallback: string }[];
}

const golden = webGolden<StudioGolden>('components/admin/Studio/studioSections.inventory.golden.json');
const barrel = readWebFile('components/admin/Studio/studioApps.tsx');

/** The questions a gate asks of one kind (`hasPermission(x)` -> x), in the order it asks them. */
function calls(gate: GoldenSection['gate'], fn: string): string[] {
    const legs = Array.isArray(gate) ? gate : 'any' in gate ? gate.any : gate.legs;
    return legs.flatMap((leg) => {
        const m = /^!?(\w+)\((.*)\)$/.exec(leg);
        return m && m[1] === fn ? [m[2] as string] : [];
    });
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

function readWeb(s: GoldenSection): WebSection {
    return {
        id: s.id,
        segment: s.urlSegment ?? null,
        legacy: s.legacySegments ?? [],
        category: s.category ?? null,
        labelKey: s.labelKey ?? null,
        labelFallback: s.labelFallback ?? null,
        descKey: s.descKey ?? null,
        descFallback: s.descFallback ?? null,
        icon: s.icon ?? null,
        kind: s.kind ?? null,
        countKey: s.countKey ?? s.id,
        hiddenFromNav: s.hiddenFromNav === true,
        gateCapability: s.gateCapability ?? null,
        lockOn: s.lockOn ?? 'hide',
        requires: {
            license: calls(s.gate, 'hasLicenseFeature'),
            canUse: calls(s.gate, 'canUse'),
            can: calls(s.gate, 'can'),
            perms: calls(s.gate, 'hasPermission'),
        },
        create: s.create ? { labelKey: s.create.labelKey, labelFallback: s.create.labelFallback } : null,
    };
}

const web = golden.sections.map(readWeb);
const byId = new Map(STUDIO_SECTIONS.map((s) => [s.id, s]));

describe('the web registry is readable at all', () => {
    it('found the fourteen built-in sections', () => {
        // Without this every check below could pass by comparing nothing.
        expect(web.length).toBeGreaterThanOrEqual(14);
        expect(web.every((w) => w.id && w.segment)).toBe(true);
    });

    it('studioApps.jsx still re-exports the registry and the categories', () => {
        expect(barrel).toContain("export { STUDIO_APPS, STUDIO_ICONS, default } from './studioRegistry';");
        expect(barrel).toMatch(/export \{[^}]*\bSTUDIO_CATEGORIES\b[^}]*\} from '\.\/studioGates';/);
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
        const webCategories = golden.categories.map(({ id, labelKey, labelFallback }) => ({ id, labelKey, labelFallback }));
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
