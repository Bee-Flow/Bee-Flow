import React from 'react';
import { useRequiredConnectionsQuery } from '../../api/queries/sharedReads';
import { settingsPathForTab } from '../../authedApp/settingsRoutes';
import { AlertCircle } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';

/**
 * RequiredConnectionsBanner — recipient pre-flight for a shared resource. Shows
 * which integrations the running user must connect (bring-your-own) before the
 * resource's tools will work, and which are already lent to them. Driven by
 * GET /api/integrations/connections/required.
 *
 * Renders nothing when there's nothing to connect (the common case), so it's
 * safe to mount unconditionally on a resource the user is about to use.
 */

interface RequiredConnectionsBannerProps {
    resourceType: string;
    resourceId?: string | null;
    providers?: (string | null | undefined)[] | null;
    purpose?: string;
}

interface RequiredConnection {
    provider: string;
}

const RequiredConnectionsBanner = ({ resourceType, resourceId, providers, purpose = "to use all of this agent's tools" }: RequiredConnectionsBannerProps) => {
    const { t } = useTranslation();
    const list = (providers || []).filter((p): p is string => !!p);
    const required = useRequiredConnectionsQuery<RequiredConnection>(resourceType, resourceId, list).data ?? [];

    if (required.length === 0) return null;

    return (
        <div className="rounded-lg px-3 py-2 text-[12px] flex items-start gap-2"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--text-primary)' }}>
            <AlertCircle size={14} className="[color:#d97706] [flex-shrink:0] [margin-top:1px]" />
            <span>
                {t('connections.required_connect_in', 'Connect {providers} in', { providers: required.map(r => r.provider).join(', ') })}{' '}
                <a href={settingsPathForTab('integrations')} className="underline text-[var(--accent-primary)]">{t('connections.required_settings_link', 'Settings → Connections')}</a>{' '}
                {purpose}.
            </span>
        </div>
    );
};

export default RequiredConnectionsBanner;
