import { ArrowLeft, ShieldOff } from 'lucide-react';
import React from 'react';
import OrganisationSection from './settings/OrganisationSection';
import OrgUsersPanel from '../components/admin/org/OrgUsersPanel';
import AgentDesigner from '../components/agents/AgentDesigner/index';
import GitHubSyncPanel from '../components/integrations/github/GitHubSyncPanel';
import NextcloudSyncPanel from '../components/integrations/nextcloud/NextcloudSyncPanel';
import SystemKnowledgeBasesPanel from '../components/knowledge/SystemKnowledgeBasesPanel';
import { AGENT_MANAGEMENT_ROLES, USER_MANAGEMENT_ROLES } from '../config/orgRoles';
import { useTranslation } from '../hooks/useTranslation';
import type { SettingsUser } from './settings/shell/settingsShellTypes';

interface OrgSettingsProps {
    onBack: React.MouseEventHandler<HTMLButtonElement>;
    orgSettingsPath?: { seg1?: string; seg2?: string };
    user?: SettingsUser | null;
    onNavigate?: (value: string) => void;
}

const OrgSettings = ({ user, onBack, orgSettingsPath = {}, onNavigate }: OrgSettingsProps) => {
    const { t } = useTranslation();
    // Permission helper — derives from the actual user permission set
    const hasPermission = (perm: string) => {
        const perms = user?.permissions || [];
        return perms.includes('all') || perms.includes(perm);
    };

    const isSuperAdmin = user?.isAdmin || user?.role === 'admin' || hasPermission('all');
    const orgRole = user?.orgRole || '';

    // Gate: user must be an org admin, agent admin, agent editor, or super admin
    const canAccessOrgSettings = isSuperAdmin || orgRole === 'org_admin'
        || hasPermission('org_admin') || hasPermission('manage_users') || hasPermission('manage_agents') || hasPermission('manage_knowledge');

    // Tab-level permissions
    const canManageAgents = isSuperAdmin || AGENT_MANAGEMENT_ROLES.includes(orgRole)
        || hasPermission('manage_agents');
    const canManageUsers = isSuperAdmin || USER_MANAGEMENT_ROLES.includes(orgRole)
        || hasPermission('manage_users');

    const canManageKnowledge = isSuperAdmin || hasPermission('manage_knowledge');
    // The Organisation tab is the Organisation Info editor, so it follows that
    // editor's own gate (Settings → Organisation shows it to org admins only,
    // and the server refuses the save to anyone else). Open to every visitor,
    // it put a form an agent editor could fill in but never save.
    const canEditOrgInfo = isSuperAdmin || orgRole === 'org_admin' || orgRole === 'admin'
        || hasPermission('org_admin');

    const tabs = [
        { id: 'organisation', label: t('settings.organisation', 'Organisation'), allowed: canEditOrgInfo },
        { id: 'agents', label: t('settings.agents', 'Agents'), allowed: canManageAgents },
        { id: 'knowledge-bases', label: t('sidebar.knowledge_bases', 'Knowledge Bases'), allowed: canManageKnowledge },
        { id: 'github-sync', label: t('settings.github_sync', 'GitHub Sync'), allowed: canManageAgents },
        { id: 'nextcloud-sync', label: t('settings.nextcloud_sync', 'Nextcloud Sync'), allowed: canManageUsers },
        { id: 'users', label: t('admin.users_tab_users', 'Users'), allowed: canManageUsers },
    ];

    const allowedTabs = tabs.filter(tab => tab.allowed);
    const activeTab = allowedTabs.some(tab => tab.id === orgSettingsPath.seg1)
        ? orgSettingsPath.seg1
        : (allowedTabs[0]?.id || null);

    const handleTabClick = (tabId: string) => {
        if (onNavigate) {
            onNavigate(`org-settings/${tabId}`);
        }
    };

    // Full access denied gate
    if (!canAccessOrgSettings) {
        return (
            <div className="h-full flex items-center justify-center bg-[var(--bg-primary)]">
                <div className="text-center p-8 rounded-2xl border bg-[var(--bg-secondary)] border-[var(--border-default)]">
                    <div className="w-16 h-16 mx-auto mb-4 rounded-full flex items-center justify-center [background:rgba(239,68,68,0.1)]">
                        <ShieldOff className="w-8 h-8" style={{ color: 'rgb(239, 68, 68)' }} />
                    </div>
                    <h2 className="text-xl font-bold mb-2 text-[var(--text-primary)]">{t('admin.access_denied_title', 'Access Denied')}</h2>
                    <p className="text-sm mb-4 text-[var(--text-muted)]">{t('org.settings_access_denied_text', "You don't have permission to access organisation settings.")}</p>
                    {onBack && <button onClick={onBack} className="px-4 py-2 rounded-lg font-medium text-white bg-[var(--accent-primary)]">{t('admin.go_back', 'Go Back')}</button>}
                </div>
            </div>
        );
    }

    return (
        <div className="h-full flex flex-col bg-[var(--bg-primary)]">
            {/* Top Navigation Bar */}
            <div className="h-14 flex items-center justify-between px-4 border-b shrink-0 border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                <div className="flex items-center gap-3">
                    {onBack && (
                        <button
                            onClick={onBack}
                            className="p-1.5 rounded-lg transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                            title={t('admin.back_to_chat', 'Back to chat')}
                        >
                            <ArrowLeft className="w-5 h-5" />
                        </button>
                    )}
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                        {t('org.settings_title', 'Organisation Settings')}
                    </h2>
                </div>

                <div className="flex gap-1 p-1 rounded-lg bg-[var(--bg-tertiary)]">
                    {allowedTabs.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => handleTabClick(tab.id)}
                            aria-current={activeTab === tab.id ? 'page' : undefined}
                            className={`px-4 py-1.5 rounded-md text-sm font-medium transition-all ${activeTab === tab.id
                                ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] shadow-sm'
                                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]'
                                }`}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

                <div className="w-20"></div> {/* Spacer for balance */}
            </div>

            {/* Main Content Area */}
            <div className="flex-1 overflow-hidden relative">
                {activeTab === 'organisation' ? (
                    <div className="absolute inset-0 overflow-y-auto p-6">
                        {/* The Organisation Info editor with its save bar, as
                            in Settings → Organisation → Organisation Info. A bare
                            OrgInfoPanel draws only the section it is told to, and
                            this tab never told it one: the page was empty. */}
                        <div className="max-w-3xl mx-auto">
                            <OrganisationSection user={user} activeSection="info" />
                        </div>
                    </div>
                ) : activeTab === 'users' ? (
                    <div className="absolute inset-0 overflow-auto p-6">
                        <div className="max-w-4xl mx-auto">
                            <OrgUsersPanel user={user} initialSection={(orgSettingsPath.seg2 || null) as string | undefined} />
                        </div>
                    </div>
                ) : activeTab === 'agents' ? (
                    <div className="absolute inset-0">
                        <AgentDesigner onBack={null} hasPermission={hasPermission} user={user} />
                    </div>
                ) : activeTab === 'knowledge-bases' ? (
                    <div className="absolute inset-0 overflow-y-auto p-6">
                        {/* System knowledge bases only. Creating, editing and
                            ingesting into an org's OWN knowledge bases lives in
                            Studio -> Knowledge (studioApps.jsx, urlSegment
                            'knowledge'); the duplicate admin CRUD that used to
                            sit here (KnowledgeBasesSection.jsx) is gone. */}
                        <div className="max-w-5xl mx-auto space-y-6">
                            <SystemKnowledgeBasesPanel />
                        </div>
                    </div>
                ) : activeTab === 'github-sync' ? (
                    <div className="absolute inset-0 overflow-y-auto p-6">
                        <GitHubSyncPanel user={user} />
                    </div>
                ) : activeTab === 'nextcloud-sync' ? (
                    <div className="absolute inset-0 overflow-y-auto p-6">
                        <NextcloudSyncPanel user={user} />
                    </div>
                ) : null}
            </div>
        </div>
    );
};

export default OrgSettings;
