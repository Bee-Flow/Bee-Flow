import type { AppDefinition } from './appDefinition';

/**
 * Props of ThemePanel (ThemePanel.jsx). `onCommit` is called without a guard;
 * the rest may be left out. The body reads `definition` through `?.`, so it
 * renders (empty) without one, and no `screenId` (or an unknown one) leaves the
 * screen block empty.
 */
export interface ThemePanelProps {
    definition?: AppDefinition | null;
    onCommit: (next: AppDefinition) => void;
    disabled?: boolean;
    /** The screen the canvas shows; its settings are edited next to the app theme. */
    screenId?: string | null;
}
