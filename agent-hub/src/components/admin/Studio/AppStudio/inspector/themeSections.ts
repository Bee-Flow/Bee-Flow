/**
 * App Studio inspector: sections of the theme panel that are added as files.
 *
 * The panel's own sections (this screen, look, app theme, design, navigation, app, AI
 * browsing) are written out in ThemePanel.tsx. A section added later is one file,
 * themeSections/<name>.tsx, whose default export is
 *
 *   export default { order: 20, Section: MySection };
 *
 * `Section` gets the props of ThemeSectionProps and draws its own title and fields. The
 * files are found by import.meta.glob and drawn between Navigation and App, by `order`
 * (default 100) and then by file name, so adding a section never edits the panel. The
 * directory ships empty.
 */

import type { AppDefinition } from './appDefinition';
import type { ComponentType } from 'react';

export interface ThemeSectionProps {
    definition: AppDefinition;
    /** Called with the next definition; a section commits each change at once, like the panel. */
    onCommit: (definition: AppDefinition) => void;
    disabled: boolean;
    /** The screen on the canvas, or null. */
    screenId: string | null;
}

export interface ThemeSectionEntry {
    /** Where the section sits among the added ones: lower first. Default 100. */
    order?: number;
    Section: ComponentType<ThemeSectionProps>;
}

export interface RegisteredThemeSection extends ThemeSectionEntry {
    name: string;
}

type SectionModules = Record<string, { default?: ThemeSectionEntry }>;

function sectionModules(): SectionModules {
    try {
        // No type argument on the call, on purpose: vitest keeps a transformed module on disk
        // between runs unless its text holds the call exactly as `import.meta.glob(`, and a
        // kept copy would not see a file added to the folder.
        return import.meta.glob(['./themeSections/*.tsx', '!./themeSections/*.test.tsx'], { eager: true }) as Record<string, { default?: ThemeSectionEntry }>;
    } catch {
        return {};
    }
}

function nameOfPath(file: string): string {
    const name = file.slice(file.lastIndexOf('/') + 1);
    return name.endsWith('.tsx') ? name.slice(0, -'.tsx'.length) : name;
}

const orderOf = (entry: ThemeSectionEntry): number => (Number.isFinite(entry.order) ? Number(entry.order) : 100);

/** The sections of `modules`, by `order` and then by file name. */
export function collectThemeSections(modules: SectionModules): RegisteredThemeSection[] {
    const out: RegisteredThemeSection[] = [];
    for (const file of Object.keys(modules).sort()) {
        const entry = modules[file]?.default;
        if (!entry || !entry.Section) throw new Error(`themeSections/${nameOfPath(file)}.tsx: the default export holds Section`);
        out.push({ ...entry, name: nameOfPath(file) });
    }
    // Array.prototype.sort is stable, so equal orders keep the file-name order.
    return out.sort((a, b) => orderOf(a) - orderOf(b));
}

export const THEME_SECTIONS: readonly RegisteredThemeSection[] = collectThemeSections(sectionModules());
