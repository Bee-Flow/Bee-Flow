// The admin dashboard's Nextcloud instances row (admin/nextcloud-instances[/health]):
// the Nextcloud bindings of every organisation on the server, and the
// connector fleet's health, as two tabs. Both are the panels Security > Users >
// Nextcloud and Security > Connector health held.

import UserManagement from './UserManagement';
import ConnectorHealthPanel from '@/components/integrations/health/ConnectorHealthPanel';
import Tabs from '@/components/shared/Tabs';
import { useTranslation } from '@/hooks/useTranslation';
import { useShellProps } from '@/authedApp/useShellProps';

interface NextcloudInstancesPanelProps {
    /** 'health' for the connector health tab; anything else the bindings. */
    section?: string;
    /** The organisation the health tab opens on (its third segment). */
    orgId?: string;
}

export default function NextcloudInstancesPanel({ section = '', orgId = '' }: NextcloudInstancesPanelProps) {
    const { t } = useTranslation();
    const { onNavigate } = useShellProps({});
    const active = section === 'health' ? 'health' : 'bindings';
    return (
        <div className="flex h-full flex-col">
            <div className="px-6 pt-4 md:px-8 md:pt-6">
                <Tabs
                    ariaLabel={t('admin_nav.nextcloud_instances', 'Nextcloud instances')}
                    value={active}
                    onChange={(id) => onNavigate?.(id === 'health' ? 'admin/nextcloud-instances/health' : 'admin/nextcloud-instances')}
                    items={[
                        { id: 'bindings', label: t('admin_nav.nc_bindings', 'Bindings') },
                        { id: 'health', label: t('admin_nav.nc_health', 'Connector health') },
                    ]}
                />
            </div>
            <div className="min-h-0 flex-1">
                {active === 'health'
                    ? <div className="h-full overflow-auto p-6 md:p-8"><ConnectorHealthPanel initialOrgId={orgId} onNavigate={onNavigate} /></div>
                    : <UserManagement sections={['nextcloud']} activeSection="nextcloud" />}
            </div>
        </div>
    );
}
