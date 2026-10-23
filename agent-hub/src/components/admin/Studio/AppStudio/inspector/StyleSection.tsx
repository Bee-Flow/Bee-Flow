import useTranslation from '../../../../../hooks/useTranslation';
import { SelectField, NumberField } from './panels/kit';
import {
    STYLE_KNOBS,
    SECTION_STYLE_KNOBS,
    SECTION_STYLE_DEFAULTS,
    getKnobsForType,
    advancedKnobsFor,
    effectiveSizeMode,
    unitRange,
    clampKnob,
    knobLabel,
    valueLabel,
} from './styleKnobMeta';
import TokenColorField from './TokenColorField';
import Disclosure from '../../../../shared/Disclosure';
import FormField from '../../../../shared/FormField';
import SegmentedControl from '../../../../shared/SegmentedControl';
import Slider from '../../../../shared/Slider';
import { updateNodeStyle } from '../state/definitionOps';
import type { AppDefinition, AppNode } from './appDefinition';
import type { KnobSpec } from './styleKnobMeta.types';
import type { TranslateParams } from '../../../../../hooks/useTranslation';
type EnumSpec = Extract<KnobSpec, { type: 'enum' }>;
type UnitIntSpec = Extract<KnobSpec, { type: 'unitInt' }>;

/**
 * StyleSection — renders ONLY the style knobs the selected type supports
 * (per-type lists mirrored from server/appStudio/componentSpecs.js in
 * styleKnobMeta.js) and commits every change immediately via
 * updateNodeStyle + onCommit(nextDef). NO debounce — the canvas is a live
 * preview and the shell's history coalesces rapid edits upstream.
 *
 * Two variants:
 *   node    — pass `node`; knobs come from the node's type.
 *   section — pass `sectionId`; knobs are the section trio (padding/gap/
 *             background). definitionOps.findNode only resolves component
 *             nodes, so the section lookup/patch helpers live here.
 */

// ---------------------------------------------------------------------------
// Section helpers — findNode/updateNodeStyle don't resolve section ids.
// ---------------------------------------------------------------------------

/**
 * @param {import('./appDefinition').AppDefinition | null | undefined} def
 * @param {string | null | undefined} sectionId
 * @returns {{ section: import('./appDefinition').AppSection, screen: import('./appDefinition').AppScreen } | null}
 *   The section and the screen holding it; null when no section has that id.
 */
export function findSectionById(def: AppDefinition, sectionId: string) {
    for (const screen of def?.screens || []) {
        for (const section of screen.sections || []) {
            if (section.id === sectionId) return { section, screen };
        }
    }
    return null;
}

/**
 * Shallow-merge a style patch into a section (structural sharing; same def when a no-op).
 * @param {import('./appDefinition').AppDefinition} def
 * @param {string} sectionId
 * @param {Record<string, unknown> | null | undefined} patch
 * @returns {import('./appDefinition').AppDefinition} `def` itself when nothing changes.
 */
export function updateSectionStyle(def: AppDefinition, sectionId: string, patch: Record<string, unknown> | null | undefined) {
    if (!patch || typeof patch !== 'object') return def;
    const screens = def.screens || [];
    for (let s = 0; s < screens.length; s++) {
        const sections = screens[s].sections || [];
        for (let j = 0; j < sections.length; j++) {
            const section = sections[j];
            if (section.id !== sectionId) continue;
            const current = (section.style as Record<string, unknown> | undefined) || {};
            if (Object.keys(patch).every((k) => Object.is(current[k], patch[k]))) return def;
            const nextSections = sections.slice();
            nextSections[j] = { ...section, style: { ...current, ...patch } };
            const nextScreens = screens.slice();
            nextScreens[s] = { ...screens[s], sections: nextSections };
            return { ...def, screens: nextScreens };
        }
    }
    return def;
}

// ---------------------------------------------------------------------------
// Knob presentation
// ---------------------------------------------------------------------------


// SegmentedControl values must be string|number — the radius knob's null
// ("inherit the theme") rides a sentinel and is mapped back on commit.
const INHERIT = '__inherit';

function enumOptions(t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string, knob: string, values: (string | number | null)[] = (STYLE_KNOBS[knob] as EnumSpec).values as (string | number | null)[]) {
    return values.map((v) => (
        v === null
            ? { value: INHERIT, label: t('studio_apps_insp.style.inherit', 'Inherit') }
            : { value: v, label: valueLabel(v, t) }
    ));
}

// ---------------------------------------------------------------------------
// Advanced sizing — one disclosure, deliberately closed.
//
// The column slider stays the primary control because it is right almost
// always: it is the one that keeps the layout responsive. Exact px/% is the
// escape hatch for the cases columns genuinely cannot express (a 180px logo
// strip, a 60%-of-its-card signature block), so it sits behind a click instead
// of in front of every author.
// ---------------------------------------------------------------------------

const sizingHints = (t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string): Record<string, string> => ({
    widthMode: t('studio_apps_insp.style.width_mode_hint', 'Columns place the block in the 12-column grid; px and % size the box inside the space those columns reserved. Wide values still shrink to fit on a phone.'),
    heightMode: t('studio_apps_insp.style.height_mode_hint', 'Preset keeps the Height control above (including “Fill”). % needs an enclosing card, pane or section with a fixed height — use vh for a share of the screen.'),
});

/** One mode/value pair: the unit picker, plus the number when a unit is chosen. */
interface SizingPairProps {
    modeKnob: string;
    valueKnob: string;
    style: Record<string, unknown>;
    modeValues: (string | number)[];
    commitPair: (next: string | number | null, n?: number | null) => void;
    disabled: boolean;
}

function SizingPair({ modeKnob, valueKnob, style, modeValues, commitPair, disabled }: SizingPairProps) {
    const { t } = useTranslation();
    const mode = effectiveSizeMode(style, valueKnob);
    const range = unitRange(valueKnob, mode);
    const value = style[valueKnob] as number | undefined;

    return (
        <div className="flex flex-col gap-2">
            <FormField label={knobLabel(modeKnob, t)} hint={sizingHints(t)[modeKnob]}>
                <SegmentedControl
                    value={mode as string}
                    onChange={(next) => commitPair(next)}
                    options={enumOptions(t, modeKnob, modeValues)}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={knobLabel(modeKnob, t)}
                />
            </FormField>
            {range ? (
                <NumberField
                    label={`${knobLabel(valueKnob, t)} (${valueLabel(mode as string, t)})`}
                    value={Number.isFinite(value) ? value : null}
                    onChange={(n) => commitPair(mode, n)}
                    step={range.step}
                    hint={`${range.min}–${range.max}${mode === 'pct' ? '%' : mode}`}
                    disabled={disabled}
                />
            ) : null}
        </div>
    );
}

/**
 * The disclosure itself: whichever pairs this knob list has earned.
 *
 * Modes and values are committed TOGETHER — half a pair (a number with no unit,
 * or a unit with no number) renders as if the knob were never touched, and the
 * server rejects it with style.unit_without_mode / style.mode_without_value.
 * Picking a unit therefore seeds that unit's default so the knob does something
 * the instant it is switched on, and switching back to Columns/Preset clears
 * the number so canonicalize drops it and the block stores nothing dead.
 */
interface AdvancedSizingProps {
    knobs: string[];
    style: Record<string, unknown>;
    patch: (p: Record<string, unknown>) => void;
    isSection: boolean;
    disabled: boolean;
}

function AdvancedSizing({ knobs, style, isSection, patch, disabled }: AdvancedSizingProps) {
    const { t } = useTranslation();
    // Derived, never listed per type (styleKnobMeta mirrors expandStyleKnobs):
    // width refines `span`, height refines `height`.
    const advanced = advancedKnobsFor(knobs);
    if (!advanced.length) return null;

    // A section is a flex item in the screen's flowing height, so a percentage
    // has nothing to measure — the server rejects 'pct' there, and offering a
    // knob that cannot work is worse than not offering it.
    const heightModes = isSection
        ? (STYLE_KNOBS.heightMode.values as string[]).filter((v) => v !== 'pct')
        : (STYLE_KNOBS.heightMode.values as string[]);

    const commitPair = (valueKnob: string) => (mode: string | number | null, rawValue?: number | null) => {
        const { modeKnob } = STYLE_KNOBS[valueKnob] as UnitIntSpec;
        const range = unitRange(valueKnob, mode as string | null);
        if (!range) { patch({ [modeKnob]: mode, [valueKnob]: null }); return; }
        const seed = rawValue === undefined
            ? (Number.isFinite(style[valueKnob]) ? style[valueKnob] : range.default)
            : rawValue;
        patch({
            [modeKnob]: mode,
            [valueKnob]: seed === null ? null : clampKnob(valueKnob, seed, { [modeKnob]: mode }),
        });
    };

    return (
        <Disclosure title={t('studio_apps_insp.style.advanced_sizing', 'Advanced sizing')} hint={t('studio_apps_insp.style.advanced_sizing_hint', 'Exact pixels, percent or screen height')}>
            <div className="flex flex-col gap-4 pt-3">
                {advanced.includes('widthMode') && (
                    <SizingPair
                        modeKnob="widthMode"
                        valueKnob="widthValue"
                        style={style}
                        modeValues={STYLE_KNOBS.widthMode.values as string[]}
                        commitPair={commitPair('widthValue')}
                        disabled={disabled}
                    />
                )}
                {advanced.includes('heightMode') && (
                    <SizingPair
                        modeKnob="heightMode"
                        valueKnob="heightValue"
                        style={style}
                        modeValues={heightModes}
                        commitPair={commitPair('heightValue')}
                        disabled={disabled}
                    />
                )}
            </div>
        </Disclosure>
    );
}

/**
 * Responsive visibility — hideBelow/hideAbove, derived from `span` exactly
 * like the width pair (a type without a grid cell has nothing to hide). Bands
 * are the runtime breakpoints: sm=640, md=1024, lg=1280. On the editor canvas
 * a hidden node stays visible (runtime.css guards on data-app-edit), so these
 * knobs only change the RUN view — hence a disclosure, not a primary control.
 */
interface ResponsiveVisibilityProps {
    knobs: string[];
    style: Record<string, unknown>;
    patch: (p: Record<string, unknown>) => void;
    disabled: boolean;
}

function ResponsiveVisibility({ knobs, style, patch, disabled }: ResponsiveVisibilityProps) {
    const { t } = useTranslation();
    if (!advancedKnobsFor(knobs).includes('hideBelow')) return null;
    const current = (knob: string) => ((STYLE_KNOBS[knob] as EnumSpec).values.includes(style[knob]) ? style[knob] : 'none') as string;
    return (
        <Disclosure title={t('studio_apps_insp.style.responsive', 'Responsive')} hint={t('studio_apps_insp.style.responsive_hint', 'Hide on narrow or wide viewports')}>
            <div className="flex flex-col gap-4 pt-3">
                {['hideBelow', 'hideAbove'].map((knob) => (
                    <FormField key={knob} label={knobLabel(knob, t)}>
                        <SegmentedControl
                            value={current(knob)}
                            onChange={(v) => patch({ [knob]: v })}
                            options={enumOptions(t, knob)}
                            size="sm"
                            fullWidth
                            disabled={disabled}
                            ariaLabel={knobLabel(knob, t)}
                        />
                    </FormField>
                ))}
            </div>
        </Disclosure>
    );
}

/**
 * @typedef {object} StyleSectionProps
 * @property {import('./appDefinition').AppDefinition | null} [definition] Read through `?.`.
 * @property {import('./appDefinition').AppNode | null} [node] Node variant: knobs come from its type.
 * @property {string | null} [sectionId] Section variant (wins over `node`): the section trio of knobs.
 * @property {(next: import('./appDefinition').AppDefinition) => void} onCommit Called without a guard.
 * @property {boolean} [disabled]
 */

/** @param {StyleSectionProps} props */
interface StyleSectionProps {
    definition: AppDefinition;
    node?: AppNode | null;
    sectionId?: string | null;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
}

export default function StyleSection({
    definition,
    node = null,
    sectionId = null,
    onCommit,
    disabled = false,
}: StyleSectionProps) {
    const { t } = useTranslation();
    const isSection = sectionId != null;
    const knobs = isSection ? SECTION_STYLE_KNOBS : getKnobsForType(node?.type);
    const style = isSection
        ? { ...SECTION_STYLE_DEFAULTS, ...(findSectionById(definition, sectionId)?.section?.style || {}) }
        : (node?.style || {});

    if (!knobs.length) return null;

    const patch = (p: Record<string, unknown>) => {
        const next = isSection
            ? updateSectionStyle(definition, sectionId, p)
            : (node ? updateNodeStyle(definition, node.id, p) : definition);
        if (next !== definition) onCommit(next);
    };

    const commit = (knob: string, rawValue: string | number | null) => patch({ [knob]: clampKnob(knob, rawValue, style) });

    const current = (knob: string) => (style[knob] !== undefined ? style[knob] : STYLE_KNOBS[knob]?.default);

    return (
        <div className="flex flex-col gap-4">
            {knobs.map((knob) => {
                const spec = STYLE_KNOBS[knob];
                if (!spec) return null;

                if (spec.type === 'int') {
                    return (
                        <Slider
                            key={knob}
                            label={knobLabel(knob, t)}
                            value={(Number.isFinite(current(knob)) ? current(knob) : spec.default) as number}
                            onChange={(v) => commit(knob, v)}
                            min={spec.min}
                            max={spec.max}
                            step={spec.step}
                            suffix={knob === 'span' ? ' col' : ''}
                            disabled={disabled}
                        />
                    );
                }

                if (spec.type === 'colorOrRole') {
                    return (
                        <FormField key={knob} label={knobLabel(knob, t)}>
                            <TokenColorField
                                value={current(knob) as string | null | undefined}
                                onChange={(v) => commit(knob, v)}
                                themePrimary={(definition?.theme as { primary?: string } | undefined)?.primary || null}
                                disabled={disabled}
                            />
                        </FormField>
                    );
                }

                // enum knob
                const value = current(knob) as string | number | null;
                // Background outgrew a segmented row when the look pass
                // appended panel/gradient: five values, two of them long
                // words, overflow the 320px panel's pills — this one knob
                // renders as the house select instead.
                if (knob === 'background') {
                    return (
                        <SelectField
                            key={knob}
                            label={knobLabel(knob, t)}
                            value={value}
                            onChange={(v) => commit(knob, v)}
                            options={enumOptions(t, knob)}
                            disabled={disabled}
                        />
                    );
                }
                return (
                    <FormField key={knob} label={knobLabel(knob, t)}>
                        <SegmentedControl
                            value={value === null ? INHERIT : value}
                            onChange={(v) => commit(knob, v === INHERIT ? null : v)}
                            options={enumOptions(t, knob)}
                            size="sm"
                            fullWidth
                            disabled={disabled}
                            ariaLabel={knobLabel(knob, t)}
                        />
                    </FormField>
                );
            })}

            <AdvancedSizing knobs={knobs} style={style} isSection={isSection} patch={patch} disabled={disabled} />
            <ResponsiveVisibility knobs={knobs} style={style} patch={patch} disabled={disabled} />
        </div>
    );
}
