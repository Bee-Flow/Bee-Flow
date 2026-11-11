/**
 * app_screenshot's optional view arguments: render the screen the way a user sees it at a
 * given moment instead of as a bare first paint. The JSON schema fragment the tool schema
 * spreads in (schemasPart2.js), and the two small helpers the tool handler
 * (inspectionTools.js) uses. The arguments are checked against the definition by the render
 * service (services/appStudioRenderView.mts), which answers a plain sentence for a wrong id.
 * A screenshot never fires an action: state is a starting picture, not a sequence of clicks.
 */

export const SCREENSHOT_VIEW_PROPERTIES = Object.freeze({
    chrome: { type: 'boolean', description: 'true = render inside the real app chrome: the navigation (as nav.style sets it), the brand with its logo and the user menu. Default: the screen alone.' },
    state: {
        type: 'object',
        description: 'Show the screen in a state instead of its first paint, e.g. a detail screen with its record, an open dialog or the second tab. Nothing runs and nothing is saved.',
        properties: {
            vars: { type: 'object', description: 'Values for declared app variables, name to value, over their defaults. Bindings filtered on vars.* read their rows with these.' },
            screenParams: { type: 'object', description: 'screen.params of a detail screen, e.g. {"id": "<record id>"}.' },
            forms: { type: 'object', description: 'Field values per form name: {"<form name>": {"<field>": value}}. The inputs show them and formulas read them as form.* and forms.*.' },
            openModal: { type: 'string', description: 'Id of a modal on this screen to show open (cmp_…). The image then covers the whole page.' },
            activeTab: { type: 'array', items: { type: 'string' }, description: 'Ids of tab components to show (cmp_…), one per tab group.' },
        },
    },
    appearance: { type: 'string', enum: ['light', 'dark', 'auto'], description: 'Render with this theme.appearance instead of the app\'s own (this shot only).' },
    hostTheme: { type: 'string', enum: ['light', 'dark', 'high-contrast'], description: 'The platform theme around the app. An app on appearance auto follows it. Shoot high-contrast once: a card without a border disappears there.' },
    nodeId: { type: 'string', description: 'Crop the image to this one component of the screen (cmp_…), to read a detail at full size.' },
});

const VIEW_KEYS = Object.keys(SCREENSHOT_VIEW_PROPERTIES);
type Args = Record<string, unknown> | null | undefined;

/** The view arguments of a call, or null when it has none (the plain screen, as before). */
export function screenshotViewArgs(args: Args): Record<string, unknown> | null {
    if (!args || typeof args !== 'object') return null;
    const view: Record<string, unknown> = {};
    for (const key of VIEW_KEYS) if (args[key] !== undefined && args[key] !== null) view[key] = args[key];
    return Object.keys(view).length ? view : null;
}

/** A short clause naming what the view added, for the result text and the caption ('' for none). */
export function describeScreenshotView(view: Args): string {
    if (!view) return '';
    const bits: string[] = [];
    if (view.chrome === true) bits.push('in the app chrome');
    const state = view.state && typeof view.state === 'object' ? view.state as Record<string, unknown> : {};
    if (typeof state.openModal === 'string') bits.push(`modal ${state.openModal} open`);
    const tabs = [state.activeTab].flat().filter((t) => typeof t === 'string');
    if (tabs.length) bits.push(`tab ${tabs.join(', ')}`);
    for (const key of ['vars', 'screenParams', 'forms']) if (state[key] && typeof state[key] === 'object') bits.push(`with ${key}`);
    if (typeof view.appearance === 'string') bits.push(`appearance ${view.appearance}`);
    if (typeof view.hostTheme === 'string') bits.push(`host theme ${view.hostTheme}`);
    if (typeof view.nodeId === 'string') bits.push(`cropped to ${view.nodeId}`);
    return bits.join(', ');
}
