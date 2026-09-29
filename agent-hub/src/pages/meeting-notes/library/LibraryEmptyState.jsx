import React from 'react';
import { Mic } from 'lucide-react';
import EmptyState from '../../../components/shared/EmptyState';
import useTranslation from '../../../hooks/useTranslation';

export default function LibraryEmptyState({ onCapture }) {
    const { t } = useTranslation();
    return (
        <EmptyState
            icon={<Mic className="w-14 h-14" />}
            title={t('meetings.empty_title', 'No meetings yet')}
            description={t('meetings.empty_desc', 'Record live, upload a file, or connect Nextcloud Talk or Google Meet to import your call recordings automatically.')}
            action={{
                label: t('meetings.record', 'Record'),
                onClick: onCapture,
                icon: <Mic className="w-4 h-4" />,
            }}
        />
    );
}
