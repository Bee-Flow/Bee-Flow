/**
 * The Nextcloud pages this screen opens (the other panels of the web's
 * Nextcloud page): pairing a new Nextcloud for an NC-bound org or the
 * platform operator, and the Talk and Google Meet meeting-notes settings
 * under the Meeting Notes licence.
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
                <>
                    <ListRow testID="nc-talk" title={t('mobile.orgIntegrations.talk_title', 'Talk Meeting Notes')} chevron onPress={() => router.push('/org/nextcloud/talk')} />
                    <ListRow testID="nc-meet" title={t('mobile.orgIntegrations.meet_title', 'Google Meet Meeting Notes')} chevron onPress={() => router.push('/org/nextcloud/meet')} />
                </>
            ) : null}
        </Group>
    );
}
