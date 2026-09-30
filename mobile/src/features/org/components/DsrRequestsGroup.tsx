/**
 * For someone with `admin_compliance`: the eight latest data-subject requests
 * filed against the organisation. A tap opens the request in the native
 * Compliance Center (`/org/compliance/dsr/<id>`), where it is verified,
 * extended, fulfilled or rejected and its dossier exported — this group is
 * the glance, the register is the queue.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, ListRow, LoadingState, NoteRow } from '@/shared/ui';

import { DsrRequestRow } from './DsrRequestRow';
import type { DsrRequest } from '../model/types';

const DSR_REGISTER = '/org/compliance/dsr';

export function DsrRequestsGroup({
    requests,
    loading,
}: {
    requests: DsrRequest[] | null | undefined;
    loading: boolean;
}) {
    const t = useTranslation();
    const router = useRouter();
    return (
        <Group
            title={t('mobile.org.dsr_title', 'Data-subject requests')}
            footer={t('mobile.org.dsr_footer', 'Requests filed against your organisation. Open one to verify, fulfil or reject it and to export the subject’s data.')}
        >
            {loading ? (
                <NoteRow>
                    <LoadingState />
                </NoteRow>
            ) : requests && requests.length > 0 ? (
                requests
                    .slice(0, 8)
                    .map((request) => (
                        <DsrRequestRow
                            key={request.id}
                            request={request}
                            onPress={() => router.push(`${DSR_REGISTER}/${encodeURIComponent(String(request.id))}`)}
                        />
                    ))
            ) : (
                <NoteRow>{t('mobile.org.dsr_none', 'No requests have been filed.')}</NoteRow>
            )}
            <ListRow
                title={t('compliance.rail_dsr', 'Requests (DSR)')}
                subtitle={t('mobile.org.dsr_open_register', 'Every request, in the Compliance Center')}
                onPress={() => router.push(DSR_REGISTER)}
                testID="dsr-open-register"
            />
        </Group>
    );
}
