/**
 * The Google Maps key (OrganisationSection.jsx GoogleMapsRow): a secret the
 * server never shows again, so the field starts empty and only a typed key is
 * sent. POST /ai/config `{ googleMapsApiKey }`.
 */

import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { FormSheet } from '@/shared/patterns';
import { TextField, useToast } from '@/shared/ui';

import { useSaveMapsKey } from '../hooks/integrationMutations';

export function MapsKeySheet({ visible, hasKey, onClose }: { visible: boolean; hasKey: boolean; onClose: () => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const save = useSaveMapsKey();
    const [key, setKey] = useState('');
    const close = () => {
        setKey('');
        save.reset();
        onClose();
    };
    const submit = async () => {
        try {
            await save.mutateAsync(key.trim());
            toast(t('common.saved', 'Saved'), 'success');
            close();
        } catch {
            // The sheet shows the error.
        }
    };
    return (
        <FormSheet
            visible={visible}
            onClose={close}
            title={t('mobile.orgIntegrations.maps', 'Google Maps')}
            subtitle={t('org.integ_maps_desc', 'Directions, route maps & places search in chat')}
            submitLabel={t('org.save_changes', 'Save changes')}
            onSubmit={() => void submit()}
            submitting={save.isPending}
            canSubmit={key.trim().length > 0}
            error={save.error}
        >
            <TextField
                testID="maps-key"
                label={t('mobile.orgIntegrations.maps_key', 'API key')}
                placeholder={hasKey ? '••••••••••••••••' : t('org.integ_maps_desc', 'Directions, route maps & places search in chat')}
                hint={t(
                    'mobile.orgIntegrations.maps_hint',
                    'Enable the Directions API, Places API and Maps Embed API in the Google Cloud Console.',
                )}
                secure
                value={key}
                onChangeText={setKey}
            />
        </FormSheet>
    );
}
