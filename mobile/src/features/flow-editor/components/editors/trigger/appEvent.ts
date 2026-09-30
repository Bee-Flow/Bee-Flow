/**
 * An app-event trigger's provider and event — the web's AppEventFields
 * (triggerEditors.jsx), pure.
 *
 * The provider list is what the catalog says THIS caller may watch
 * (`catalog.triggers[kind=app_event].providers`); an older server answered a
 * bare string list, which still reads. A provider that is configured but not
 * listed is shown as itself, "(not available)", and never blanked. Switching
 * provider snaps the event to that provider's default and CLEARS the filter —
 * different events have incompatible filter shapes.
 */

import type { FlowCatalog } from '@/features/flow-editor/api';
import type { FormDraft } from '@/features/flow-editor/formState';

export interface AppEventDef {
    id: string;
    label: string;
    /** 'connector': needs a connector that is not available yet — it will not fire. */
    deliverability?: string | null;
    deliverabilityNote?: string | null;
}

export interface ProviderDef {
    id: string;
    label: string;
    defaultEvent: string;
    events: AppEventDef[];
}

/**
 * Names for providers a SAVED trigger can name but the catalog no longer
 * lists (hidden, or availability revoked). Never used to LIST a provider.
 */
export const LEGACY_PROVIDER_LABELS: Readonly<Record<string, string>> = {
    gmail: 'Gmail',
    'google-calendar': 'Google Calendar',
    'google-drive': 'Google Drive',
    nextcloud: 'Nextcloud',
    support: 'Support Inbox',
    msgraph: 'Microsoft 365 (Outlook)',
    github: 'GitHub',
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function eventOf(raw: unknown): AppEventDef | null {
    if (!raw || typeof raw !== 'object') return null;
    const e = raw as Record<string, unknown>;
    const id = str(e.id);
    if (!id) return null;
    return { id, label: str(e.label) || id, deliverability: str(e.deliverability) || null, deliverabilityNote: str(e.deliverabilityNote) || null };
}

function providerOf(raw: unknown): ProviderDef | null {
    if (typeof raw === 'string') return raw ? { id: raw, label: raw, defaultEvent: '', events: [] } : null;
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as Record<string, unknown>;
    const id = str(p.id);
    if (!id) return null;
    const events = (Array.isArray(p.events) ? p.events : []).map(eventOf).filter((e): e is AppEventDef => !!e);
    return { id, label: str(p.label) || id, defaultEvent: str(p.defaultEvent), events };
}

/** The providers this caller may trigger on, from the catalog. */
export function providerDefs(catalog: Pick<FlowCatalog, 'triggers'> | null | undefined): ProviderDef[] {
    const row = (catalog?.triggers || []).find((t) => t?.kind === 'app_event');
    return (Array.isArray(row?.providers) ? row.providers : []).map(providerOf).filter((p): p is ProviderDef => !!p);
}

/** The draft after picking a provider: its default event, and no filter. */
export function pickProvider(defs: readonly ProviderDef[], next: string): FormDraft {
    const def = defs.find((p) => p.id === next);
    return { appProvider: next, appEventName: def?.defaultEvent || def?.events[0]?.id || '', filter: {} };
}

/** The draft after picking an event: its filter starts empty. */
export function pickEvent(next: string): FormDraft {
    return { appEventName: next, filter: {} };
}

/** The event the trigger listens for: the stored one, else the provider's default. */
export function currentEvent(draft: FormDraft, def: ProviderDef | null): string {
    return str(draft.appEventName) || def?.defaultEvent || '';
}

/** What to call a provider: the catalog's name, a known legacy name, or its id. */
export function providerLabel(provider: string, def: ProviderDef | null): string {
    return def?.label || LEGACY_PROVIDER_LABELS[provider] || provider;
}
