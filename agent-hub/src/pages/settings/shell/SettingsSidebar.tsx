import { Scale } from 'lucide-react';
import React from 'react';
import type { ReactNode } from 'react';
import { SECTION_LBL } from '../../../components/shell/sidebar/sidebarTokens';
import { useTranslation } from '../../../hooks/useTranslation';
import { formatVersion, formatVersionWithDate } from '../../../utils/appVersion';
import { roleLabel } from '../roleLabel';
import { AvatarDisplay } from './AvatarDisplay';
import { Chevron, CONSUMER_NAV_ITEMS, NavDivider, NavItem, ORG_PARENT_ITEM, OrgSubItem } from './SettingsNav';
import type { NavRow } from './SettingsNav';
import type { OrgSubItem as OrgSubItemData, SettingsUser } from './settingsShellTypes';

export interface SettingsSidebarProps {
    user?: SettingsUser | null;
    activeTab: string;
    isOrgSubTab: boolean;
    isMobile: boolean;
    isSimpleMode: boolean;
    mobileDetail: boolean;
    setMobileDetail: (open: boolean) => void;
    canSeeOrg: boolean;
    showComplianceNav: boolean;
    isConsumerAccount: boolean;
    complianceBadge: ReactNode;
    orgExpanded: boolean;
    orgNavGroups: OrgSubItemData[][];
    settingsNavRows: NavRow[];
    resourceNavRows: NavRow[];
    onNavClick: (id: string) => void;
    setActiveTab: (id: string) => void;
}

/** The settings sidebar: user card, the personal rows, the organisation accordion, the consumer account rows and the build footer. */
export function SettingsSidebar({
    user, activeTab, isOrgSubTab, isMobile, isSimpleMode, mobileDetail, setMobileDetail, canSeeOrg, showComplianceNav,
    isConsumerAccount, complianceBadge, orgExpanded, orgNavGroups, settingsNavRows, resourceNavRows, onNavClick, setActiveTab,
}: SettingsSidebarProps) {
    const { t } = useTranslation();
    const effectiveRole = user?.orgRole || user?.role;
    const roleChip = roleLabel(effectiveRole, t);
    const roleIsAdmin = effectiveRole === 'admin' || effectiveRole === 'org_admin';
    const renderTopRow = (item: NavRow) => (
        <NavItem
            key={item.id}
            {...item}
            label={t(item.labelKey)}
            isActive={activeTab === item.id && !isOrgSubTab}
            onClick={onNavClick}
        />
    );

    // 180px on laptops <1280, 220px on larger screens — keeps enough room
    // for the settings content area without forcing horizontal scroll.
    // On phones it's the full-screen section list; once a section is
    // opened it's hidden in favour of the content panel.
    return (
    <div
            className={`flex-shrink-0 flex-col w-full md:w-[180px] xl:w-[220px] ${mobileDetail ? 'hidden md:flex' : 'flex'}`}
            style={{ background: 'var(--bg-secondary)', borderRight: '1px solid var(--border-subtle)' }}
        >
            {/* User mini-card */}
            <button
                type="button"
                onClick={() => { setActiveTab('preferences'); if (isMobile) setMobileDetail(true); }}
                className="flex items-center gap-3 px-4 py-3.5 transition-colors text-left w-full flex-shrink-0 hover:bg-[var(--item-hover-bg)]"
            >
                <AvatarDisplay user={user} size={34} />
                <div className="flex-1 min-w-0">
                    <p className="text-[13px] font-semibold truncate text-[var(--text-primary)]">
                        {user?.displayName || user?.username || 'User'}
                    </p>
                    {roleChip && (
                        <span
                            className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${roleIsAdmin
                                ? 'bg-[color-mix(in_srgb,var(--success)_14%,transparent)] text-[var(--success-ink)]'
                                : 'bg-[var(--bg-tertiary)] text-[var(--text-muted)]'}`}
                        >
                            {roleChip}
                        </span>
                    )}
                </div>
            </button>

            <div aria-hidden="true" className="h-px mx-3 bg-[var(--border-subtle)]" />

            {/* Nav */}
            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-px" role="navigation" aria-label={t('settings.title')}>
                <p className={`${SECTION_LBL} px-3 pb-1 pt-1.5`}>
                    {t('settings.personal_section', 'Personal')}
                </p>

                {settingsNavRows.map(renderTopRow)}

                {/* Compliance on a phone. The Organisation group it
                    normally lives in stays hidden here, so the section
                    is promoted to a top-level row rather than being
                    unreachable: artboard frame 1h is a phone frame, and
                    the deadline a DPO is chasing does not wait for a
                    laptop. Same id, same address — only the row moves.
                    It is a setting, so it sits above the resources. */}
                {!isSimpleMode && isMobile && showComplianceNav && (
                    <NavItem
                        id="org_compliance"
                        label={t('settings.compliance')}
                        icon={<Scale className="w-[15px] h-[15px] text-[var(--kind-compliance)]" />}
                        isActive={activeTab === 'org_compliance'}
                        onClick={onNavClick}
                        rightSlot={complianceBadge}
                    />
                )}

                {/* Learning Center and Help & Support are resources,
                    not settings: a thin rule above the first of them. */}
                {resourceNavRows.length > 0 && <NavDivider />}
                {resourceNavRows.map(renderTopRow)}

                {/* Organisation accordion — only if permitted. Hidden on
                    mobile: phones show user settings only. Pure-DPO users
                    (showComplianceNav without canSeeOrg) get the group
                    with just the Compliance entry. */}
                {!isSimpleMode && !isMobile && (canSeeOrg || showComplianceNav) && (
                    <>
                        <NavDivider />
                        <p className={`${SECTION_LBL} px-3 pb-1 pt-1`}>
                            {t('settings.workspace_section')}
                        </p>
                        {/* Parent row: only opens and closes the group.
                            Active while the group is closed on one of
                            its pages. */}
                        <NavItem
                            id="organisation"
                            label={t(ORG_PARENT_ITEM.labelKey)}
                            icon={ORG_PARENT_ITEM.icon}
                            isActive={isOrgSubTab && !orgExpanded}
                            onClick={onNavClick}
                            rightSlot={<Chevron open={orgExpanded} />}
                            ariaExpanded={orgExpanded}
                            ariaControls={orgExpanded ? 'settings-org-subnav' : undefined}
                        />

                        {/* Sub-items — animated slide-down, in topic
                            groups (ORG_NAV_GROUPS) with a thin rule
                            between them. */}
                        {orgExpanded && (
                            <div id="settings-org-subnav" className="space-y-px overflow-hidden [animation:fadeIn_120ms_ease]">
                                {orgNavGroups.map((group, gi) => (
                                    <React.Fragment key={group[0].id}>
                                        {gi > 0 && <NavDivider inset />}
                                        {group.map(s => (
                                            <OrgSubItem
                                                key={s.id}
                                                section={s}
                                                label={t(s.labelKey)}
                                                isActive={activeTab === s.id}
                                                onClick={setActiveTab}
                                                rightSlot={s.id === 'org_compliance' ? complianceBadge : null}
                                            />
                                        ))}
                                    </React.Fragment>
                                ))}
                            </div>
                        )}
                    </>
                )}

                {/* Consumer Account section — for org-less cloud users.
                    Hidden on mobile (user settings only). */}
                {!isSimpleMode && !isMobile && isConsumerAccount && !canSeeOrg && (
                    <>
                        <NavDivider />
                        <p className={`${SECTION_LBL} px-3 pb-1 pt-1`}>
                            {t('settings.account_section', 'Account')}
                        </p>
                        {CONSUMER_NAV_ITEMS.map(item => (
                            <NavItem
                                key={item.id}
                                {...item}
                                label={t(item.labelKey)}
                                isActive={activeTab === item.id}
                                onClick={onNavClick}
                            />
                        ))}
                    </>
                )}
            </div>

            {/* Footer — product name + build version (commit SHA is unique per CI deploy). */}
            <div className="px-4 py-3 flex-shrink-0 [border-top:1px_solid_var(--border-subtle)]">
                <p
                    className="text-[10px] text-[var(--text-muted)]"
                    title={formatVersionWithDate()}
                >
                    Bee Flow <span className="[opacity:0.7]">{formatVersion()}</span>
                </p>
            </div>
        </div>

    
    );
}
