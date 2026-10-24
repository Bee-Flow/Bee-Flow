import React, { useState, useEffect, useEffectEvent } from 'react';
import { settingsPathForTab } from '../../authedApp/settingsRoutes';
import { API_BASE, authFetch } from '../../utils/helpers';
import { AlertCircle } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import { logger } from '../../utils/logger';

/**
 * RequiredConnectionsBanner — recipient pre-flight for a shared resource. Shows
 * which integrations the running user must connect (bring-your-own) before the
 * resource's tools will work, and which are already lent to them. Driven by
 * GET /api/integrations/connections/required.
 *
 * Renders nothing when there's nothing to connect (the common case), so it's
 * safe to mount unconditionally on a resource the user is about to use.
 */

const BASE = `${API_BASE}/api/integrations/connections`;

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
    const [required, setRequired] = useState<RequiredConnection[]>([]);
    const list = (providers || []).filter(Boolean);

    const listKey = list.join(',');
    const runListEffect = useEffectEvent(() => {
        let alive = true;
        (async () => {
            if (!resourceId || list.length === 0) return;
            try {
                const qs = new URLSearchParams({ resourceType, resourceId, providers: list.join(',') });
                const res = await authFetch(`${BASE}/required?${qs.toString()}`);
                if (!res.ok) return;
                const data = await res.json();
                if (alive) setRequired(data.requiresConnection || []);
            } catch (err) { logger.debug('silent', err); }
        })();
        return () => { alive = false; };
    });
    useEffect(() => { return runListEffect(); }, [resourceType, resourceId, listKey]);

    if (required.length === 0) return null;

    return (
        <div className="rounded-lg px-3 py-2 text-[12px] flex items-start gap-2"
            style={{ background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.3)', color: 'var(--text-primary)' }}>
            <AlertCircle size={14} style={{ color: '#d97706', flexShrink: 0, marginTop: 1 }} />
            <span>
                {t('connections.required_connect_in', 'Connect {providers} in', { providers: required.map(r => r.provider).join(', ') })}{' '}
                <a href={settingsPathForTab('integrations')} className="underline text-[var(--accent-primary)]">{t('connections.required_settings_link', 'Settings → Connections')}</a>{' '}
                {purpose}.
            </span>
        </div>
    );
};

export default RequiredConnectionsBanner;
