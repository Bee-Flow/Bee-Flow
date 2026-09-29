import { fillRowTemplate, isFill, spaceSteps } from '../styleResolver';

/**
 * App Studio runtime — 'tab' (container). Spec: server/appStudio/componentSpecs.js.
 * A single tab panel: renders its children on the tab's own 12-column grid.
 * The tab strip + active-tab selection live in the parent AppTabs.
 *
 * The fill branch mirrors AppContainer exactly: a grid whose single implicit
 * row is auto-sized leaves its children at content height, so without
 * gridTemplateRows the panel would stretch while nothing inside it did.
 */

export default function AppTab({ node, children }) {
    const gap = Number.isFinite(node.style?.gap) ? node.style.gap : 3;
    const padding = Number.isFinite(node.style?.padding) ? node.style.padding : 0;
    const fill = isFill(node);
    return (
        <div
            className={`app-grid${fill ? ' app-fill h-full min-h-0' : ''}`}
            style={{
                gridTemplateColumns: 'repeat(12, minmax(0, 1fr))',
                gap: spaceSteps(gap),
                padding: padding > 0 ? spaceSteps(padding) : undefined,
                ...(fill ? { gridTemplateRows: fillRowTemplate(node) } : null),
            }}
        >
            {children}
        </div>
    );
}
