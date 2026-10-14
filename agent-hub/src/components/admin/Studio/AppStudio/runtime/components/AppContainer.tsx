import type { CSSProperties } from 'react';
import { fillRowTemplate, isFill, spaceSteps } from '../styleResolver';
import type { ComponentProps } from '../componentRegistry';

/**
 * App Studio runtime — 'container' (container). Spec: server/appStudio/componentSpecs.js.
 * A chrome-free card: no header, no default surface — the grid CELL carries
 * whatever padding/background/radius knobs the author set (resolveNodeStyle);
 * this component only lays the children out on its own 12-column grid.
 *
 * Look pass — `props.look` (spec: componentSpecs.js). 'plain' (default) stamps
 * no class and no extra style keys, so stored containers render byte-identically.
 * The other looks give the grouping a face without reaching for a card: all
 * values derive from the theme tokens (no literal colors), so dark mode and
 * high contrast keep working for free.
 */

const CONTAINER_LOOKS: Record<string, CSSProperties> = {
    // Recessed grouping surface — quiet, not elevated.
    panel: {
        background: 'var(--bg-secondary)',
        borderRadius: 'var(--app-radius, 8px)',
        padding: spaceSteps(4),
    },
    tinted: {
        background: 'var(--app-primary-soft)',
        borderRadius: 'var(--app-radius, 8px)',
        padding: spaceSteps(4),
    },
    outlined: {
        border: '1px solid var(--app-hairline, var(--border-default))',
        borderRadius: 'var(--app-radius, 8px)',
        padding: spaceSteps(4),
    },
};

export default function AppContainer({ node, children }: ComponentProps) {
    const styleGap = (node.style as { gap?: unknown } | undefined)?.gap;
    const gap = Number.isFinite(styleGap) ? styleGap as number : 3;
    // gridTemplateRows mirrors resolveSectionStyle's fill branch exactly: a grid
    // whose single implicit row is auto-sized leaves its children at content
    // height, so the container would grow while nothing inside it did.
    const fill = isFill(node);
    const look = (node.props as { look?: string } | undefined)?.look;
    const lookStyle = CONTAINER_LOOKS[look as string] || null; // 'plain' / unknown → identity
    return (
        <div
            className={`app-grid${fill ? ' app-fill h-full min-h-0' : ''}${lookStyle ? ` app-container--${look}` : ''}`}
            data-app-container="true"
            style={{
                gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
                gap: spaceSteps(gap),
                ...(fill ? { gridTemplateRows: fillRowTemplate(node) } : null),
                ...lookStyle,
            }}
        >
            {children}
        </div>
    );
}
