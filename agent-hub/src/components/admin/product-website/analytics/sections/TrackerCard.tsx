import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { Card } from '../AsyncCard';
import { ACCENT } from '../BarList';
import type { TrackerSettings, FieldProps, ToggleProps } from './SettingsSection.types';

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
                    placeholder={t('cms_site.analytics.settings.env_tag_ph', 'production')} style={inputStyle} />
            </Field>
            <Field label={t('cms_site.analytics.settings.domains', 'Only track these domains')} hint={t('cms_site.analytics.settings.domains_hint', 'Comma-separated hostnames. Leave blank to track wherever the site is served. Useful to stop a staging copy polluting your numbers.')}>
                <input value={tracker.domains || ''} onChange={(e) => onChange('domains', e.target.value)}
                    placeholder={t('cms_site.analytics.settings.domains_ph', 'www.example.com, example.com')} style={inputStyle} />
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
            <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:2px_0_0]">
                {t('cms_site.analytics.settings.tracker_note', "Saved with the button above. Changes apply on a visitor's next page load — no republish needed. Core Web Vitals are always collected: they are browser timings only, carried by the same request as the pageview.")}
            </p>
        </Card>
    );
}

export function Field({ label, hint, children }: FieldProps) {
    return (
        <div className="[margin-bottom:14px]">
            <label style={labelStyle}>{label}</label>
            {children}
            {hint && <p className="[font-size:11px] [color:var(--text-muted,#777)] [margin:4px_0_0]">{hint}</p>}
        </div>
    );
}

export function Toggle({ label, hint, checked, onChange }: ToggleProps) {
    return (
        <div className="[display:flex] [align-items:center] [justify-content:space-between] [margin-bottom:14px]">
            <div>
                <div className="[font-size:13px] [font-weight:600] [color:var(--text-primary,#fff)]">{label}</div>
                {hint && <div className="[font-size:11px] [color:var(--text-muted,#777)]">{hint}</div>}
            </div>
            <button
                onClick={() => onChange(!checked)}
                aria-pressed={checked}
                style={{
                    width: 42, height: 24, borderRadius: 99, border: 'none', cursor: 'pointer', flexShrink: 0,
                    background: checked ? ACCENT : 'var(--bg-tertiary, rgba(255,255,255,0.12))',
                    position: 'relative', transition: 'background 0.15s',
                }}
            >
                <span style={{
                    position: 'absolute', top: 3, left: checked ? 21 : 3, width: 18, height: 18,
                    borderRadius: '50%', background: '#fff', transition: 'left 0.15s',
                }} />
            </button>
        </div>
    );
}

export const inputStyle: React.CSSProperties = {
    width: '100%', boxSizing: 'border-box', marginTop: 5, padding: '8px 11px',
    background: 'var(--bg-primary, #0f0f1a)', color: 'var(--text-primary, #fff)',
    border: '1px solid var(--border-default, rgba(255,255,255,0.12))', borderRadius: 8, fontSize: 13,
};

export const labelStyle: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #ccc)' };
