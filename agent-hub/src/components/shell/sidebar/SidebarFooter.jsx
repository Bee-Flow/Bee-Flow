import { ChevronDown, LogOut, Settings, Shield, User } from 'lucide-react';
import React from 'react';
import { API_BASE } from '../../../utils/helpers';
import NavLink from '../NavLink';
import { ACCENT_BAR, ICON_ACTIVE, ICON_IDLE, TEXT_ACTIVE, TEXT_IDLE } from './sidebarTokens';

/* ── Account footer: avatar row plus the profile menu (admin dashboard,
   settings, sign out). Moved verbatim out of Sidebar's JSX; the menu state and
   the outside-click ref stay in Sidebar and arrive here as props. ── */
const SidebarFooter = ({
    isOpen, isMobile, user, t,
    profileRef, showProfileMenu, setShowProfileMenu,
    _simpleMode, currentPage, showSettings,
    onNavigate, onLogout,
}) => (
            <div className={`flex-shrink-0 mt-auto relative ${isOpen ? 'border-t border-[var(--border-subtle)]' : 'flex justify-center flex-shrink-0 border-t border-[var(--border-subtle)]'}`} ref={profileRef}>
                <div
                    onClick={() => setShowProfileMenu(v => !v)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            setShowProfileMenu(v => !v);
                        }
                    }}
                    className={`flex items-center transition-colors cursor-pointer ${isOpen ? 'w-full gap-2.5 px-4 h-14 ' + (showProfileMenu ? 'bg-[var(--bg-tertiary)]' : 'hover:bg-[var(--bg-tertiary)]') : 'w-10 h-10 my-3 rounded-full justify-center hover:bg-[var(--bg-tertiary)]'}`}
                    role="button"
                    tabIndex={0}
                    aria-label={t('sidebar.open_profile_menu', 'Open profile menu')}
                    aria-haspopup="menu"
                    aria-expanded={showProfileMenu}
                    data-testid="sidebar-profile"
                    data-tour="account"
                >
                    {user?.avatarType === 'emoji' && user?.avatar ? (
                        <div className={`rounded-full flex items-center justify-center flex-shrink-0 bg-[var(--bg-tertiary)] ${isOpen ? 'w-8 h-8 text-base' : 'w-10 h-10 text-xl'}`}>
                            {user.avatar}
                        </div>
                    ) : (user?.avatarType === 'image' || user?.avatarType === 'url') && user?.avatar ? (
                        <img src={user.avatar.startsWith('/') ? `${API_BASE}${user.avatar}` : user.avatar} alt="" className={`rounded-full object-cover flex-shrink-0 ${isOpen ? 'w-8 h-8' : 'w-10 h-10'}`} />
                    ) : (
                        <div className={`rounded-full flex items-center justify-center flex-shrink-0 ${isOpen ? 'w-8 h-8' : 'w-10 h-10'}`}
                            style={{ background: 'linear-gradient(135deg, var(--accent-primary), var(--accent-primary-hover))' }}>
                            <User className={`${isOpen ? 'w-4 h-4' : 'w-5 h-5'}`} style={{ color: 'var(--accent-primary-fg, #fff)' }} />
                        </div>
                    )}
                    {isOpen && (
                        <>
                            <div className="flex-1 min-w-0 text-left flex items-center gap-2">
                                <span className="text-[13px] font-medium truncate text-[var(--text-primary)]">
                                    {user?.displayName || user?.id || 'User'}
                                </span>
                            </div>
                            <ChevronDown className={`w-4 h-4 flex-shrink-0 text-[var(--text-tertiary)] transition-transform duration-200 ${showProfileMenu ? 'rotate-180' : ''}`} />
                        </>
                    )}
                </div>

                {showProfileMenu && (
                    <div
                        className={`absolute rounded-2xl border overflow-hidden z-50 ${isOpen ? 'bottom-full left-3 right-3 -mb-px' : 'bottom-full left-14 -mb-px w-64'}`}
                        style={{
                            borderColor: 'var(--border-default)',
                            boxShadow: 'var(--shadow-popover, 0 20px 60px rgba(15,23,42,0.18))',
                            animation: 'sidebarMenuIn .18s cubic-bezier(0.16, 1, 0.3, 1)',
                        }}
                        data-testid="profile-menu"
                        data-surface="opaque"
                    >
                        <div className="p-1.5">
                            {!_simpleMode && !isMobile && (user?.isAdmin || user?.permissions?.includes('all')) && (
                                <NavLink
                                    href="/admin"
                                    onClick={() => setShowProfileMenu(false)}
                                    onNavigate={() => { setShowProfileMenu(false); onNavigate('admin'); }}
                                    className={`w-full flex items-center gap-3 px-3 h-10 rounded-lg transition-all duration-150 text-left relative ${currentPage === 'admin' ? 'bg-[var(--item-active-bg)]' : 'hover:bg-[var(--item-hover-bg)]'}`}
                                    style={{ textDecoration: 'none', color: 'inherit' }}
                                    data-testid="profile-menu-admin"
                                >
                                    {currentPage === 'admin' && <div className={ACCENT_BAR} />}
                                    <Shield className={`w-4 h-4 ${currentPage === 'admin' ? ICON_ACTIVE : ICON_IDLE}`} strokeWidth={1.75} />
                                    <span className={`text-[13px] ${currentPage === 'admin' ? TEXT_ACTIVE : TEXT_IDLE}`}>{t('sidebar.admin_dashboard')}</span>
                                </NavLink>
                            )}

                            {/* Settings is an allowed mobile page (user settings only —
                                trimmed inside AdvancedSettings), so show it on phones too.
                                Admin Dashboard above stays desktop-only. */}
                            <NavLink
                                href="/settings"
                                onClick={() => setShowProfileMenu(false)}
                                onNavigate={() => { setShowProfileMenu(false); onNavigate('settings'); }}
                                className={`w-full flex items-center gap-3 px-3 h-10 rounded-lg transition-all duration-150 text-left relative ${showSettings ? 'bg-[var(--item-active-bg)]' : 'hover:bg-[var(--item-hover-bg)]'}`}
                                style={{ textDecoration: 'none', color: 'inherit' }}
                                data-testid="profile-menu-settings"
                            >
                                {showSettings && <div className={ACCENT_BAR} />}
                                <Settings className={`w-4 h-4 ${showSettings ? ICON_ACTIVE : ICON_IDLE}`} strokeWidth={1.75} />
                                <span className={`text-[13px] ${showSettings ? TEXT_ACTIVE : TEXT_IDLE}`}>{t('sidebar.settings')}</span>
                            </NavLink>

                        </div>

                        {/* Danger section — visually distinct so Sign Out is never
                            mistaken for an automation navigation action. */}
                        <div className="border-t p-1.5" style={{ borderColor: 'var(--border-subtle)' }}>
                            <button
                                onClick={onLogout}
                                className="w-full flex items-center gap-3 px-3 h-10 rounded-lg transition-all duration-150 text-left group/so hover:bg-red-500/10"
                                data-testid="sidebar-signout"
                            >
                                <LogOut className="w-4 h-4 text-red-500/80 group-hover/so:text-red-500 transition-colors" strokeWidth={1.75} />
                                <span className="text-[13px] font-medium text-red-500/80 group-hover/so:text-red-500 transition-colors">
                                    {t('sidebar.sign_out')}
                                </span>
                            </button>
                        </div>
                    </div>
                )}
            </div>
);

export default SidebarFooter;
