/**
 * A page's design controls (`settings.design`), as the web's Design tab
 * offers them (DocumentWorkspacePanel.jsx PRESETS and fields). The server's
 * composer reads them; design.lockstep.test.ts holds PRESETS to the web's.
 */

type Loose = Record<string, unknown>;

export const DESIGN_PRESETS = {
    neutral: { accent: '#334155', ink: '#172033', font: 'sans', fontSize: 11, lineHeight: 1.5, margin: 18 },
    branded: { accent: '#d97706', ink: '#172033', font: 'sans', fontSize: 11, lineHeight: 1.6, margin: 18 },
    formal: { accent: '#1e3a5f', ink: '#172033', font: 'serif', fontSize: 12, lineHeight: 1.6, margin: 22 },
} as const;
export type DesignPreset = keyof typeof DESIGN_PRESETS;

/** The number fields: key, minimum, maximum, step and the value shown when unset. */
export const DESIGN_NUMBERS = [
    { key: 'fontSize', min: 8, max: 24, step: 1, fallback: 11 },
    { key: 'lineHeight', min: 1, max: 2.5, step: 0.1, fallback: 1.5 },
    { key: 'margin', min: 0, max: 40, step: 1, fallback: 18 },
    { key: 'logoWidth', min: 10, max: 80, step: 1, fallback: 24 },
] as const;
export type DesignNumberKey = (typeof DESIGN_NUMBERS)[number]['key'];

/** Choosing a preset replaces the design with it, as the web does. */
export function applyPreset(preset: DesignPreset): Loose {
    return { ...DESIGN_PRESETS[preset], preset };
}

/** One control changed: the neutral preset fills anything never chosen. */
export function setDesignValue(design: Loose, key: string, value: unknown): Loose {
    return { ...DESIGN_PRESETS.neutral, ...design, [key]: value };
}

export function presetOf(design: Loose): DesignPreset {
    const preset = design.preset;
    return preset === 'branded' || preset === 'formal' ? preset : 'neutral';
}

/** A #rgb or #rrggbb colour, the only form the web's colour input produces. */
export const isHexColour = (value: unknown): boolean => typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);

/** A design value as a finite number within its bounds, or null. */
export function clampNumber(text: string, spec: { min: number; max: number }): number | null {
    const n = Number(text.replace(',', '.'));
    if (text.trim() === '' || !Number.isFinite(n)) return null;
    return Math.min(spec.max, Math.max(spec.min, n));
}
