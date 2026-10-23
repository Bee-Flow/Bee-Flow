import type { AppDefinition, AppScreen } from './appDefinition';

/** The screen members this panel reads and writes. */
export type ScreenView = AppScreen & { maxWidth?: string; refreshInterval?: number; icon?: string; description?: string; showInNav?: boolean };

export type ScreenPatch = { maxWidth?: string; refreshInterval?: number; icon?: string | null; description?: string | null; showInNav?: boolean };

export type ThemeValues = Record<string, string | undefined>;

/**
 * One of the theme's OPTIONAL colours (accent, canvas): off means "unset" —
 * the consumer's own fallback applies — and on hands the picker a colour to
 * start from. Committing null is how the key clears (the canonicalizer then
 * drops it), so a theme that never chose stays byte-identical.
 */
export interface OptionalColorFieldProps {
    label: string;
    hint: string;
    value: string | null;
    onChange: (hex: string | null) => void;
    fallback: string;
    presets: string[];
    disabled: boolean;
    ariaLabel: string;
}

export interface SectionTitleProps {
    children?: React.ReactNode;
}

/**
 * The settings of the screen you are currently looking at. Extracted from
 * ThemePanel purely for length — it is only ever rendered there.
 */
export interface ScreenSettingsProps {
    screen: ScreenView | null;
    onCommit: (patch: ScreenPatch) => void;
    disabled: boolean;
}

/** @param {import('./ThemePanel.types').ThemePanelProps} props */
export interface ThemePanelProps {
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
    screenId?: string | null | undefined;
}

/**
 * AI browsing — the OWNER's switch.
 *
 * An `ai_browse` step drives a real headless browser as the app owner. The AI
 * that authors the app can add such a step, but it can never switch this on:
 * the key is absent from the builder tool schemas on purpose, and the validator
 * refuses the step (`browse.not_enabled`) until a human turns it on here.
 *
 * The domain list is the second half of that decision. Empty means "anywhere
 * the SSRF guard allows", which is a real choice but rarely the right one for
 * an app that browses on a viewer's behalf.
 */
export interface AiBrowsingSettingsProps {
    value: Record<string, unknown> | null;
    onCommit: (patch: { enabled?: boolean; allowedDomains?: string[] }) => void;
    disabled: boolean;
}
