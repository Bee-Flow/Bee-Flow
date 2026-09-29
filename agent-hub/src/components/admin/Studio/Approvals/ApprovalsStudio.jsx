import { Building2, RefreshCw, Search, UserRound } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import useTranslation from '../../../../hooks/useTranslation';
import ApprovalDetail from './ApprovalDetail';
import { approvalStatusChip, formatWhen, STATUS_TABS } from './approvalDisplay';
import useApprovals from './useApprovals';
import { RequireTier } from '../../../licensing/LicenseContext';

/**
 * The Approvals section: every request waiting on a person, and the durable
 * record of every one that was decided — deliberately OUTSIDE the flow
 * builder, because the person deciding is often not the person who built the
 * routine and must never need the canvas to say yes.
 *
 * Scopes: 'mine' (owner ∨ assignee ∨ my groups' — every member) and 'org'
 * (org admins; the server 403s anyone else, so the toggle only renders for
 * admin-variant roles). Deep links land here as /app/studio/approvals/<id>.
 */
function ApprovalsStudioInner({ user = null, initialApprovalId = null }) {
    const { t } = useTranslation();
    const [statusTab, setStatusTab] = useState('pending');
    const [scope, setScope] = useState('mine');
    const [openId, setOpenId] = useState(initialApprovalId || null);
    // Search is debounced into the hook so a fast typist gets one query, not
    // one per keystroke; the server intersects it with the proven scope.
    const [search, setSearch] = useState('');
    const [q, setQ] = useState('');
    useEffect(() => {
        const timer = setTimeout(() => setQ(search.trim()), 300);
        return () => clearTimeout(timer);
    }, [search]);
    const { rows, facets, loading, error, hasMore, loadMore, reload, patchRow } = useApprovals({ scope, status: statusTab, q });

    // Adopt deep-link changes (bell click while the tab is already open,
    // Back/Forward) — the support-inbox pattern: prop changes win, INCLUDING
    // the change to null. The first version only adopted truthy ids, so
    // pressing Back from a detail updated the URL to the list while the
    // detail stayed open — a navigation trap on the one surface people reach
    // through their browser history.
    const lastInitialRef = React.useRef(initialApprovalId);
    useEffect(() => {
        if (initialApprovalId !== lastInitialRef.current) {
            lastInitialRef.current = initialApprovalId;
            setOpenId(initialApprovalId || null);
        }
    }, [initialApprovalId]);

    // Mirrors the server's ORG_ADMIN_VARIANTS (permissions.js) — 'admin' is
    // the legacy spelling of the same role. The 'org_admin' marker permission
    // is the fallback for group-granted admin rights. Read from user (the
    // /auth/user payload), never permsData — applyAuthSession drops orgRole
    // from the latter.
    const isOrgAdmin = !!user && (['org_admin', 'admin'].includes(user.orgRole) || user.isAdmin
        || (Array.isArray(user.permissions) && user.permissions.includes('org_admin')));

    const openApproval = useCallback((id) => {
        setOpenId(id);
        try {
            window.history.pushState({}, '', `/app/studio/approvals/${id}`);
        } catch { /* history not writable (tests) — the panel still opens */ }
    }, []);
    const closeApproval = useCallback(() => {
        setOpenId(null);
        try {
            window.history.pushState({}, '', '/app/studio/approvals');
        } catch { /* ignore */ }
        reload();
    }, [reload]);

    if (openId) {
        return (
            <>
                <MobileEscapeHatch />
                <ApprovalDetail
                    approvalId={openId}
                    onBack={closeApproval}
                    onDecided={(fresh) => patchRow(fresh)}
                />
            </>
        );
    }

    return (
        <div className="max-w-3xl mx-auto w-full px-4 sm:px-6 py-6 sm:py-10">
            <MobileEscapeHatch />
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <h1
                    className="text-[var(--text-primary)]"
                    style={{ fontSize: 'clamp(20px, 3.2vw, 26px)', fontWeight: 600, letterSpacing: '-0.02em' }}
                >
                    {t('approvals.title', 'Approvals')}
                </h1>
                <div className="flex items-center gap-1">
                    {isOrgAdmin && (
                        <div className="flex items-center gap-0.5 p-0.5 rounded-full bg-[var(--bg-secondary)]">
                            <ScopeButton active={scope === 'mine'} onClick={() => setScope('mine')} icon={<UserRound size={12} />} label={t('approvals.scope_mine', 'My approvals')} />
                            <ScopeButton active={scope === 'org'} onClick={() => setScope('org')} icon={<Building2 size={12} />} label={t('approvals.scope_org', 'Organisation')} />
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={reload}
                        aria-label={t('approvals.refresh', 'Refresh')}
                        className="p-2 rounded-full text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        <RefreshCw size={14} />
                    </button>
                </div>
            </div>

            {/* Search first, filters under it — the same order as the chat
                start screen: one thing to type in, then the quick choices. */}
            <div className="mt-5 relative">
                <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-tertiary)] pointer-events-none" />
                <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t('approvals.search', 'Search by question or routine…')}
                    aria-label={t('approvals.search', 'Search by question or routine…')}
                    data-testid="approvals-search"
                    className="w-full pl-10 pr-4 py-2.5 text-[13px] rounded-full border border-transparent bg-[var(--bg-secondary)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus-visible:border-[var(--border-default)] transition"
                />
            </div>

            <div className="mt-3 flex items-center gap-1 flex-wrap">
                {STATUS_TABS.map(tab => {
                    const n = facets?.status?.[tab.key] || 0;
                    const active = statusTab === tab.key;
                    return (
                        <button
                            key={tab.key}
                            type="button"
                            onClick={() => setStatusTab(tab.key)}
                            aria-pressed={active}
                            className={`px-3 py-1 rounded-full text-[12px] transition ${active
                                ? 'bg-[var(--text-primary)] text-[var(--bg-primary)] font-medium'
                                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)]'}`}
                        >
                            {t(`approvals.status_${tab.key}`, tab.label)}{n ? ` · ${n}` : ''}
                        </button>
                    );
                })}
            </div>

            {/* No card, no dividers: rows are separated by their own hover
                target and nothing else. A list of five approvals should read
                like a list, not like a table someone drew a box around. */}
            <div className="mt-4">
                {error && <div className="px-1 py-3 text-[13px] text-red-600 dark:text-red-400">{error}</div>}
                {!error && rows.length === 0 && !loading && (
                    <div className="px-1 py-14 text-center text-[13px] text-[var(--text-tertiary)]">
                        {statusTab === 'pending'
                            ? t('approvals.empty_waiting', 'Nothing is waiting for a decision.')
                            : t('approvals.empty', 'Nothing here yet.')}
                    </div>
                )}
                {rows.map(ap => (
                    <ApprovalRow key={ap.id} approval={ap} onOpen={() => openApproval(ap.id)} viewerId={user?.id} />
                ))}
                {loading && <div className="px-1 py-3 text-[12px] text-[var(--text-tertiary)]">{t('approvals.loading', 'Loading…')}</div>}
                {hasMore && !loading && (
                    <button
                        type="button"
                        onClick={loadMore}
                        className="mt-2 mx-auto block px-4 py-1.5 rounded-full text-[12px] text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        {t('approvals.show_more', 'Show more')}
                    </button>
                )}
            </div>
        </div>
    );
}

/**
 * On phones the Studio shell suppresses the chat chrome, the sidebar is
 * hidden behind a hamburger this surface doesn't render, and the notification
 * that brought the person here is gone — without this, a phone that opened an
 * approval had NO way anywhere else. Desktop never sees it.
 */
function MobileEscapeHatch() {
    const { t } = useTranslation();
    return (
        <div className="sm:hidden mb-2">
            <button
                type="button"
                onClick={() => {
                    try {
                        window.history.pushState({}, '', '/app');
                        window.dispatchEvent(new PopStateEvent('popstate'));
                    } catch { window.location.assign('/app'); }
                }}
                className="text-[12px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition"
            >
                {t('approvals.back_home', '← Bee Flow')}
            </button>
        </div>
    );
}

function ScopeButton({ active, onClick, icon, label }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={active}
            className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[12px] transition ${active
                ? 'bg-[var(--bg-primary)] text-[var(--text-primary)] font-medium shadow-sm'
                : 'text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]'}`}
        >
            {icon}{label}
        </button>
    );
}

/**
 * Licence gate — Approvals is Enterprise (`approvals`).
 *
 * Only BROWSING is walled: the list, its facets and the approver directory are
 * the gated routes server-side, so a community/lapsed org gets the upgrade
 * panel here instead of a list that 403s into an empty state.
 *
 * A deep link to ONE approval (initialApprovalId — the link in a notification
 * or e-mail) renders ungated on purpose. It mirrors the server's drain
 * exemption: GET /approvals/:id, decide and withdraw carry no gate, because a
 * pending approval holds a paused run, and a lapse must never leave that run
 * frozen with no way out. Finish what is in flight; pay to keep browsing.
 *
 * RequireTier fails OPEN on a degraded/erroring entitlements resolver — the
 * server gate stays authoritative, so a backend blip never walls a paying org.
 */
export default function ApprovalsStudio(props) {
    if (props.initialApprovalId) return <ApprovalsStudioInner {...props} />;
    return (
        <RequireTier feature="approvals">
            <ApprovalsStudioInner {...props} />
        </RequireTier>
    );
}

function ApprovalRow({ approval, onOpen, viewerId }) {
    const { t } = useTranslation();
    const chip = approvalStatusChip(approval.status);
    const waitingOnMe = approval.status === 'pending'
        && (approval.assigneeUserId === viewerId || (!approval.assigneeUserId && !approval.assigneeGroupId && approval.ownerId === viewerId));
    // Every fact the bordered table row carried, in the order someone scans
    // them: what is being asked, then who asked and when, then where it stands.
    const meta = [
        approval.automationTitle || t('approvals.automation', 'Automation'),
        formatWhen(approval.createdAt),
        approval.status === 'pending' && approval.expiresAt
            ? `${t('approvals.decide_before', 'decide before')} ${formatWhen(approval.expiresAt)}`
            : null,
        approval.decidedByName ? `${t('approvals.by', 'by')} ${approval.decidedByName}` : null,
    ].filter(Boolean).join(' · ');
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
            className="w-full flex items-center gap-3 px-3 py-3 -mx-3 rounded-2xl hover:bg-[var(--bg-secondary)] cursor-pointer transition"
            data-testid="approval-row"
        >
            <div className="flex-1 min-w-0">
                <div className="text-[13.5px] text-[var(--text-primary)] truncate">{approval.prompt || t('approvals.untitled', 'Approval requested')}</div>
                <div className="text-[11.5px] text-[var(--text-tertiary)] truncate mt-0.5">{meta}</div>
            </div>
            {waitingOnMe && (
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400 font-medium">{t('approvals.you', 'You')}</span>
            )}
            {/* A dot and a word instead of a filled pill: on the Waiting tab
                every row says the same thing, and five identical badges are
                five things to look past. The colour still carries. */}
            <span className={`shrink-0 inline-flex items-center gap-1.5 text-[11.5px] font-medium ${chip.textCls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${chip.dotCls}`} aria-hidden="true" />
                {t(`approvals.status_${approval.status}`, chip.label)}
            </span>
        </div>
    );
}
