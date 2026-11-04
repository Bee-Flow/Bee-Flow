type Tr = (key: string, fallback: string, vars?: Record<string, unknown>) => string;

/** The sanitiser's word labels, in the reader's language; the CSS tokens (`@import`, `url()`) stay as they are. */
const WORD_LABELS: Record<string, [string, string]> = {
    'outside address': ['forms.style.removed_outside_address', 'an address on another site'],
    'unbalanced }': ['forms.style.removed_unbalanced', 'a brace that does not match'],
    'sibling selector': ['forms.style.removed_sibling', 'a selector that reaches outside the form'],
    'over 20000 characters': ['forms.style.removed_too_long', 'everything: the CSS is over the limit'],
};

export function removedLabel(label: string, t: Tr): string {
    const word = WORD_LABELS[label];
    return word ? t(word[0], word[1]) : label;
}
