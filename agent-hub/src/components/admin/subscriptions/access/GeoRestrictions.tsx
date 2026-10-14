import { AlertTriangle, Globe, Network, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { COUNTRIES, EU_EEA, countryName, countryFlag } from './countries';
import type { GeoMode, SignupSettings, UpdateSetting } from './useSignupSettings';
import { useTranslation } from '../../../../hooks/useTranslation';
import { Button } from '../../../shared/Button';
import { Banner, Card, Checkbox, Toggle } from '../ui/typedUi';

interface GeoRestrictionsProps {
    settings: SignupSettings;
    update: UpdateSetting;
}

/** The countries in force as removable chips, plus the EU/EEA preset and clear-all. */
function SelectedCountries({ settings, update }: GeoRestrictionsProps) {
    const { t } = useTranslation();
    const { geoMode, geoCountries } = settings;
    const removeCountry = (code: string) => update('geoCountries', prev => prev.filter(c => c !== code));
    const addEuEea = () => update('geoCountries', prev => [...new Set([...prev, ...EU_EEA])]);
    return (
        <>
            <div className="flex flex-wrap gap-1.5">
                {geoCountries.length === 0 && (
                    <span className="text-[11.5px] text-[var(--text-muted)] italic">
                        {geoMode === 'allowlist' ? t('admin_subscriptions.access_geo_none_allow', 'No countries selected: all signups will be blocked.') : t('admin_subscriptions.access_geo_none', 'No countries selected.')}
                    </span>
                )}
                {geoCountries.map(code => (
                    <button
                        key={code}
                        type="button"
                        onClick={() => removeCountry(code)}
                        title={t('admin_subscriptions.access_remove', 'Remove')}
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11.5px] font-medium bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)] hover:border-rose-500/40 hover:text-rose-400"
                    >
                        <span>{countryFlag(code)}</span>
                        <span>{countryName(code)}</span>
                        <X className="w-3 h-3" />
                    </button>
                ))}
            </div>

            <div className="flex items-center gap-2">
                <Button size="sm" variant="secondary" onClick={addEuEea}>{t('admin_subscriptions.access_eu_preset', '+ EU/EEA preset')}</Button>
                {geoCountries.length > 0 && (
                    <Button size="sm" variant="ghost" onClick={() => update('geoCountries', [])}>{t('admin_subscriptions.access_clear_all', 'Clear all')}</Button>
                )}
            </div>
        </>
    );
}

interface CountryPickerProps extends GeoRestrictionsProps {
    /** Owned by the card, so the search survives switching the mode off and on. */
    countrySearch: string;
    setCountrySearch: (q: string) => void;
}

/** Search the country list and add one. */
function CountryPicker({ settings, update, countrySearch, setCountrySearch }: CountryPickerProps) {
    const { t } = useTranslation();
    const { geoCountries } = settings;
    const addCountry = (code: string) => update('geoCountries', prev => prev.includes(code) ? prev : [...prev, code]);
    const availableCountries = useMemo(() => {
        const q = countrySearch.trim().toLowerCase();
        return COUNTRIES.filter(c =>
            !geoCountries.includes(c.code) &&
            (!q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q))
        );
    }, [countrySearch, geoCountries]);
    return (
        <div>
            <input
                type="text"
                value={countrySearch}
                onChange={e => setCountrySearch(e.target.value)}
                placeholder={t('admin_subscriptions.access_search_countries', 'Search countries to add…')}
                className="w-full px-3 py-2 text-[13px] rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-default)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-blue-500/50"
            />
            <div className="mt-1.5 max-h-44 overflow-y-auto rounded-lg border border-[var(--border-default)] divide-y divide-[var(--border-default)]">
                {availableCountries.length === 0 ? (
                    <div className="px-3 py-2 text-[12px] text-[var(--text-muted)]">{t('admin_subscriptions.access_no_matches', 'No matches.')}</div>
                ) : availableCountries.map(c => (
                    <button
                        key={c.code}
                        type="button"
                        onClick={() => addCountry(c.code)}
                        className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-left text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                    >
                        <span>{countryFlag(c.code)}</span>
                        <span className="flex-1">{c.name}</span>
                        <span className="text-[10.5px] text-[var(--text-muted)]">{c.code}</span>
                    </button>
                ))}
            </div>
        </div>
    );
}

/** Which countries may create accounts, by the signup request's IP location. */
export default function GeoRestrictions({ settings, update }: GeoRestrictionsProps) {
    const { t } = useTranslation();
    const GEO_MODES: { id: GeoMode; label: string }[] = [
        { id: 'off',       label: t('admin_subscriptions.access_geo_off', 'Off') },
        { id: 'allowlist', label: t('admin_subscriptions.access_geo_allowlist', 'Allowlist') },
        { id: 'blocklist', label: t('admin_subscriptions.access_geo_blocklist', 'Blocklist') },
    ];
    const { geoMode } = settings;
    const [countrySearch, setCountrySearch] = useState('');
    return (
        <Card className="space-y-4 !p-5 mb-4">
            <div className="flex items-start gap-2">
                <Globe className="w-4 h-4 mt-0.5 text-teal-400 shrink-0" />
                <div>
                    <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">{t('admin_subscriptions.access_geo_title', 'Geo restrictions')}</h3>
                    <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                        {t('admin_subscriptions.access_geo_desc', 'Restrict which countries can create accounts, based on the signup request\'s IP location.')}
                    </p>
                </div>
            </div>

            {/* Mode selector */}
            <div className="inline-flex rounded-lg border border-[var(--border-default)] overflow-hidden">
                {GEO_MODES.map(m => (
                    <button
                        key={m.id}
                        type="button"
                        onClick={() => update('geoMode', m.id)}
                        className={`px-3.5 py-1.5 text-[12px] font-semibold transition-colors ${
                            geoMode === m.id
                                ? 'bg-blue-600 text-white'
                                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                    >
                        {m.label}
                    </button>
                ))}
            </div>

            {geoMode !== 'off' && (
                <>
                    <p className="text-[12px] text-[var(--text-secondary)]">
                        {geoMode === 'allowlist'
                            ? t('admin_subscriptions.access_geo_allow_hint', 'Only allow signups from these countries:')
                            : t('admin_subscriptions.access_geo_block_hint', 'Block signups from these countries:')}
                    </p>

                    <SelectedCountries settings={settings} update={update} />
                    <CountryPicker settings={settings} update={update} countrySearch={countrySearch} setCountrySearch={setCountrySearch} />

                    <div className="pt-1 border-t border-[var(--border-default)]" />

                    <Checkbox
                        checked={settings.geoBlockUnknown}
                        onChange={v => update('geoBlockUnknown', v)}
                        accent="amber"
                        label={t('admin_subscriptions.access_geo_unknown', 'Block signups when the country can\'t be determined')}
                    />

                    <Toggle
                        checked={settings.geoApplyConnector}
                        onChange={v => update('geoApplyConnector', v)}
                        icon={Network}
                        iconClass="text-sky-400"
                        label={t('admin_subscriptions.access_geo_connector', 'Also apply to Nextcloud connector signups')}
                        description={t('admin_subscriptions.access_geo_connector_desc', 'When a new Nextcloud user is auto-provisioned, check the connecting Nextcloud server\'s location (not the individual user\'s).')}
                    />

                    <Banner tone="warning" icon={AlertTriangle}>
                        {t('admin_subscriptions.access_geo_warning', 'Geo-blocking is best-effort: it relies on IP geolocation, which is approximate and can be bypassed with a VPN. Use it as a guardrail, not a hard security boundary.')}
                    </Banner>
                </>
            )}
        </Card>
    );
}
