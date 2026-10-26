import { ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { getIntegrationIcon } from '../../../../../config/integrationIcons';
import TriggerProviderPicker from '../TriggerProviderPicker';
import { FormRow, inputClass } from './formPrimitives';
import { FILTER_FORM_BY_KEY } from './triggerFilters';
import { OutlookMailNewFilterFields } from './outlookMailbox/OutlookMailNewFilterFields';
import type { AppEventFieldsProps } from './triggerEditors.types';
import { useTranslation } from '../../../../../hooks/useTranslation';

// Labels for providers that can appear in SAVED configs but are absent from
// the dynamic catalog list (hidden, e.g. github; or availability revoked).
// Fallback for anything else: the raw id. Never used to LIST a provider.
const LEGACY_PROVIDER_LABELS: Record<string, string> = {
    'gmail': 'Gmail',
    'google-calendar': 'Google Calendar',
    'google-drive': 'Google Drive',
    'nextcloud': 'Nextcloud',
    'support': 'Support Inbox',
    'msgraph': 'Microsoft 365 (Outlook)',
    'github': 'GitHub',
};

/**
 * Provider + event selects with per-event filter sub-form. The provider list
 * is dynamic — only providers the backend catalog reports as available to
 * this user. A configured-but-unlisted provider renders as a preserved
 * "(not available)" option and is never blanked or mutated. Switching the
 * provider auto-snaps the event to that provider's default AND clears the
 * filter — different events have incompatible filter shapes, so carrying old
 * fields over would just produce validation warnings.
 */
export function AppEventFields({ draft, set, setNested, catalog = null }: AppEventFieldsProps) {
    const { t } = useTranslation();
    // Normalizer: tolerate a stale/cached backend that still serves string[].
    const rawProviders = catalog?.triggers?.find(t => t.kind === 'app_event')?.providers || [];
    const providerDefs = rawProviders.map(p =>
        typeof p === 'string' ? { id: p, label: p, defaultEvent: '', events: [] } : p);

    const [pickerOpen, setPickerOpen] = useState(false);
    const provider = draft.appProvider || '';
    const currentDef = providerDefs.find(p => p.id === provider) || null;
    const events = currentDef?.events || [];
    const event = draft.appEventName || currentDef?.defaultEvent || '';
    const knownEvent = events.some(ev => ev.id === event);
    const selectedEvent = events.find(ev => ev.id === event) || null;

    const onProviderChange = (next: string) => {
        const def = providerDefs.find(p => p.id === next);
        set('appProvider', next);
        set('appEventName', def?.defaultEvent || def?.events?.[0]?.id || '');
        set('filter', {});
    };
    const onEventChange = (next: string) => {
        set('appEventName', next);
        set('filter', {});
    };

    // One-shot auto-snap: a fresh trigger starts with no provider; pick the
    // first available one once the catalog is present. Ref-guarded so a
    // subsequent manual clear-to-'' can't retrigger it.
    const snappedRef = useRef(false);
    useEffect(() => {
        if (snappedRef.current) return;
        if (!draft.appProvider && providerDefs.length > 0) {
            snappedRef.current = true;
            onProviderChange(providerDefs[0].id);
        }
    });

    if (!provider && providerDefs.length === 0) {
        return (
            <div className="text-[11px] text-[var(--text-tertiary)] leading-snug">
                {t('automations.trigger_editors.no_event_sources_are_available_to', 'No event sources are available to you yet. Connect an app (e.g. Gmail or Nextcloud) in Settings → Connections first.')}
            </div>
        );
    }

    const providerListed = !!currentDef;
    const setF = (k: string, v: unknown) => setNested('filter', k, v);
    const filter = draft.filter || {};
    const FilterForm = FILTER_FORM_BY_KEY[`${provider}.${event}`] || null;

    return (
        <>
            <FormRow label={t('automations.trigger_editors.app', 'App')}>
                {/* An app picker rather than a dropdown of ids: same overlay the
                    agent editor uses, so it carries the app's logo and shows
                    what that app can trigger on before you commit to it. */}
                <button
                    type="button"
                    onClick={() => setPickerOpen(true)}
                    aria-label={t('automations.trigger_editors.choose_the_app_to_trigger_on', 'Choose the app to trigger on')}
                    className={`${inputClass()} flex items-center gap-2 text-left hover:bg-[var(--bg-tertiary)]`}
                >
                    {provider && (
                        <span className="w-5 h-5 flex items-center justify-center shrink-0">{getIntegrationIcon(provider)}</span>
                    )}
                    <span className="truncate flex-1">
                        {provider
                            ? (currentDef?.label || LEGACY_PROVIDER_LABELS[provider] || provider)
                            : 'Choose an app…'}
                        {provider && !providerListed && ' (not available)'}
                    </span>
                    <ChevronDown size={14} className="shrink-0 text-[var(--text-tertiary)]" />
                </button>
                {pickerOpen && (
                    <TriggerProviderPicker
                        providers={providerDefs}
                        selected={provider}
                        onPick={onProviderChange}
                        onClose={() => setPickerOpen(false)}
                    />
                )}
                {provider && !providerListed && (
                    <div className="text-[11px] text-amber-600 dark:text-amber-400 mt-1 leading-snug">
                        {t('automations.trigger_editors.this_app_isn_t_available_to', 'This app isn\'t available to you right now (integration not connected or not permitted for your account). The trigger is kept as configured, but it may not fire.')}
                    </div>
                )}
            </FormRow>
            <FormRow label={t('automations.trigger_editors.event', 'Event')}>
                <select value={event} onChange={(e) => onEventChange(e.target.value)} className={inputClass()}>
                    {event && !knownEvent && (
                        <option value={event}>{event}{providerListed ? ' (unknown event)' : ''}</option>
                    )}
                    {events.map(ev => (
                        <option key={ev.id} value={ev.id}>{ev.label}</option>
                    ))}
                </select>
            </FormRow>
            {/* The explanation travels with the event that needs it — this used
                to name Nextcloud regardless of which provider was selected. */}
            {selectedEvent?.deliverability === 'connector' && (
                <div className="text-[11px] text-amber-600 dark:text-amber-400 leading-snug">
                    {selectedEvent.deliverabilityNote
                        || 'This event needs an extra connector that isn’t available yet — it will not fire.'}
                </div>
            )}

            {FilterForm && <FilterForm filter={filter} setFilter={setF} />}
            {/* Outlook "New email": which inbox it watches. Kept out of FILTER_FORM_BY_KEY,
                whose map the phone's flow editor ports one to one (mobile has no picker yet). */}
            {provider === 'msgraph' && event === 'mail.new' && <OutlookMailNewFilterFields filter={filter} setFilter={setF} />}
        </>
    );
}
