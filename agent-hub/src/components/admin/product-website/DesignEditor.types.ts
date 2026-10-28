import type { DesignColors, EditableDesign } from '@/marketing/ProductWebsite.types';
import type { THEME_PRESETS } from './themePresets';

export type { DesignColors, EditableDesign };

export type ThemePreset = (typeof THEME_PRESETS)[number];

export interface DesignEditorProps {
    design?: EditableDesign | null;
    onChange: (next: EditableDesign) => void;
}
