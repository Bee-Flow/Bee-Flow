import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Card } from '../AsyncCard';
import { ACCENT } from '../BarList';
import type { TrackerSettings, FieldProps, ToggleProps } from './SettingsSection.types';
import { INPUT, LABEL } from '@/components/mcpLibrary/ui';

/**
 * Tracker options mirrored onto the public <script> tag.
 *
 * Notably absent: a switch for web vitals. They are cookieless browser timings
 * riding along with a pageview already being sent under the same consent
 * decision — and making them optional is exactly how they ended up switched off
 * and unnoticed for the entire life of the feature.
 */
export function TrackerCard({ tracker, onChange }: { tracker: TrackerSettings; onChange: (k: string, v: string | boolean) => void; onSave?: () => Promise<void>; saving?: boolean }) {
    const { t } = useTranslation();
    return (
        <Card title={t('cms_site.analytics.settings.tracker_title', 'What the tracker records')}>
            <Field label={t('cms_site.analytics.settings.env_tag', 'Environment tag')} hint={t('cms_site.analytics.settings.env_tag_hint', 'Optional label attached to every event, so you can tell staging from production in the same Umami instance.')}>
                <input value={tracker.tag || ''} onChange={(e) => onChange('tag', e.target.value)}
                    placeholder={t('cms_site.analytics.settings.env_tag_ph', 'production')} className={inputClass} />
            </Field>
            <Field label={t('cms_site.analytics.settings.domains', 'Only track these domains')} hint={t('cms_site.analytics.settings.domains_hint', 'Comma-separated hostnames. Leave blank to track wherever the site is served. Useful to stop a staging copy polluting your numbers.')}>
                <input value={tracker.domains || ''} onChange={(e) => onChange('domains', e.target.value)}
                    placeholder={t('cms_site.analytics.settings.domains_ph', 'www.example.com, example.com')} className={inputClass} />
            </Field>
            <Toggle label={t('cms_site.analytics.settings.hash', 'Drop #anchors from URLs')}
                hint={t('cms_site.analytics.settings.hash_hint', 'On by default — otherwise /pricing#plans and /pricing count as two different pages.')}
                checked={tracker.excludeHash !== false} onChange={(v) => onChange('excludeHash', v)} />
            <Toggle label={t('cms_site.analytics.settings.search', 'Drop ?query strings from URLs')}
                hint={t('cms_site.analytics.settings.search_hint', 'Stronger privacy and tidier reports, but you lose UTM campaign attribution. Off by default for that reason.')}
                checked={!!tracker.excludeSearch} onChange={(v) => onChange('excludeSearch', v)} />
            <Toggle label={t('cms_site.analytics.settings.dnt', 'Honour Do Not Track')}
                hint={t('cms_site.analytics.settings.dnt_hint', 'Skip visitors whose browser sends a DNT header. They then appear nowhere in your numbers.')}
                checked={!!tracker.doNotTrack} onChange={(v) => onChange('doNotTrack', v)} />
            <p className="text-[11px] text-[var(--text-tertiary)] mt-0.5 mx-0 mb-0">
                {t('cms_site.analytics.settings.tracker_note', "Saved with the button above. Changes apply on a visitor's next page load — no republish needed. Core Web Vitals are always collected: they are browser timings only, carried by the same request as the pageview.")}
            </p>
        </Card>
    );
}

export function Field({ label, hint, children }: FieldProps) {
    return (
        <div className="mb-3.5">
            <label className={labelClass}>{label}</label>
            {children}
            {hint && <p className="text-[11px] text-[var(--text-tertiary)] mt-1 mx-0 mb-0">{hint}</p>}
        </div>
    );
}

export function Toggle({ label, hint, checked, onChange }: ToggleProps) {
    return (
        <div className="flex items-center justify-between mb-3.5">
            <div>
                <div className="text-[13px] font-semibold text-[var(--text-primary)]">{label}</div>
                {hint && <div className="text-[11px] text-[var(--text-tertiary)]">{hint}</div>}
            </div>
            <button
                onClick={() => onChange(!checked)}
                aria-pressed={checked}
                type="button"
                className={`relative h-6 w-[42px] shrink-0 cursor-pointer rounded-full border-0 transition-colors ${checked ? 'bg-[var(--accent-primary)]' : 'bg-[var(--bg-tertiary)] ring-1 ring-inset ring-[var(--border-default)]'}`}
            >
                <span className={`absolute top-[3px] w-[18px] h-[18px] rounded-full shadow-sm transition-[left] ${checked ? 'bg-[var(--accent-primary-fg)]' : 'bg-[var(--bg-card)]'} ${checked ? 'left-[21px]' : 'left-[3px]'}`} />
            </button>
        </div>
    );
}

/** The settings form's input and label: the Studio recipes, with the room above an input its label used to get. */
export const inputClass = `${INPUT} mt-1`;
export const labelClass = LABEL;
