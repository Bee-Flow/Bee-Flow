/**
 * The ten most recent responses, from the summary. Each opens its
 * ResponseSheet; every response is a page at a time in AllResponsesSheet.
 */

import React from 'react';
import { View } from 'react-native';

import { timeAgo, useTranslation, type TranslateFn } from '@/core/i18n';
import { previewLine } from '@/features/forms/model/answersView';
import type { RecentResponse } from '@/features/forms/model/answerTypes';
import { Card, Divider, ListRow } from '@/shared/ui';

import type { OpenResponse } from './ResponseSheet';

const who = (t: TranslateFn, by: RecentResponse['by']) => by?.name || by?.id || t('forms.answers.anonymous', 'Anonymous');

export function RecentResponses({ recent, onOpen }: { recent: readonly RecentResponse[]; onOpen: (r: OpenResponse) => void }) {
    const t = useTranslation();
    if (!recent.length) return null;
    return (
        <Card padded={false}>
            {recent.map((r, i) => (
                <View key={r.rowId}>
                    {i > 0 ? <Divider /> : null}
                    <ListRow
                        title={previewLine(r) || who(t, r.by)}
                        subtitle={who(t, r.by)}
                        meta={timeAgo(r.submittedAt)}
                        onPress={() => onOpen({ rowId: r.rowId, submittedAt: r.submittedAt, runId: r.runId, by: r.by?.name ?? r.by?.id ?? null })}
                        testID="recent-row"
                    />
                </View>
            ))}
        </Card>
    );
}
