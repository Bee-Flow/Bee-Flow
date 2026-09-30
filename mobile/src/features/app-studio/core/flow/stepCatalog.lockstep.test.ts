/**
 * Differential lockstep: core/flow/stepCatalog against the web's
 * flow/stepCatalog.js (its Lucide imports load as their names, see
 * testing/loadWeb), and against the server's STEP_KINDS.
 */

import { ICON_REGISTRY } from '@/shared/ui/icons/registry.generated';

import * as port from './stepCatalog';
import { english } from '../testing/english';
import { loadWeb } from '../testing/loadWeb';

interface WebMeta {
    label: string;
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
    stepMeta: (kind: unknown) => WebMeta;
    paletteGroups: () => { group: string; kinds: (WebMeta & { kind: string })[] }[];
    newStep: (kind: string, opts?: Record<string, string>) => unknown;
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

describe('the step catalog agrees with the web', () => {
    it('has the same kinds, in the same order, dressed the same', () => {
        expect(Object.keys(port.STEP_CATALOG)).toEqual(Object.keys(web.STEP_CATALOG));
        for (const [kind, meta] of Object.entries(web.STEP_CATALOG)) {
            expect({ kind, meta: english(port.STEP_CATALOG[kind]) }).toEqual({ kind, meta: asPhone(meta) });
        }
        expect(port.STEP_GROUPS).toEqual(web.STEP_GROUPS);
        expect(english(port.UNKNOWN_STEP)).toEqual(asPhone(web.UNKNOWN_STEP));
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
            expect(english(port.stepMeta(kind))).toEqual(asPhone(web.stepMeta(kind)));
        }
        const palette = web.paletteGroups().map((g) => ({ ...g, kinds: g.kinds.map((k) => asPhone(k)) }));
        expect(english(port.paletteGroups())).toEqual(palette);
        for (const kind of [...STEP_KINDS, 'unknown_kind']) {
            expect(port.newStep(kind)).toEqual(web.newStep(kind));
            expect(port.newStep(kind, { screenId: 'scr_a', modalId: 'cmp_m' })).toEqual(
                web.newStep(kind, { screenId: 'scr_a', modalId: 'cmp_m' }),
            );
        }
    });

    it('group labels read as the group ids', () => {
        expect(port.STEP_GROUPS.map((g) => english(port.STEP_GROUP_LABELS[g]))).toEqual(web.STEP_GROUPS);
    });
});
