/**
 * The sentence after a recording reached the outbox without anybody pressing
 * Stop: recovered after the app died, or kept after the phone ended it. The
 * recording itself is the row in "On this phone" just below.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { Banner, Button, Text } from '@/shared/ui';

import type { RecordingNotice as Notice } from '../hooks/useRecordingRescue';

function sentence(t: TranslateFn, notice: Notice): string {
    if (notice.kind === 'recovered') {
        return t(
            'mobile.recording.recovered_notice',
            'Bee Flow closed while you were recording. The audio up to that moment was saved below as "{title}". Upload it or delete it.',
            { title: notice.title },
        );
    }
    if (!notice.kept) {
        return t('mobile.recording.interrupted_lost', 'The phone stopped the recording before any audio was saved.');
    }
    return t(
        'mobile.recording.interrupted_kept',
        'The phone stopped the recording. Everything up to that moment was saved below, ready to upload.',
    );
}

export function RecordingNotice({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
    const t = useTranslation();
    const tone = notice.kind === 'interrupted' && !notice.kept ? 'error' : 'warning';
    const reason = notice.kind === 'interrupted' ? notice.reason : null;
    return (
        <Banner tone={tone} action={<Button label={t('meetings.dismiss', 'Dismiss')} variant="ghost" onPress={onDismiss} />}>
            <Text variant="caption" tone="secondary">
                {reason ? `${sentence(t, notice)} (${reason})` : sentence(t, notice)}
            </Text>
        </Banner>
    );
}
