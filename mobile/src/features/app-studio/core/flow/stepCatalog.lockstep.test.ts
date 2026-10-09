/**
 * Differential lockstep: core/flow/stepCatalog against the web's
 * flow/stepCatalog.js (its Lucide imports load as their names, see
 * testing/loadWeb), and against the server's STEP_KINDS.
 */

import { ICON_REGISTRY } from '@/shared/ui/icons/registry.generated';

import * as port from './stepCatalog';
import type { StepMeta } from './stepCatalog';
import { say } from '../msg';
import { english } from '../testing/english';
import { loadWeb } from '../testing/loadWeb';

interface WebMeta {
    label: string;
    labelKey?: string;
    blurbKey?: string;
    group: string;
    icon: { iconName: string };
    blurb: string;
    server?: boolean;
    container?: boolean;
}
interface WebCatalog {
    STEP_GROUPS: string[];
    STEP_CATALOG: Record<string, WebMeta>;
    UNKNOWN_STEP: WebMeta;
    stepMeta: (kind: unknown, t?: ((key: string, en: string) => string) | null) => WebMeta;
    paletteGroups: () => { group: string; kinds: (WebMeta & { kind: string })[] }[];
    newStep: (kind: string, opts?: Record<string, string>) => unknown;
    groupLabel: (group: string, t?: ((key: string, en: string) => string) | null) => string;
}

const web = loadWeb<WebCatalog>('flow/stepCatalog.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { STEP_KINDS } = require('../../../../../../server/appStudio/componentSpecs/actionSpecs.js') as { STEP_KINDS: string[] };

/** Lucide renamed these; the phone registry uses the current names. */
const RENAMED: Record<string, string> = { CheckCircle2: 'CircleCheck', FileSignature: 'FilePenLine' };

/** The web meta with its icon as the phone's name. */
function asPhone(meta: WebMeta): Record<string, unknown> {
    const name = meta.icon.iconName;
    return { ...meta, icon: RENAMED[name] ?? name };
}

/**
 * The port's meta in the web's shape: English words, and the web's `labelKey` /
 * `blurbKey` beside them (the keys the phone must say them under). The web's
 * own fallback for an unknown kind has no keys, so a meta without one is
 * rendered without.
 */
function asWeb(meta: StepMeta, keyed = true): Record<string, unknown> {
    const { label, blurb, ...rest } = meta;
    return {
        ...rest,
        label: say(label),
        ...(keyed ? { labelKey: label.i18nKey } : {}),
        blurb: say(blurb),
        ...(keyed ? { blurbKey: blurb.i18nKey } : {}),
    };
}

describe('the step catalog agrees with the web', () => {
    it('has the same kinds, in the same order, dressed the same', () => {
        expect(Object.keys(port.STEP_CATALOG)).toEqual(Object.keys(web.STEP_CATALOG));
        for (const [kind, meta] of Object.entries(web.STEP_CATALOG)) {
            expect({ kind, meta: asWeb(port.STEP_CATALOG[kind] as StepMeta) }).toEqual({ kind, meta: asPhone(meta) });
        }
        expect(port.STEP_GROUPS).toEqual(web.STEP_GROUPS);
        expect(asWeb(port.UNKNOWN_STEP, false)).toEqual(asPhone(web.UNKNOWN_STEP));
        // ...but it says its one word under the key the web gives it when it has a translator.
        expect(port.UNKNOWN_STEP.label.i18nKey).toBe(web.stepMeta('', (key) => key).label);
    });

    it('every icon is one the phone can draw', () => {
        const missing = Object.values(port.STEP_CATALOG).map((m) => m.icon).filter((n) => !(n in ICON_REGISTRY));
        expect(missing).toEqual([]);
        expect(port.UNKNOWN_STEP.icon in ICON_REGISTRY).toBe(true);
    });

    it('covers exactly the server step kinds', () => {
        expect(Object.keys(port.STEP_CATALOG).sort()).toEqual([...STEP_KINDS].sort());
    });

    it('stepMeta, paletteGroups and newStep match', () => {
        for (const kind of [...Object.keys(web.STEP_CATALOG), 'mystery_kind', '', null, undefined]) {
            const known = typeof kind === 'string' && kind in web.STEP_CATALOG;
            expect(asWeb(port.stepMeta(kind), known)).toEqual(asPhone(web.stepMeta(kind)));
        }
        // The web's groups also carry their translated label; the phone draws that from STEP_GROUP_LABELS.
        const palette = web.paletteGroups().map(({ group, kinds }) => ({ group, kinds: kinds.map((k) => asPhone(k)) }));
        expect(port.paletteGroups().map(({ group, kinds }) => ({ group, kinds: kinds.map((k) => ({ kind: k.kind, ...asWeb(k) })) }))).toEqual(palette);
        for (const kind of [...STEP_KINDS, 'unknown_kind']) {
            expect(port.newStep(kind)).toEqual(web.newStep(kind));
            expect(port.newStep(kind, { screenId: 'scr_a', modalId: 'cmp_m' })).toEqual(
                web.newStep(kind, { screenId: 'scr_a', modalId: 'cmp_m' }),
            );
        }
    });

    it('group labels read as the group ids', () => {
        expect(port.STEP_GROUPS.map((g) => english(port.STEP_GROUP_LABELS[g]))).toEqual(web.STEP_GROUPS);
        // ...and say them under the web's keys.
        expect(port.STEP_GROUPS.map((g) => port.STEP_GROUP_LABELS[g].i18nKey)).toEqual(web.STEP_GROUPS.map((g) => web.groupLabel(g, (key) => key)));
    });
});
