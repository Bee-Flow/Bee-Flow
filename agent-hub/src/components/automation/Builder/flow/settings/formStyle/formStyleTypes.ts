import type { Style, Theme } from './stylePresets';

/** One edit of the form's look: the theme, the style, or both in one go (inheriting clears both). */
export interface StyleChangeSet {
    theme?: Theme | null;
    style?: Style | undefined;
}

export type StyleChange = (changes: StyleChangeSet) => void;
