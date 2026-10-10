// A quiet band when the project's live connection is not live: while it falls
// back to polling, and when it stopped. Nothing while connecting or live, so a
// normal page load never flashes it.

import { RefreshCw } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../hooks/useTranslation';
import { useProjectLive } from './ProjectLiveContext';
import { Notice } from './workspaceUi';

export default function ConnectionBand({ className = '' }: { className?: string }) {
    const { t } = useTranslation();
    const { status } = useProjectLive();
    // 'stopped' only follows revoked access, where the page is replaced by ProjectUnavailable.
    if (status !== 'polling') return null;
    return (
        <div className={className} data-testid="connection-band" data-status={status}>
            <Notice tone="info" icon={RefreshCw} role="status">
                {t('project_home.connection.polling', 'Reconnecting… this page refreshes every 15 s.')}
            </Notice>
        </div>
    );
}
