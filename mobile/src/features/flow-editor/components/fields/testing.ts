/**
 * Test helpers for a field that shows its text as spans (PillTextInput): the
 * text a person sees, and the field showing a given text. RNTL's
 * `getByDisplayValue` reads a TextInput's `value`, which a pill field does not
 * have — its text is its children.
 */

import { screen } from '@testing-library/react-native';

type Element = ReturnType<typeof screen.getByTestId>;

const NBSP = / /g;

/** What a field shows, pill labels included; a pill's non-breaking spaces read as spaces. */
export function shownText(node: Element | string): string {
    if (typeof node === 'string') return node.replace(NBSP, ' ');
    return node.children.map((child) => shownText(child as Element | string)).join('');
}

/** The text field that shows exactly `text` (compared trimmed, spaces collapsed). */
export function getByShownText(text: string): Element {
    const tidy = (s: string) => s.replace(/\s+/g, ' ').trim();
    const matches = screen.root?.queryAll((n) => n.type === 'TextInput' && tidy(shownText(n)) === tidy(text)) ?? [];
    if (matches.length !== 1) throw new Error(`Expected one field showing "${text}", found ${matches.length}.`);
    return matches[0] as Element;
}
