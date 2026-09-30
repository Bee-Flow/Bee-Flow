/** One guardrail event, one outbound call — the rows of the "What happened" list. */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { absoluteDate } from '@/shared/lib/display';
import { ListRow } from '@/shared/ui';

import { actionLabel, categoriesLabel, surfaceLabel } from '../model/activity';
import type { EgressRow, GuardEvent } from '../model/activityTypes';

export function EventRow({ event }: { event: GuardEvent }) {
    const t = useTranslation();
    const what = categoriesLabel(event.categories, t) || event.violationType;
    return (
        <ListRow
            title={what}
            subtitle={`${actionLabel(event.action, t)} · ${event.userName} · ${surfaceLabel(event, t)}`}
            meta={absoluteDate(event.timestamp)}
            wrapTitle
        />
    );
}

export function EgressItem({ row }: { row: EgressRow }) {
    const t = useTranslation();
    const where = row.isLocal
        ? t('mobile.orgShield.local', 'Your own network')
        : (row.countryName ?? t('mobile.orgShield.unknown_country', 'Unknown country'));
    const pii = categoriesLabel(row.piiCategories, t);
    return (
        <ListRow
            title={`${row.integration} → ${row.destination}`}
            subtitle={pii ? `${where} · ${pii}` : where}
            meta={absoluteDate(row.timestamp)}
        />
    );
}
