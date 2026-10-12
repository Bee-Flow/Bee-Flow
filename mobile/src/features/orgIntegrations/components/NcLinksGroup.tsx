/**
 * The Nextcloud pages this screen opens (the other panels of the web's
 * Nextcloud page): pairing a new Nextcloud for an NC-bound org or the
 * platform operator, and the Talk meeting-notes settings under the Meeting
 * Notes licence. Google Meet's meeting-notes settings are not here: Meet does
 * not need a Nextcloud, so they open from Meeting templates, as on the web.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, ListRow } from '@/shared/ui';

export function NcLinksGroup({ pairing, meetingNotes }: { pairing: boolean; meetingNotes: boolean }) {
    const t = useTranslation();
    const router = useRouter();
    if (!pairing && !meetingNotes) return null;
    return (
        <Group>
            {pairing ? (
                <ListRow
                    testID="nc-pairing"
                    title={t('mobile.orgIntegrations.pair_title', 'Pair a new Nextcloud')}
                    chevron
                    onPress={() => router.push('/org/nextcloud/pairing')}
                />
            ) : null}
            {meetingNotes ? (
                <ListRow testID="nc-talk" title={t('mobile.orgIntegrations.talk_title', 'Talk Meeting Notes')} chevron onPress={() => router.push('/org/nextcloud/talk')} />
            ) : null}
        </Group>
    );
}
