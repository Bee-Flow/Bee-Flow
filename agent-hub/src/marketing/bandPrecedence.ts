// A block can be painted twice: by its wrapper (`style.band`) and by its own
// section (`content.backgroundVariant`). A saturated band re-themes the text
// tokens for everything inside it, and the variant then fills the section with
// a colour computed from the same tokens: `band: dark` plus `variant: dark`
// gave dark text on a dark fill. The band wins; the variant is ignored.

const SATURATED_BANDS = new Set<unknown>(['dark', 'primary']);

/** The block content with its section background switched off when a saturated band already paints it. */
export function withBandPrecedence<T extends Record<string, unknown>>(content: T, style: { band?: unknown } | null | undefined): T {
    if (!style || !SATURATED_BANDS.has(style.band)) return content;
    const variant = content.backgroundVariant;
    if (variant === undefined || variant === null || variant === '' || variant === 'default') return content;
    return { ...content, backgroundVariant: 'default' };
}
