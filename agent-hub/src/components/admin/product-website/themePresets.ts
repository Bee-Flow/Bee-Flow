// The preset data is GENERATED from server/i18n/defaults/themePresets.js (the
// schema of record) into themePresets.generated.mjs by `npm run gen:shared`;
// change the server file and regenerate. themePresets.lockstep.test.ts holds
// the copy to its source. This module adds the client-only applyPreset.
//
// Applying a preset MATERIALIZES concrete values onto site.design, so the
// renderer never looks a preset up and editing one never changes an existing
// site — only what a fresh apply produces.

export { THEME_PRESETS, THEME_PRESET_IDS, BASE_COMPONENTS, BASE_LAYOUT } from './themePresets.generated.mjs';

// Merge a preset over the current design. Nested objects are re-cloned so a
// key the preset omits cannot leak through from the previous design.
// Logo/favicon (site identity) are deliberately preserved. Returns ONE
// object so the panel commits a single history entry and a single save.
export interface ThemePresetDesign {
    colors?: Record<string, unknown>;
    darkColors?: Record<string, unknown>;
    fonts?: Record<string, unknown>;
    typography?: Record<string, unknown>;
    components?: Record<string, unknown>;
    layout?: Record<string, unknown>;
    [key: string]: unknown;
}

export function applyPreset(currentDesign: Record<string, unknown> | null | undefined, preset: { id: string; design: ThemePresetDesign }): Record<string, unknown> {
    const d = currentDesign || {};
    return {
        ...d,
        ...preset.design,
        colors:     { ...preset.design.colors },
        darkColors: { ...preset.design.darkColors },
        fonts:      { ...preset.design.fonts },
        typography: { ...preset.design.typography },
        components: { ...preset.design.components },
        layout:     { ...preset.design.layout },
        logo:    d.logo    || '',
        favicon: d.favicon || '',
        preset:  preset.id,
    };
}
