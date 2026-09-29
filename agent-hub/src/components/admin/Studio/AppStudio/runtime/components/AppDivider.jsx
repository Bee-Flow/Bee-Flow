/** App Studio runtime — 'divider'. Spec: server/appStudio/componentSpecs.js. */

export default function AppDivider({ node } = {}) {
    // 'vertical': a 1px upright rule for flex rows (a page_header's action
    // area, a horizontal pane). The wrapper cell is the flex item, so
    // runtime.css stretches it (align-self) and this hr fills it; min-height
    // keeps the rule visible where nothing stretches. Horizontal — and any
    // unknown value — is the identity path: the exact original <hr>.
    if (node?.props?.orientation === 'vertical') {
        return (
            <hr
                aria-orientation="vertical"
                data-app-divider="vertical"
                className="self-stretch h-auto w-px shrink-0 border-0"
                style={{ background: 'var(--border-default)', minHeight: '1.25rem' }}
            />
        );
    }
    return <hr className="border-t w-full" style={{ borderColor: 'var(--border-default)' }} />;
}
