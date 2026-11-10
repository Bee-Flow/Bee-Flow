import { createRequire } from 'node:module';
import { Bell } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { STEP_CATALOG, STEP_GROUPS } from './stepCatalog';
import { EXTENSION_STEP_KINDS, buildStepKinds, newStep, paletteGroups, stepMeta } from './stepKinds';
import type { StepKindModule } from './stepKinds';

const require = createRequire(import.meta.url);
const specs = require('../../../../../../../server/appStudio/componentSpecs.js') as {
    STEP_KINDS: string[];
    STEP_SPECS: Record<string, { fields: Record<string, { required?: boolean; type?: string }> }>;
};
const registry = require('../../../../../../../server/appStudio/componentSpecs/stepRegistry.js') as {
    EXTENSION_STEP_ENTRIES: Array<{ kind: string; side: string; childSlots: unknown[] }>;
};

/**
 * The editor's files under flow/steps/ and the server's registry
 * (server/appStudio/componentSpecs/steps/) name the same kinds, and each file
 * dresses its kind the way the base catalog dresses a base kind. A registry kind
 * without a file would land in the palette as an unlabelled grey box.
 */
describe('stepKinds: the editor knows every kind of the step registry', () => {
    it('has one file per registry kind and no other', () => {
        expect(Object.keys(EXTENSION_STEP_KINDS).sort()).toEqual(registry.EXTENSION_STEP_ENTRIES.map((e) => e.kind).sort());
    });

    it('every kind of the catalogue is presentable and offered exactly once', () => {
        for (const kind of specs.STEP_KINDS) {
            const meta = stepMeta(kind);
            expect(meta.blurb.length, `"${kind}" has no description`).toBeGreaterThan(0);
            expect(meta.label.length).toBeGreaterThan(0);
        }
        expect(paletteGroups().flatMap((g) => g.kinds.map((k) => k.kind)).sort()).toEqual([...specs.STEP_KINDS].sort());
    });

    it('marks a registry kind as server step and container the way the server declares it', () => {
        for (const entry of registry.EXTENSION_STEP_ENTRIES) {
            const meta = EXTENSION_STEP_KINDS[entry.kind].meta;
            expect(!!meta.server, `${entry.kind}: server`).toBe(entry.side === 'server');
            expect(!!meta.container, `${entry.kind}: container`).toBe(entry.childSlots.length > 0);
        }
    });

    it('a fresh registry step carries every required field and no unknown one', () => {
        for (const entry of registry.EXTENSION_STEP_ENTRIES) {
            const fields = specs.STEP_SPECS[entry.kind].fields;
            const step = newStep(entry.kind, { screenId: 'scr_a', modalId: 'cmp_m' });
            expect(step.kind).toBe(entry.kind);
            for (const [field, fs] of Object.entries(fields)) {
                if (!fs.required || fs.type === 'steps' || fs.type === 'switchCases') continue;
                expect(step[field], `${entry.kind}.${field} is required but missing`).not.toBe(undefined);
            }
            for (const key of Object.keys(step)) expect(key === 'kind' || Object.hasOwn(fields, key), `${entry.kind}: unknown field "${key}"`).toBe(true);
        }
    });
});

/** A fixture kind, never shipped: what a file under flow/steps/ exports. */
const fixture: StepKindModule = {
    kind: 'zz_probe',
    meta: { label: 'Probe', labelKey: 'x.probe_label', group: 'Data', icon: Bell, blurb: 'Probes a table.', blurbKey: 'x.probe_blurb', server: true },
    newStep: ({ screenId }) => ({ kind: 'zz_probe', tableId: '', screen: screenId ?? '' }),
};
const elsewhere: StepKindModule = {
    kind: 'zz_else',
    meta: { label: 'Elsewhere', group: 'Integrations', icon: Bell, blurb: 'A kind in a group of its own.' },
    newStep: () => ({ kind: 'zz_else' }),
};

describe('buildStepKinds: a kind is one file', () => {
    const catalog = buildStepKinds({ './steps/zz_probe.ts': { default: fixture }, './steps/zz_else.ts': { default: elsewhere } });

    it('dresses the fixture kind, translated when asked, and leaves the base kinds as they were', () => {
        expect(catalog.stepMeta('zz_probe')).toBe(fixture.meta);
        const t = (key: string | undefined, fallback: unknown) => `${String(key)}|${String(fallback)}`;
        expect(catalog.stepMeta('zz_probe', t as never)).toMatchObject({ label: 'x.probe_label|Probe', blurb: 'x.probe_blurb|Probes a table.', group: 'Data', server: true });
        expect(catalog.stepMeta('toast')).toBe(STEP_CATALOG.toast);
        expect(catalog.stepMeta('what_is_this').label).toBe('what is this');
    });

    it('offers it in its group after the base kinds, and a new group after the base groups', () => {
        const groups = catalog.paletteGroups();
        expect(groups.map((g) => g.group)).toEqual([...STEP_GROUPS, 'Integrations']);
        const data = groups.find((g) => g.group === 'Data')?.kinds.map((k) => k.kind) ?? [];
        expect(data[data.length - 1]).toBe('zz_probe');
        expect(data.slice(0, -1)).toEqual(paletteGroups().find((g) => g.group === 'Data')?.kinds.map((k) => k.kind));
        expect(groups[groups.length - 1].kinds.map((k) => k.kind)).toEqual(['zz_else']);
    });

    it('builds a fresh step from the file, and a base step as before', () => {
        expect(catalog.newStep('zz_probe', { screenId: 'scr_a' })).toEqual({ kind: 'zz_probe', tableId: '', screen: 'scr_a' });
        expect(catalog.newStep('toast')).toEqual({ kind: 'toast', message: '', tone: 'info' });
    });

    it('refuses a file that names a base kind or not its own kind', () => {
        expect(() => buildStepKinds({ './steps/toast.ts': { default: { ...fixture, kind: 'toast' } } })).toThrow(/base step kind/);
        expect(() => buildStepKinds({ './steps/other.ts': { default: fixture } })).toThrow(/its own kind/);
    });

    it('the fixture never reaches the shipped catalog', () => {
        expect(Object.keys(EXTENSION_STEP_KINDS)).not.toContain('zz_probe');
        expect(paletteGroups().flatMap((g) => g.kinds.map((k) => k.kind))).not.toContain('zz_probe');
    });
});
