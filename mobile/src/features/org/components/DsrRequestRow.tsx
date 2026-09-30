/** One data-subject request: what was asked, by whom, when, and where it stands. Opens it in the Compliance Center. */

import React from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';
import { Badge, ListRow } from '@/shared/ui';

import type { DsrRequest } from '../model/types';

function statusTone(status: string): 'success' | 'warning' | 'neutral' {
    if (status === 'fulfilled') return 'success';
    if (status === 'open' || status === 'pending') return 'warning';
    return 'neutral';
}

export function DsrRequestRow({ request, onPress }: { request: DsrRequest; onPress: () => void }) {
    const t = useTranslation();
    const who = request.subject_email ?? t('forms.answers.anonymous', 'Anonymous');
    return (
        <ListRow
            title={`${humanise(request.request_type)} · #${request.id}`}
            subtitle={`${who} · ${timeAgo(request.created_at)}`}
            trailing={<Badge label={humanise(request.status)} tone={statusTone(request.status)} />}
            onPress={onPress}
            testID={`dsr-request-${request.id}`}
        />
    );
}
