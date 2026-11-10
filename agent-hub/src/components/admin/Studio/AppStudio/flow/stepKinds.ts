/**
 * The step catalog the editor shows: the base kinds (stepCatalog.ts, kept as it
 * is because the phone loads that file by its text) followed by the kinds of the
 * step registry, one file each under `steps/<kind>.ts`. A new step kind brings
 * its own label, icon, group and fresh step there; nothing in this file or in
 * stepCatalog.ts changes for it.
 *
 * Editor components import stepMeta, paletteGroups and newStep from here.
 * stepKinds.lockstep.test.ts holds the files under `steps/` to the server's
 * registry (server/appStudio/componentSpecs/steps/).
 */
import {
    STEP_CATALOG, STEP_GROUPS, groupLabel, newStep as baseNewStep, paletteGroups as basePaletteGroups, stepMeta as baseStepMeta,
} from './stepCatalog';
import type { ActionStep, StepMeta } from './stepCatalog';
import type { TranslateFn } from '@/hooks/useTranslation';

export type { ActionStep };

/** What the editor fills in when a step lands on the canvas. */
interface NewStepOptions { screenId?: string; modalId?: string; t?: TranslateFn | null }

/** One registry step kind, as its file under `steps/` exports it (the default export). */
export interface StepKindModule {
    kind: string;
    meta: StepMeta;
    /** A fresh step of this kind, valid the moment it lands (every required field present). */
    newStep: (opts: NewStepOptions) => ActionStep;
    /** What a field of this kind says and offers where the defaults of the settings panel do not fit. */
    fields?: Record<string, StepFieldDress>;
}

/** A [translation key, English text] pair. */
type TextPair = [string, string];

/** One field of a registry kind in the settings panel (StepSettings). */
interface StepFieldDress {
    label?: TextPair;
    hint?: TextPair;
    /** The reference list a picker field offers instead of its default one (a key of useStepReferences' options). */
    options?: string;
}

export interface StepKindCatalog {
    /** The registry kinds, by kind, in file order. */
    extension: Record<string, StepKindModule>;
    stepMeta: (kind: string, t?: TranslateFn | null) => StepMeta;
    paletteGroups: (t?: TranslateFn | null) => Array<{ group: string; label: string; kinds: Array<StepMeta & { kind: string }> }>;
    newStep: (kind: string, opts?: NewStepOptions) => ActionStep;
}

/**
 * The catalog over the base kinds plus `modules` (what `import.meta.glob` hands
 * over: path → module). A file whose kind is a base kind, or is not its own
 * file name, is a mistake in that file and throws when the editor loads.
 */
export function buildStepKinds(modules: Record<string, { default: StepKindModule }>): StepKindCatalog {
    const extension: Record<string, StepKindModule> = {};
    for (const file of Object.keys(modules).sort()) {
        const entry = modules[file].default;
        const name = file.slice(file.lastIndexOf('/') + 1, file.lastIndexOf('.'));
        if (!entry || entry.kind !== name) throw new Error(`Step kind file ${file} must export its own kind as default`);
        if (Object.hasOwn(STEP_CATALOG, name)) throw new Error(`Step kind file ${file} names a base step kind`);
        extension[name] = entry;
    }
    const own = (kind: string): StepKindModule | null => (Object.hasOwn(extension, kind) ? extension[kind] : null);

    const stepMeta = (kind: string, t: TranslateFn | null = null): StepMeta => {
        const entry = own(kind);
        if (!entry) return baseStepMeta(kind, t);
        if (!t) return entry.meta;
        return { ...entry.meta, label: t(entry.meta.labelKey, entry.meta.label), blurb: t(entry.meta.blurbKey, entry.meta.blurb) };
    };

    const paletteGroups = (t: TranslateFn | null = null) => {
        const groups = basePaletteGroups(t).map((g) => ({ ...g, kinds: [...g.kinds] }));
        // A group the base palette does not show yet (none of its kinds are base kinds) is added in the catalog's order, then any new group.
        const order = [...STEP_GROUPS, ...Object.values(extension).map((e) => e.meta.group).filter((g) => !STEP_GROUPS.includes(g))];
        for (const [kind, entry] of Object.entries(extension)) {
            let group = groups.find((g) => g.group === entry.meta.group);
            if (!group) {
                group = { group: entry.meta.group, label: groupLabel(entry.meta.group, t), kinds: [] };
                groups.push(group);
            }
            group.kinds.push({ kind, ...stepMeta(kind, t) });
        }
        return groups.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group));
    };

    const newStep = (kind: string, opts: NewStepOptions = {}): ActionStep => {
        const entry = own(kind);
        return entry ? entry.newStep(opts) : baseNewStep(kind, opts);
    };

    return { extension, stepMeta, paletteGroups, newStep };
}

// No type argument on the call, on purpose: vitest keeps a transformed module on disk
// between runs unless its text holds the call exactly as `import.meta.glob(`, and a
// kept copy would not see a file added to the folder.
const catalog = buildStepKinds(import.meta.glob(['./steps/*.ts', '!./steps/*.test.ts'], { eager: true }) as Record<string, { default: StepKindModule }>);

/** The registry kinds the editor knows, by kind. */
export const EXTENSION_STEP_KINDS = catalog.extension;
export const { stepMeta, paletteGroups, newStep } = catalog;
