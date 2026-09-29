/** App Studio runtime — 'heading'. Spec: server/appStudio/componentSpecs.js. */

const LEVEL_TAGS = { 1: 'h1', 2: 'h2', 3: 'h3' };
const LEVEL_CLASSES = {
    1: 'text-2xl font-semibold',
    2: 'text-xl font-semibold',
    3: 'text-lg font-medium',
};

/**
 * Look pass — `accent` (spec: componentSpecs.js). 'none' (default) takes the
 * untouched original path below; 'bar' and 'tinted' are additive registers.
 * Everything is derived from the theme tokens — no literal colors here, so the
 * accents follow the app's primary in every host theme.
 */
export default function AppHeading({ node }) {
    const { text = 'Heading', level = 2, accent = 'none' } = node.props || {};
    const lvl = LEVEL_TAGS[level] ? level : 2;
    const Tag = LEVEL_TAGS[lvl];

    if (accent === 'bar') {
        // A short primary bar to the left of the text. The bar scales with the
        // heading's own font size (em) so h1..h3 all read balanced.
        return (
            <Tag className={`${LEVEL_CLASSES[lvl]} break-words app-heading--bar flex items-center gap-2`}>
                <span
                    aria-hidden="true"
                    style={{
                        width: '0.25rem',
                        height: '1.1em',
                        borderRadius: '999px',
                        background: 'var(--app-primary)',
                        flexShrink: 0,
                    }}
                />
                {text}
            </Tag>
        );
    }

    if (accent === 'tinted') {
        // A soft primary pill behind the title, title set in the primary color.
        // fit-content keeps the pill hugging the text instead of banding the row.
        return (
            <Tag
                className={`${LEVEL_CLASSES[lvl]} break-words app-heading--tinted`}
                style={{
                    background: 'var(--app-primary-soft)',
                    color: 'var(--app-primary)',
                    borderRadius: 'var(--app-radius, 8px)',
                    padding: '0.125em 0.5em',
                    width: 'fit-content',
                }}
            >
                {text}
            </Tag>
        );
    }

    // Color comes from the grid cell (color knob → inherit).
    return <Tag className={`${LEVEL_CLASSES[lvl]} break-words`}>{text}</Tag>;
}
