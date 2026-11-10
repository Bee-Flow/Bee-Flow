/**
 * Catalog lockstep.
 *
 * server/appStudio/componentSpecs.js is the single source of truth for the
 * component catalog. The web bundles a generated slice of it,
 * catalogSnapshot.generated.json (scripts/gen-app-catalog.mjs, `npm run
 * gen:shared`), and derives from it:
 *   - runtime/componentRegistry.ts   (label/category/defaults beside the renderers)
 *   - inspector/styleKnobMeta.ts     (style knobs, input types, screen enums, ...)
 *   - inspector/typeEventLists.ts    (generated TypeScript, also mirrored to the phone)
 *
 * lint:shared-mirror fails on a stale snapshot; this test fails on one too
 * (it rebuilds the snapshot from the server file, CJS via createRequire, which
 * is dependency-free plain data), and pins what the derivation cannot: every
 * spec type has a renderer and an icon, and the hand-kept pieces stay inside
 * the spec's vocabulary.
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, it, expect } from 'vitest';
import { MAX_CALL_DEPTH } from './actionRunner/stepWalk';
import snapshot from './catalogSnapshot.generated.json';
import { APP_COMPONENT_TYPES, PALETTE_CATEGORIES } from './componentRegistry';
import { buildSnapshot, renderTypeEventLists } from '../../../../../../../scripts/gen-app-catalog.mjs';
import {
    COLOR_ROLES as FE_COLOR_ROLES,
    STYLE_KNOBS as FE_STYLE_KNOBS,
    SECTION_STYLE_KNOBS as FE_SECTION_STYLE_KNOBS,
    SECTION_STYLE_DEFAULTS as FE_SECTION_STYLE_DEFAULTS,
    TYPE_EVENT_LISTS,
    TYPE_EVENTS,
    INPUT_TYPES as FE_INPUT_TYPES,
    SCREEN_ENUMS as FE_SCREEN_ENUMS,
    SCREEN_DEFAULTS as FE_SCREEN_DEFAULTS,
    FORMULA_SCOPE_ROOTS as FE_FORMULA_SCOPE_ROOTS,
    getKnobsForType,
} from '../inspector/styleKnobMeta';

const require = createRequire(import.meta.url);
const specs = require('../../../../../../../server/appStudio/componentSpecs.js');
const typeEventListsSource = readFileSync(require.resolve('../inspector/typeEventLists.ts'), 'utf8');

const {
    COMPONENT_SPECS,
    COMPONENT_TYPES,
    INPUT_TYPES,
    EVENT_NAMES,
    STYLE_KNOBS,
    COLOR_ROLES,
    SECTION_STYLE_KNOBS,
    SECTION_STYLE_DEFAULTS,
    SCREEN_SPEC,
} = specs;

/**
 * The spec's per-prop defaults — exactly what canonicalize fills in. A prop marked since 3 or
 * higher is emit-when-present (canonicalize/shared.js isLateEntry): never filled, so not here.
 */
function specDefaultProps(spec) {
    const out = {};
    for (const [key, fs] of Object.entries(spec.props || {})) {
        if (Number.isInteger(fs.since) && fs.since > 2) continue;
        out[key] = fs.default === undefined ? null : fs.default;
    }
    return out;
}

describe('catalog lockstep — the generated files are fresh', () => {
    it('catalogSnapshot.generated.json is what the server spec generates', () => {
        expect(snapshot).toEqual(buildSnapshot(specs));
    });

    it('typeEventLists.ts is what the snapshot generates', () => {
        expect(typeEventListsSource).toBe(renderTypeEventLists(buildSnapshot(specs)));
    });
});

describe('catalog lockstep — componentRegistry.ts against componentSpecs.js', () => {
    it('has a registry entry for every catalog type, and no extras', () => {
        expect(Object.keys(APP_COMPONENT_TYPES).sort()).toEqual([...COMPONENT_TYPES].sort());
    });

    for (const type of Object.keys(COMPONENT_SPECS)) {
        const spec = COMPONENT_SPECS[type];
        it(`${type}: renderer, icon, label/category/container/isInput/defaults`, () => {
            const entry = APP_COMPONENT_TYPES[type];
            expect(entry, `missing registry entry for ${type}`).toBeTruthy();
            expect(typeof entry.Component).toBe('function');
            expect(entry.icon, `${type} needs a palette icon`).toBeTruthy();
            expect(entry.label).toBe(spec.label);
            expect(entry.category).toBe(spec.category);
            expect(!!entry.container).toBe(!!spec.container);
            expect(!!entry.isInput).toBe(!!spec.isInput);
            expect(entry.defaultProps).toEqual(specDefaultProps(spec));
            expect(entry.defaultStyle).toEqual(spec.defaultStyle);
        });
    }

    it('palette categories cover every spec category', () => {
        const cats = new Set(Object.values(COMPONENT_SPECS).map((s) => s.category));
        for (const c of cats) expect(PALETTE_CATEGORIES).toContain(c);
    });
});

describe('catalog lockstep — styleKnobMeta.ts against componentSpecs.js', () => {
    for (const type of Object.keys(COMPONENT_SPECS)) {
        const spec = COMPONENT_SPECS[type];
        it(`${type}: style knobs and events match the server spec`, () => {
            expect(getKnobsForType(type)).toEqual(spec.styleKnobs);
            if (spec.events && spec.events.length) {
                expect(TYPE_EVENT_LISTS[type]).toEqual(spec.events);
            } else {
                expect(TYPE_EVENT_LISTS[type]).toBeUndefined();
            }
        });
    }

    it('TYPE_EVENTS (the wireable slot) is a subset of the spec events', () => {
        for (const [type, ev] of Object.entries(TYPE_EVENTS)) {
            expect(COMPONENT_SPECS[type], `TYPE_EVENTS has unknown type ${type}`).toBeTruthy();
            expect(COMPONENT_SPECS[type].events || []).toContain(ev);
        }
    });

    it('INPUT_TYPES matches the spec isInput classification exactly', () => {
        expect([...FE_INPUT_TYPES].sort()).toEqual([...INPUT_TYPES].sort());
    });

    it('STYLE_KNOBS / COLOR_ROLES / section knobs equal the spec', () => {
        expect(FE_STYLE_KNOBS).toEqual(STYLE_KNOBS);
        expect(FE_COLOR_ROLES).toEqual(COLOR_ROLES);
        expect(FE_SECTION_STYLE_KNOBS).toEqual(SECTION_STYLE_KNOBS);
        expect(FE_SECTION_STYLE_DEFAULTS).toEqual(SECTION_STYLE_DEFAULTS);
    });

    it('SCREEN_ENUMS mirrors the enum-valued SCREEN_SPEC fields', () => {
        for (const [key, values] of Object.entries(FE_SCREEN_ENUMS)) {
            const spec = SCREEN_SPEC[key];
            expect(spec, `SCREEN_SPEC has no ${key}`).toBeTruthy();
            expect(spec.type).toBe('enum');
            expect(values).toEqual(spec.values);
            expect(FE_SCREEN_DEFAULTS[key]).toEqual(spec.default);
        }
    });

    // The expression editor's inline autocomplete completes exactly these, so a
    // root added server-side but missing here silently stops autocompleting —
    // the failure mode is "the feature looks broken for the new root", which is
    // invisible until someone reports it.
    it('FORMULA_SCOPE_ROOTS equals the spec list', () => {
        expect(FE_FORMULA_SCOPE_ROOTS).toEqual(specs.FORMULA_SCOPE_ROOTS);
    });

    // call_action: the browser refuses a chain deeper than the validator allows.
    it('MAX_CALL_DEPTH matches LIMITS.MAX_CALL_DEPTH', () => {
        expect(MAX_CALL_DEPTH).toBe(specs.LIMITS.MAX_CALL_DEPTH);
    });

    it('every event a spec declares is in the global EVENT_NAMES vocabulary', () => {
        for (const [type, spec] of Object.entries(COMPONENT_SPECS)) {
            for (const ev of spec.events || []) {
                expect(EVENT_NAMES, `${type} event ${ev}`).toContain(ev);
            }
        }
        expect(EVENT_NAMES).toContain('onCardMove');
    });
});
