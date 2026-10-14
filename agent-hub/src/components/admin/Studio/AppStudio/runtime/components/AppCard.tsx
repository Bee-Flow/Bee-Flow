import type { ReactNode } from 'react';
import { fillRowTemplate, isFill, spaceSteps } from '../styleResolver';
import type { ComponentProps } from '../componentRegistry';
import './AppCard.css';

/**
 * App Studio runtime — 'card' (container). Spec: server/appStudio/componentSpecs.js.
 * The grid CELL is the card surface (padding/background/radius come from the
 * node's style knobs via resolveNodeStyle); this component only renders the
 * optional header and the children on the card's own 12-column grid.
 *
 * Look pass — `props.look` (spec: componentSpecs.js). 'default' (and any
 * unknown value) stamps NO class, so stored cards render byte-identically.
 * A non-default look stamps `app-card--<look>` here; the actual restyling of
 * the CELL surface lives in AppCard.css, matched via :has() — see that file
 * for why the cell cannot be reached any other way from in here.
 */

interface CardProps {
    title?: ReactNode;
    description?: ReactNode;
    look?: string;
}

// Null-prototype lookup so 'constructor' etc. can never name a look.
const CARD_LOOKS: Record<string, boolean> = Object.assign(Object.create(null), {
    flat: true, raised: true, tinted: true, accent: true, gradient: true, solid: true,
});

/** ' app-card--<look>' for a known non-default look; '' (identity) otherwise. */
const cardLookClass = (look: string | undefined) => (CARD_LOOKS[look as string] ? ` app-card--${look}` : '');

export default function AppCard({ node, children }: ComponentProps) {
    const { title = null, description = null } = (node.props || {}) as CardProps;
    const styleGap = (node.style as { gap?: unknown } | undefined)?.gap;
    const gap = Number.isFinite(styleGap) ? styleGap as number : 3;
    const lookClass = cardLookClass((node.props as CardProps | undefined)?.look);
    // "A card wrapping a data grid" is the dashboard idiom, so a card that
    // swallows fill kills it one level in: the header keeps its size, the grid
    // takes the rest.
    const fill = isFill(node);
    return (
        <div className={`app-card flex flex-col${fill ? ' app-fill h-full min-h-0' : ''}${lookClass}`} style={{ gap: spaceSteps(2) }}>
            {(title || description) ? (
                <div className={fill ? 'shrink-0' : undefined}>
                    {title ? <div className="font-medium">{title}</div> : null}
                    {description ? (
                        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{description}</div>
                    ) : null}
                </div>
            ) : null}
            <div
                className={`app-grid${fill ? ' flex-1 min-h-0' : ''}`}
                style={{
                    gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
                    gap: spaceSteps(gap),
                    ...(fill ? { gridTemplateRows: fillRowTemplate(node) } : null),
                }}
            >
                {children}
            </div>
        </div>
    );
}
