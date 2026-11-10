import type { InitialUi } from './RuntimeContext';

/**
 * What a node reads from the runtime's `initialUi` (RuntimeContext): the UI state a host asks
 * it to START in, keyed by node id. Only the screenshot renderer passes one today
 * (appRuntimeHeadless.tsx, from app_screenshot's `state`); every other host passes null and
 * each reader below then answers exactly what the component did before.
 *
 *   modal  { open: true }               starts open (run mode)
 *   tabs   { activeTab: '<tab node id>' } starts on that tab
 *   form   { values: { field: value } }  starts with those field values
 */

function entryOf(ui: InitialUi | null | undefined, id: string | undefined): Record<string, unknown> | null {
    if (!ui || !id || !Object.prototype.hasOwnProperty.call(ui, id)) return null;
    const entry = ui[id];
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : null;
}

/** True when the host asks this modal to start open. */
export function initialModalOpen(ui: InitialUi | null | undefined, id: string | undefined): boolean {
    return entryOf(ui, id)?.open === true;
}

/** The index of the tab the host asks this tab group to start on, else 0. */
export function initialTabIndex(ui: InitialUi | null | undefined, id: string | undefined, tabs: ReadonlyArray<{ id?: string }>): number {
    const wanted = entryOf(ui, id)?.activeTab;
    if (typeof wanted !== 'string') return 0;
    const at = tabs.findIndex((tab) => tab?.id === wanted);
    return at === -1 ? 0 : at;
}

/** The field values the host asks this form to start with (a copy), else an empty object. */
export function initialFormValues(ui: InitialUi | null | undefined, id: string | undefined): Record<string, unknown> {
    const values = entryOf(ui, id)?.values;
    return values && typeof values === 'object' && !Array.isArray(values) ? { ...values as Record<string, unknown> } : {};
}
