// The Google Maps key of the Connected apps section: one key for the whole
// server (POST /ai/config takes a platform admin), used by the directions,
// route-map and places tools in chat. Shown on every tier, so a Community
// server can set it too. The outcome of a save is said as the panel's toast.
import { useState } from 'react';
import type React from 'react';
import { useHasGoogleMapsKey } from '@/api/queries/settingsConsumer';
import { useTranslation } from '@/hooks/useTranslation';
import { apiRequest } from '@/api/typedRequest';
import { FIELD_INPUT, SettingsGroup, SettingsList } from '@/components/shared/SettingsList';
import type { SetMessage } from './adminPanel.types';
import { HINT_LINK, Hint, SaveButton, StatusChip } from './ui';

const MASK = '••••••••••••••••';

/** The map pin of the Google Maps brand (a logo: brand colours allowed). */
const MAPS_LOGO = (
    <svg viewBox="0 0 24 24" fill="none" className="h-4 w-4" aria-hidden="true">
        <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#EA4335" />
        <circle cx="12" cy="9" r="2.5" fill="#fff" />
    </svg>
);

export default function GoogleMapsRow({ setMessage }: { setMessage: SetMessage }) {
    const { t } = useTranslation();
    const [key, setKey] = useState('');
    const [saving, setSaving] = useState(false);
    const storedKey = useHasGoogleMapsKey().data === true;
    const [justSaved, setJustSaved] = useState(false);
    const hasKey = storedKey || justSaved;

    const save = async () => {
        if (!key.trim()) return;
        setSaving(true);
        const failed = t('admin_platform.maps_save_failed', 'Could not save the Google Maps key');
        try {
            await apiRequest('POST /ai/config', { body: { googleMapsApiKey: key } });
            setJustSaved(true);
            setKey('');
            setMessage({ type: 'success', text: t('admin_platform.maps_saved', 'Google Maps key saved') });
        } catch {
            // A refusal or a failure is said, never swallowed: the spinner stopping is not a "saved".
            setMessage({ type: 'error', text: failed });
        } finally {
            setSaving(false);
        }
    };

    return (
        <SettingsGroup
            title={<span className="flex items-center gap-2">{MAPS_LOGO}Google Maps{hasKey && <StatusChip>{t('integ.services_configured', 'Configured')}</StatusChip>}</span>}
            description={t('admin_platform.maps_desc', 'Directions, route maps and places search in chat. One key for every organisation on this server.')}
        >
            <SettingsList>
                <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row">
                    <input
                        type="password"
                        value={key}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setKey(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
                        placeholder={hasKey ? MASK : t('admin_platform.maps_key_ph', 'Google Maps API key')}
                        aria-label={t('admin_platform.maps_key_ph', 'Google Maps API key')}
                        className={FIELD_INPUT}
                    />
                    <SaveButton saving={saving} disabled={!key.trim()} onClick={() => void save()}>{t('integ.services_save', 'Save')}</SaveButton>
                </div>
            </SettingsList>
            <Hint>
                {t('admin_platform.maps_hint', 'Enable the Directions API, Places API and Maps Embed API in the')}{' '}
                <a href="https://console.cloud.google.com/apis/library" target="_blank" rel="noopener noreferrer" className={HINT_LINK}>Google Cloud Console</a>.
            </Hint>
        </SettingsGroup>
    );
}
