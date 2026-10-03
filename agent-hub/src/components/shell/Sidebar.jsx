import { AppWindow, ClipboardList, FileText, Handshake, LayoutGrid, PenLine, Pin, Plus, Search, ShieldCheck, Store } from 'lucide-react';
import React, { useState, useRef, useEffect, useCallback } from 'react';
import NotificationCenter from './NotificationCenter';
import ConvRow from './sidebar/ConvRow';
import FlyoutRow from './sidebar/FlyoutRow';
import MyAgentsSection from './sidebar/MyAgentsSection';
import NavRow from './sidebar/NavRow';
import ProjectsSection from './sidebar/ProjectsSection';
import SidebarFooter from './sidebar/SidebarFooter';
import { ROW, ROW_IDLE, ACCENT_BAR, SECTION_LBL, appAccent, readExpanded, writeExpanded } from './sidebar/sidebarTokens';
import { useApprovalsNav } from './sidebar/useApprovalsNav';
import { useSidebarFlyouts } from './sidebar/useSidebarFlyouts';
import { useStudioSectionData } from './sidebar/useStudioSectionData';
import beeFlowLogo from '../../assets/bee-flow-logo.svg';
import beeFlowIcon from '../../assets/BeeFlow-logo-Icon-2026.svg';
import { countFor } from '../../hooks/useStudioCounts';
import { useTranslation } from '../../hooks/useTranslation';
import { usesStudioRail } from '../../authedApp/appRoutes';
import { isImageAvatar, resolveAvatarSrc, DEFAULT_AGENT_EMOJI } from '../../utils/agentAvatar';
import { recentForms, rememberFormOpened } from '../../utils/formRecents';
import { API_BASE, authFetch } from '../../utils/helpers';
import { STUDIO_RECENT_SOURCES } from '../../utils/studioRecentSources';
// The Studio app registry doubles as the sidebar's Studio-group source: the
// Studio screen no longer has its own tab bar, so the sections (and their
// gates) render here instead. Main-chunk-safe by design — see the import
// discipline note in studioApps.jsx.
import StudioRail from '../admin/Studio/StudioRail';
import { useStudioMenuHidden } from '../../hooks/useStudioChrome';
import { studioGateContext, studioNavSections, studioSectionLabel } from '../admin/Studio/studioNav';
import { STUDIO_APPS, firstOpenStudioSection, groupStudioApps, studioLockHint } from '../admin/Studio/studioApps';
import { useTheme } from '../appearance/ThemeContext';
import AppIcon from '../icons/AppIcon';
import { useEntitlements } from '../licensing/EntitlementsContext';
import { useLicenseContext } from '../licensing/LicenseContext';
import { kindColorVar } from '../shared/kindColors';

const Sidebar = ({
    isOpen, isMobile = false, onClose,
    selectedAgent, onClearSelection,
    favorites = [], agents = [],
    groupedConversations, currentConversation,
    onSelectConversation, onDeleteConversation,
    onSelectAgent, onOpenMarketplace, onOpenSearch,
    user, onLogout, onNavigate, currentPage, studioRoute = null,
    hasPermission: hasPermissionProp = null,
    onDirectChat, directChatMode,
    directConversations = [],
    onSelectDirectConversation, onDeleteDirectConversation,
    currentDirectConversation,
    toggleSidebar,
    onNewChat,
    onToggleFavorite,
    projects = [],
    activeProject,
    onOpenProject,
    onNewChatInProject,
    onCreateProject,
    onBrowseProjects,
    onMoveToProject,
    onShareToProject,
    onRenameConversation,
    onPinConversation,
    onLabelConversation,
    conversationLabels = [],
    onCreateLabel,
    onDeleteLabel,
    onEditLabel,
    chatHistoryMode = 'per-agent',
    allAgentConversations = [],
    onSelectAllChatsConversation,
    showSettings = false,
    showAgentDesigner = false,
    showAITasks = false,
    showSkillsPanel = false,
    showMarketplace = false,
}) => {
    const { t, locale } = useTranslation();
    // We'll use the 'isOpen' prop as 'sidebarOpen' (expanded state)
    // and if !isOpen, we'll show the narrow 'Power Bar'
    const [showProfileMenu, setShowProfileMenu] = useState(false);
    // An open automation can hide the Studio menu (see hooks/useStudioChrome).
    const studioMenuHidden = useStudioMenuHidden();
    const themeCtx = useTheme();
    const { hasFeature: hasLicenseFeature, deploymentMode } = useLicenseContext();
    // Effective-permission check for the Studio section gates. AgentHub passes
    // the real resolver; fall back to a permissions spot-check so the sidebar
    // renders sanely if a caller omits it.
    const hasPermission = hasPermissionProp || ((perm) => {
        const perms = user?.permissions || [];
        return perms.includes('all') || perms.includes(perm);
    });
    // App Studio consumers/builders get an "Apps" nav entry (the published-apps
    // directory at /app/apps). Gated on the app_studio capability — apps are
    // only shareable inside the licensed org, so anyone who can be an audience
    // holds the capability (see the Wave-8 viewer-entitlement decision).
    // `lockReason` decides hide-vs-lock for the Studio rows (see
    // studioApps.resolveStudioNav); older providers/mocks without it fall
    // back to null, i.e. today's hide-everything behaviour.
    // While the entitlements are still LOADING (every page load) or their
    // fetch FAILED, `can` answers false for everything and lockReason would
    // call each gated section 'ceiling' — so a licensed org watched Apps /
    // Webpages / Meeting notes / Solutions / Skills flash "Available on a
    // higher plan" on every load. A row is only locked once the answer is
    // real; until then the failed gate hides the row, as it always did.
    const {
        can: canUseCapability, lockReason: entitlementLockReason,
        loading: entitlementsLoading, error: entitlementsError,
    } = useEntitlements();
    const lockReason = (entitlementsLoading || entitlementsError || !entitlementLockReason)
        ? () => null
        : entitlementLockReason;
    // White-label override: in self-hosted deploys swap the Bee Flow logo for
    // the org's uploaded logo (and show a "Powered by Bee Flow" footer below).
    // Cloud is unchanged. Falls back to the Bee Flow logo if no org logo set.
    const orgLogoUrl = user?.organization?.logo
        ? (user.organization.logo.startsWith('/') ? `${API_BASE}${user.organization.logo}` : user.organization.logo)
        : null;
    const useOrgBrand = deploymentMode === 'self-hosted' && !!orgLogoUrl;
    const orgAltText = user?.organization?.name || 'Organization';
    const [agentsOpen, setAgentsOpen] = useState(() => readExpanded('agents', true));
    const [chatsOpen, setChatsOpen] = useState(() => readExpanded('chats', false));
    const [projectsOpen, setProjectsOpen] = useState(() => readExpanded('projects', true));
    const [activeCoworkCount, setActiveCoworkCount] = useState(0);
    const profileRef = useRef(null);
    const scrollRef = useRef(null);
    const secondaryItemRefs = useRef({});
    const [hiddenSecondaryKeys, setHiddenSecondaryKeys] = useState(() => new Set());

    const toggleAgents = useCallback(() => setAgentsOpen(p => { writeExpanded('agents', !p); return !p; }), []);
    const toggleChats = useCallback(() => setChatsOpen(p => { writeExpanded('chats', !p); return !p; }), []);
    const toggleProjects = useCallback(() => setProjectsOpen(p => { writeExpanded('projects', !p); return !p; }), []);

    /* ─── Studio + Apps flyout panels — state, grace timers and dismissal all
       live in useSidebarFlyouts (called here so the state stays on Sidebar's
       fiber); see that file for the full mechanics. */
    const {
        flyout, openFlyout, hoverFlyout, scheduleFlyoutClose,
        subFlyout, hoverSubFlyout, scheduleSubFlyoutClose,
        closeFlyout,
    } = useSidebarFlyouts(scrollRef);

    // Who gets a Studio row at all — the same condition the secondaryNav
    // literal below uses, hoisted here (before the early return) so the
    // counts poll can be switched off for everyone else. Simple Mode and
    // phones run the simplified surface (see AgentHub's `simpleMode`).
    const _userPermissions = user?.permissions || [];
    const canSeeStudio = !user?.simpleMode && !isMobile && (
        !!user?.isAdmin || _userPermissions.includes('all')
        || _userPermissions.includes('manage_agents') || _userPermissions.includes('manage_skills')
        || user?.orgRole === 'admin' || user?.orgRole === 'org_admin'
    );

    /* ─── Published apps/forms + per-Studio-section recent items + counts for
       the flyouts above — see useStudioSectionData. */
    const {
        runtimeStudioApps, publishedApps, hasApps,
        canSeeForms, publishedForms, hasForms,
        loadSectionItems, recentItemsFor,
        studioCounts,
    } = useStudioSectionData({ currentPage, canUseCapability, hasLicenseFeature, user, countsEnabled: canSeeStudio });

    // Close profile menu on outside click
    useEffect(() => {
        if (!showProfileMenu) return;
        const close = (e) => { if (profileRef.current && !profileRef.current.contains(e.target)) setShowProfileMenu(false); };
        document.addEventListener('mousedown', close);
        return () => document.removeEventListener('mousedown', close);
    }, [showProfileMenu]);

    // Track which secondaryNav items have scrolled above the visible scroll
    // region so we can render them as a compact icon strip pinned below the
    // static coreNav. Uses IntersectionObserver against the scroll container.
    const observerRef = useRef(null);
    useEffect(() => {
        if (!isOpen) { setHiddenSecondaryKeys(new Set()); return; }
        const root = scrollRef.current;
        if (!root) return;
        const observer = new IntersectionObserver((entries) => {
            setHiddenSecondaryKeys(prev => {
                const next = new Set(prev);
                let changed = false;
                for (const entry of entries) {
                    const key = entry.target.dataset.navKey;
                    if (!key) continue;
                    const rootTop = entry.rootBounds?.top ?? 0;
                    const isAbove = !entry.isIntersecting && entry.boundingClientRect.bottom <= rootTop;
                    if (isAbove) {
                        if (!next.has(key)) { next.add(key); changed = true; }
                    } else {
                        if (next.has(key)) { next.delete(key); changed = true; }
                    }
                }
                return changed ? next : prev;
            });
        }, { root, threshold: 0 });
        observerRef.current = observer;
        Object.values(secondaryItemRefs.current).forEach(el => { if (el) observer.observe(el); });
        return () => { observer.disconnect(); observerRef.current = null; };
    }, [isOpen]);

    const setSecondaryRef = useCallback((key) => (el) => {
        const prev = secondaryItemRefs.current[key];
        if (prev && prev !== el && observerRef.current) observerRef.current.unobserve(prev);
        if (el) {
            secondaryItemRefs.current[key] = el;
            if (observerRef.current) observerRef.current.observe(el);
        } else {
            delete secondaryItemRefs.current[key];
        }
    }, []);

    // How much is currently running or scheduled, shown as a badge on the
    // Cowork row. Counted from /api/cowork, not /api/ai-tasks: prompt tasks
    // were migrated into cowork, and the old count was fetched every render
    // pass but never actually displayed anywhere.
    // Re-read whenever the user leaves or enters Cowork, so create / pause /
    // delete over there is reflected when they come back.
    useEffect(() => {
        let cancelled = false;
        const load = async () => {
            try {
                const res = await authFetch(`${API_BASE}/api/cowork`);
                if (!res.ok || cancelled) return;
                const data = await res.json();
                const schedules = Array.isArray(data?.schedules) ? data.schedules : [];
                setActiveCoworkCount(schedules.filter(s => s.isActive).length);
            } catch { /* silent */ }
        };
        load();
        return () => { cancelled = true; };
    }, [currentPage]);

    // "Waiting on you" — how many approvals this person can decide right now
    // (the badge), and whether the Approvals row belongs in the menu at all.
    // See useApprovalsNav for the poll, the org-admin probe, and what
    // hasApprovals does and does not mean.
    //
    // LICENCE: /approvals/facets is one of the gated (browse) routes, so
    // polling it without `approvals` would only collect 403s. ROLE: the licence
    // says this installation sells approvals, `use_approvals` says this person
    // is one of the people who handle them. Deliberately NOT the Studio/builder
    // gate: an assignee is often exactly the person with no builder rights, and
    // until this row existed they could not find their own inbox. Deep links to
    // a single approval keep working either way (the server's drain exemption),
    // so a lapsed org can still finish pending decisions from its bell.
    const canBrowseApprovals = hasLicenseFeature('approvals') && hasPermission('use_approvals');
    const isOrgAdminLike = !!(user?.isAdmin || user?.orgRole === 'admin' || user?.orgRole === 'org_admin'
        || (user?.permissions || []).includes('all'));
    const { pendingCount: pendingApprovalCount, hasApprovals } = useApprovalsNav({
        canBrowseApprovals,
        isOrgAdmin: isOrgAdminLike,
    });

    // On mobile, completely hide when closed (hamburger in header opens it)
    if (!isOpen && isMobile) return null;

    /* ─── Data ─── */
    const favoriteAgents = agents.filter(a => favorites.includes(a.id));
    const typeOf = () => 'Chat';

    const allConvs = (() => {
        // Inside a project: only that project's chats. That IS the point of
        // selecting one.
        //
        // Outside a project, project chats used to be HIDDEN entirely. Combined
        // with Projects having no URL, a chat filed into a project became very
        // easy to lose: it was absent from every list the user could reach
        // without first remembering which project they had put it in. They are
        // shown now, and ConvRow renders a project chip so the filing is still
        // visible.
        const withinProject = (convs) => (activeProject
            ? convs.filter(c => c.project_id === activeProject.id)
            : convs);

        // "All Chats" mode — unified timeline from all agents + direct
        if (chatHistoryMode === 'all-chats') {
            return withinProject(allAgentConversations);
        }
        // Default: per-agent mode
        let convs;
        if (directChatMode) convs = directConversations;
        else if (!groupedConversations) convs = [];
        else convs = groupedConversations.flatMap(([, c]) => c);
        return withinProject(convs);
    })();

    /* ── Time-grouped conversations (with pinned section) ── */
    const groupedConvs = (() => {
        const convs = allConvs;
        if (convs.length === 0) return [];
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
        const monthStart = new Date(todayStart); monthStart.setDate(monthStart.getDate() - 30);
        const groups = { pinned: [], today: [], yesterday: [], month: [], older: [] };
        convs.forEach(c => {
            // Pinned conversations go to their own group
            if (c.pinned) {
                groups.pinned.push(c);
                return;
            }
            const rawDate = c.updated_at || c.created_at;
            const d = rawDate ? new Date(rawDate) : new Date(0);

            const msgStart = new Date(d.getFullYear(), d.getMonth(), d.getDate());
            const diffDays = Math.floor((todayStart - msgStart) / (1000 * 60 * 60 * 24));

            if (diffDays <= 0) groups.today.push(c);
            else if (diffDays === 1) groups.yesterday.push(c);
            else if (diffDays <= 30) groups.month.push(c);
            else groups.older.push(c);
        });
        return [
            { label: t('sidebar.pinned'), items: groups.pinned, isPinned: true },
            { label: t('sidebar.today'), items: groups.today },
            { label: t('sidebar.yesterday'), items: groups.yesterday },
            { label: t('sidebar.last_30_days'), items: groups.month },
            { label: t('sidebar.older'), items: groups.older },
        ].filter(g => g.items.length > 0);
    })();
    const previewConvs = allConvs.slice(0, 3);
    const hasMore = allConvs.length > 3;

    const isAllChats = chatHistoryMode === 'all-chats';
    const convIsActive = (c) => {
        if (isAllChats) {
            // In all-chats mode, check both agent and direct conversations
            return currentDirectConversation?.id === c.id || currentConversation?.id === c.id;
        }
        return directChatMode ? currentDirectConversation?.id === c.id : currentConversation?.id === c.id;
    };
    const selectConv = (c) => {
        if (isAllChats && onSelectAllChatsConversation) {
            onSelectAllChatsConversation(c);
            return;
        }
        return directChatMode ? onSelectDirectConversation(c) : onSelectConversation(c);
    };
    const deleteConv = (conv) => {
        if (isAllChats) {
            // In all-chats mode, route to the correct handler based on source
            if (conv._source === 'direct') {
                onDeleteDirectConversation?.(conv.id);
            } else {
                onDeleteConversation(conv.id, conv.agent_id);
            }
            return;
        }
        return directChatMode ? onDeleteDirectConversation?.(conv.id) : onDeleteConversation(conv.id, conv.agent_id);
    };

    /* ─── Nav data + row renderer (used both in pinned top nav and inside the
       scrollable region, so secondary items scroll away like ChatGPT). */
    const _betaFeatures = Array.isArray(user?.betaFeatures) ? user.betaFeatures : [];
    const _permissions = user?.permissions || [];
    const _featureFlags = user?.featureFlags || {};
    // Simple Mode strips the sidebar to: New Chat, Search, Agents, Chat History.
    // Anything past `agents` in secondaryNav and the admin/appearance items in
    // the avatar dropdown are hidden until the user turns Simple Mode back off.
    // Phone-sized screens (isMobile) always run the simplified surface — see
    // AgentHub's `simpleMode` derivation — regardless of the stored preference.
    const _simpleMode = !!user?.simpleMode || isMobile;

    // "New Chat" highlight must clear once any other destination takes over the
    // main content. Previously it stayed bold (directChatMode/selectedAgent are
    // not reset when an overlay/page opens), so two items looked active at once
    // (BFSF-172). Gate it on the same view flags the other nav items use.
    const _otherViewActive = showMarketplace || showSettings || showAITasks
        || showSkillsPanel
        || ['studio', 'admin', 'cowork', 'apps', 'appRun', 'forms', 'formView'].includes(currentPage);

    // Studio sections for the sidebar group — the same registry + gates the
    // Studio shell renders from (built-ins first, then runtime modules).
    // resolveStudioNav lists the gate-passing sections AND the ones locked
    // on a licence/capability (spread with `locked`); a section whose gate
    // fails for a permission reason is hidden, as before.
    // Gate context + the resolved rows come from studioNav.js, shared with the
    // Studio rail and the Start screen so the three cannot answer the gate
    // question three ways. `lockReason` is already guarded above; passing the
    // guarded one keeps that decision in one place.
    const _studioGateCtx = studioGateContext({ user, hasLicenseFeature, hasPermission, can: canUseCapability, lockReason });
    const studioSections = studioNavSections([...STUDIO_APPS, ...runtimeStudioApps], _studioGateCtx);

    /* ─── The Studio rail (H1) ───
       On /app/studio* the workspace swaps THIS sidebar for Studio's own 240px
       rail. The swap happens here rather than in AuthedApp because AuthedApp
       does not render a Sidebar at all (AgentHub does), and because whether we
       are below the mobile breakpoint is a fact only this component holds.

       Three conditions, and each is load-bearing:
         usesStudioRail(page, section) — the page IS Studio, and it is not the
           Approvals slice (a Studio address with a member audience; see the
           flag's own comment).
         !isMobile — a phone keeps the ordinary sidebar. There is nothing to
           replace there anyway: canSeeStudio is already false on mobile, so a
           phone has no Studio row to begin with.
         canSeeStudio — someone who never had a Studio row does not get a
           Studio rail either; a deep link still renders the section itself,
           with the sidebar they know beside it.

       Placed after every hook and after studioSections, so the early return
       cannot change hook order and the rail gets exactly the rows the flyout
       would have shown. */
    if (usesStudioRail(currentPage, studioRoute?.section) && !isMobile && canSeeStudio) {
        if (studioMenuHidden) return null;
        return (
            <StudioRail
                sections={studioSections}
                studioCounts={studioCounts}
                activeSection={studioRoute?.section || null}
                onNavigate={onNavigate}
                user={user}
                onLogout={onLogout}
                currentPage={currentPage}
                showSettings={showSettings}
                isMobile={isMobile}
                simpleMode={_simpleMode}
                profileRef={profileRef}
                showProfileMenu={showProfileMenu}
                setShowProfileMenu={setShowProfileMenu}
                // The rail replaces this sidebar, and the top-level Approvals
                // row below is the only entrance to that queue. It is not a
                // Studio section (hiddenFromNav), so it cannot ride along in
                // `sections` — it goes over as its own pair, from the same
                // state this file already polls for the badge.
                canBrowseApprovals={canBrowseApprovals}
                pendingApprovalCount={pendingApprovalCount}
            />
        );
    }

    // The section NAME comes from studioNav.studioSectionLabel — this file used
    // to keep its own two-line copy, and that copy was missing the shared
    // version's fallbacks (a descriptor without labelKey asked t(undefined)
    // instead of falling back to its own id), so the flyout could disagree with
    // the rail about what a section is called.

    // One-line flyout description. Built-ins declare descKey/descFallback in
    // the registry; runtime modules without one simply show no description.
    const studioSectionDesc = (app) => (app.descKey ? t(app.descKey, app.descFallback) : null);
    // One section → one renderFlyoutRow descriptor. Kept here rather than
    // inline in the nav literal so the grouped map below stays readable.
    const studioFlyoutRow = (app) => ({
        key: `studio-${app.id}`,
        label: studioSectionLabel(app, t, locale),
        desc: studioSectionDesc(app),
        icon: app.Icon,
        // The glyph wears its kind's colour (Studio Nav artboard); a runtime
        // module has no kind and gets the neutral secondary ink.
        iconColor: app.kind ? kindColorVar(app.kind) : (app.runtime ? 'var(--text-secondary)' : undefined),
        // Absent until the counts poll answers, and absent for good for any
        // key the server left out (a kind this caller may not see) or any
        // section without a countKey (runtime modules). A runtime module
        // never falls back to its id: one whose id happens to equal a
        // first-party key ('agents', …) would otherwise wear that number.
        count: app.runtime ? countFor(studioCounts, app.countKey) : countFor(studioCounts, app.countKey || app.id),
        locked: !!app.locked,
        lockHint: app.locked ? studioLockHint(app.locked, t) : undefined,
        onClick: () => onNavigate && onNavigate(`studio/${app.urlSegment}`),
        active: currentPage === 'studio' && studioRoute?.section === app.id,
        // Sections with a known list source get the second-level "what was I
        // working on" panel. Runtime module sections have no source and so
        // stay plain rows; a locked section has nothing to list.
        subKey: STUDIO_RECENT_SOURCES[app.id] && !app.locked ? app.id : undefined,
        subSegment: app.urlSegment,
        subLabel: studioSectionLabel(app, t, locale),
    });

    const coreNav = [
        { key: 'new-chat', label: t('sidebar.new_chat', 'New Chat'), icon: PenLine, onClick: onDirectChat, active: directChatMode && !selectedAgent && !_otherViewActive },
        // Cowork sits right under New Chat on purpose: "ask" and "delegate" are
        // the two things people come here to do, and prompt automation used to
        // be buried three levels inside Studio → Routines. Phone-friendly, so
        // no isMobile guard.
        // Handshake, not Sparkles: Cowork is a colleague taking something off
        // your plate, not a magic-AI feature. Sparkles also already means
        // "Skills" one level down in Studio, so it named two different things.
        { key: 'cowork', label: t('sidebar.cowork', 'Cowork'), icon: Handshake, onClick: () => onNavigate && onNavigate('cowork'), active: currentPage === 'cowork', badge: activeCoworkCount },
        // Approvals — the ONLY entrance now that the Studio panel no longer
        // lists it, so it is here whenever this person is part of ANY approval
        // rather than only while something is waiting: the decided ones are a
        // record people go looking for, and a row that vanishes the moment the
        // queue empties takes that record with it. The badge still appears only
        // when something is actually pending.
        // It DOES go away for someone with no approvals at all — never
        // assigned, never asked, and (as an org admin) an organisation that has
        // never raised one: a row that has never led anywhere is not an
        // entrance, just a thing to wonder about. It comes back on the next
        // poll the moment they are named in one. See useApprovalsNav.
        // Phone-friendly (the approvals slice is mobile-allowed) and NOT behind
        // any builder gate: deciding is a member act, not an admin one.
        ...(canBrowseApprovals && hasApprovals
            ? [{ key: 'approvals', label: t('sidebar.approvals', 'Approvals'), icon: ShieldCheck, onClick: () => onNavigate && onNavigate('studio/approvals'), active: currentPage === 'studio' && studioRoute?.section === 'approvals', badge: pendingApprovalCount }]
            : []),
        { key: 'search', label: t('sidebar.search'), icon: Search, onClick: onOpenSearch, active: false },
    ];

    const secondaryNav = [
        { key: 'agents', label: t('sidebar.agents', 'Agents'), icon: Store, onClick: onOpenMarketplace, active: showMarketplace },
        // Studio — a flyout, not a screen: its sections (registry-gated) open
        // from the side panel and each deep-links straight into the shell.
        // The row's onClick (compact strip / mobile fallback) lands on the
        // first visible UNLOCKED section — a locked row is a signpost, not a
        // door, so it must not be the place the row itself opens.
        // `studioSections.length` is part of the gate, not an afterthought: the
        // permission says this person may BUILD, the sections say there is
        // something for them to build with. An org whose licence gates every
        // section away got a row that opened an empty panel — or, through the
        // compact strip, navigated into a section it had just refused to list.
        ...(canSeeStudio && studioSections.length > 0
            ? [{
                key: 'studio',
                label: t('studio.sidebar_link', 'Studio'),
                icon: LayoutGrid,
                // Safe even though the gate above proved the list is non-empty:
                // the first visible section may be locked, so the helper picks
                // the first OPEN one (falling back to the first built-in).
                onClick: () => onNavigate && onNavigate(`studio/${firstOpenStudioSection(studioSections, STUDIO_APPS[0]).urlSegment}`),
                active: currentPage === 'studio',
                // Grouped, not flat: ten sections in one column is a wall, and
                // "which of these builds a thing and which of these teaches the
                // assistant something" is the split people actually navigate by.
                // The grouping is declared in the registry (studioApps.jsx):
                // Build · AI · Bundle for the first-party sections, Add-ons
                // for installed modules — which may file themselves under a
                // first-party heading by naming one.
                flyout: {
                    groups: groupStudioApps(studioSections).map(({ category, apps }) => ({
                        key: category.id,
                        label: t(category.labelKey, category.labelFallback),
                        children: apps.map(studioFlyoutRow),
                    })),
                },
            }]
            : []),
        // Apps — the published-apps directory PLUS every published app the
        // user can open, as its own flyout row. Shown to anyone with the
        // app_studio capability (builders and org members who can be an
        // audience) who can actually open at least one published app: the row
        // IS the directory, and a directory of nothing is a dead end. A builder
        // whose apps are all still drafts reaches App Studio through Studio →
        // Apps, and this row joins the menu the moment they publish one.
        // Reachable on phones too (no flyout there — the row navigates to the
        // directory, which stacks).
        ...(canUseCapability('app_studio') && hasPermission('use_apps') && hasApps
            ? [{
                key: 'apps',
                label: t('sidebar.apps', 'Apps'),
                icon: AppWindow,
                onClick: () => onNavigate && onNavigate('apps'),
                active: currentPage === 'apps' || currentPage === 'appRun',
                flyout: {
                    children: [
                        {
                            key: 'apps-all',
                            label: t('sidebar.all_apps', 'All apps'),
                            desc: t('sidebar.all_apps_desc', 'Browse everything published for you'),
                            icon: AppWindow,
                            onClick: () => onNavigate && onNavigate('apps'),
                            active: currentPage === 'apps',
                        },
                        ...publishedApps.map(app => ({
                            key: `app-${app.id}`,
                            label: app.name || 'Untitled app',
                            desc: app.description || null,
                            iconNode: (
                                <AppIcon
                                    name={app.icon || 'LayoutGrid'}
                                    className="w-4 h-4 flex-shrink-0 mt-0.5"
                                    style={{ color: appAccent(app.accentColor) }}
                                />
                            ),
                            onClick: () => onNavigate && onNavigate(`apps/${app.id}`),
                            active: currentPage === 'appRun' && typeof window !== 'undefined' && window.location.pathname.startsWith(`/app/apps/${app.id}`),
                        })),
                    ],
                },
            }]
            : []),
        // Forms — every form published in the organisation, as its own flyout
        // row, built the same way Apps is, and listed only once the
        // organisation has published one: same reasoning as Apps above, and the
        // list is org-wide, so a colleague's form is enough to keep the row.
        // Rows open the form in this tab (see the note on the row itself —
        // forms are signed-in only now, so /f/<token> is just a redirect back
        // here and opening one should not reload the workspace).
        ...(canSeeForms && hasPermission('use_forms') && hasForms && !isMobile
            ? [{
                key: 'forms',
                label: t('sidebar.forms', 'Forms'),
                icon: ClipboardList,
                onClick: () => onNavigate && onNavigate('forms'),
                active: currentPage === 'forms' || currentPage === 'formView',
                flyout: {
                    children: [
                        {
                            key: 'forms-all',
                            label: t('sidebar.all_forms', 'All forms'),
                            desc: t('sidebar.all_forms_desc', 'Every form published in your organisation'),
                            icon: ClipboardList,
                            onClick: () => onNavigate && onNavigate('forms'),
                            active: currentPage === 'forms',
                        },
                        // At most five, because an organisation can publish far
                        // more than a menu can hold: the ones THIS user opens,
                        // most recent first, then newest-published for anyone
                        // who has not opened one yet. "All forms" below the
                        // fold is the way to the rest.
                        ...recentForms(publishedForms, 5).map(form => ({
                            key: `form-${form.id}`,
                            label: form.title || 'Untitled form',
                            // A paused or draft routine answers 404 to its
                            // visitors, so say so here rather than letting
                            // someone hand out a link that does nothing.
                            desc: form.live
                                ? (form.description || null)
                                : t('sidebar.form_not_live', 'Not live — the routine is paused or still a draft'),
                            icon: ClipboardList,
                            // In-app, in this tab: forms are signed-in only
                            // now, so /f/<token> is just a redirect here and
                            // opening one should not reload the workspace.
                            onClick: () => {
                                rememberFormOpened(form.id);
                                onNavigate && onNavigate(`forms/${form.id}`);
                            },
                            active: currentPage === 'formView'
                                && typeof window !== 'undefined'
                                && window.location.pathname === `/app/forms/${form.id}`,
                        })),
                    ],
                },
            }]
            : []),
        // hasLicenseFeature short-circuits each entry on community-tier
        // installs — the licence gate is the source of truth; the beta
        // opt-in and permissions remain as additional org-level controls.
        // Meeting Notes lives inside Studio (Mic tab) and is reached there;
        // no top-level sidebar entry.
        // Notebooks have no row of their own: a notebook is a document type, in
        // Studio → Documents.
    ];

    /* ── Flyout-panel and nav rows render in sidebar/FlyoutRow and
       sidebar/NavRow; these adapters thread Sidebar's state through as
       props (renderFlyoutRow is also handed to NavRow for its panel). ── */
    const renderFlyoutRow = (item) => (
        <FlyoutRow
            key={item.key}
            item={item}
            recentItemsFor={recentItemsFor}
            subFlyout={subFlyout}
            closeFlyout={closeFlyout}
            loadSectionItems={loadSectionItems}
            hoverSubFlyout={hoverSubFlyout}
            scheduleSubFlyoutClose={scheduleSubFlyoutClose}
            onNavigate={onNavigate}
            t={t}
            locale={locale}
        />
    );

    const renderNavRow = (item) => (
        <NavRow
            key={item.key}
            item={item}
            isOpen={isOpen}
            isMobile={isMobile}
            flyout={flyout}
            openFlyout={openFlyout}
            hoverFlyout={hoverFlyout}
            closeFlyout={closeFlyout}
            scheduleFlyoutClose={scheduleFlyoutClose}
            renderFlyoutRow={renderFlyoutRow}
        />
    );

    /* ─── The sidebar ─── */
    const content = (
        <div
            className={`h-full flex flex-col bg-[var(--bg-secondary)] border-r border-[var(--border-subtle)] flex-shrink-0 transition-all duration-300 ${isOpen ? 'w-72' : 'w-16 cursor-pointer'}`}
            data-testid="sidebar"
            data-surface="subtle"
            data-static
            onClick={(e) => {
                if (!isOpen && !e.target.closest('button')) {
                    toggleSidebar();
                }
            }}
        >

            {/* ── Top Bar Container ── */}
            <div className={`px-3 py-3 flex items-center flex-shrink-0 ${isOpen ? 'justify-between' : 'justify-center border-b border-[var(--border-subtle)]/50'}`}>
                {isOpen ? (
                    <>
                        <button
                            onClick={onDirectChat}
                            className="flex items-center gap-2.5 rounded-xl transition-transform hover:scale-105"
                            aria-label={t('sidebar.new_chat', 'New Chat')}
                        >
                            {useOrgBrand
                                ? <div className="w-[4.5rem] h-[4.5rem] rounded-xl overflow-hidden flex items-center justify-center bg-[var(--bg-primary)]">
                                      <img src={orgLogoUrl} alt={orgAltText} className="w-full h-full object-contain" />
                                  </div>
                                : <img src={beeFlowLogo} alt="Bee Flow" className="w-[4.5rem] h-[4.5rem] rounded-xl object-cover" />}
                        </button>
                        <div className="flex items-center gap-1">
                            <NotificationCenter variant="icon" />
                            <button
                                onClick={toggleSidebar}
                                className="p-1.5 hover:bg-[var(--bg-tertiary)] rounded-lg text-[var(--text-tertiary)] transition-colors"
                                aria-label="Toggle sidebar"
                                data-testid="toggle-sidebar"
                            >
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></svg>
                            </button>
                        </div>
                    </>
                ) : (
                    <button
                        onClick={toggleSidebar}
                        className="hover:bg-[var(--bg-tertiary)] rounded-xl text-[var(--text-primary)] transition-all transform hover:scale-105 flex items-center justify-center w-12 h-12 overflow-hidden p-1"
                    >
                        {useOrgBrand
                            ? <img src={orgLogoUrl} alt={orgAltText} className="w-full h-full rounded-lg object-contain" />
                            : <img src={beeFlowIcon} alt="Bee Flow" className="w-8 h-8 rounded-lg object-contain" />}
                    </button>
                )}
            </div>

            {/* "Powered by Bee Flow" — placed directly under the org logo in
                self-hosted (white-label) mode. Hidden in collapsed sidebar. */}
            {useOrgBrand && isOpen && (
                <div className="flex-shrink-0 px-3 -mt-1 mb-1 text-[10px] text-left text-[var(--text-tertiary)]">
                    <a
                        href="https://beeflow.nl"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-[var(--text-secondary)] transition-colors"
                    >
                        {t('sidebar.powered_by', 'Powered by Bee Flow')}
                    </a>
                </div>
            )}

            {/* ── Nav rows ── (pinned: New Chat + Search) */}
            <nav aria-label="Main navigation" data-testid="main-navigation" className={`px-2 pt-3 flex-shrink-0 flex flex-col gap-1 ${isOpen ? '' : 'items-center'}`}>
                {coreNav.map(renderNavRow)}
            </nav>

            {/* ── Favorite Agents (Narrow Mode) ── */}
            {!isOpen && favoriteAgents.length > 0 && (
                <div className="flex flex-col items-center gap-2 mt-4 pt-4 border-t border-[var(--border-subtle)]/50">
                    {favoriteAgents.map(agent => (
                        <button
                            key={agent.id}
                            onClick={() => onSelectAgent(agent)}
                            className={`relative w-10 h-10 rounded-xl flex items-center justify-center text-lg font-semibold transition-all hover:scale-110 overflow-hidden ${selectedAgent?.id === agent.id ? 'scale-110' : ''}`}
                            title={agent.name}
                        >
                            {selectedAgent?.id === agent.id && <div className={ACCENT_BAR.replace('left-0', '-left-1.5')} />}
                            {isImageAvatar(agent.avatar) ? (
                                <img src={resolveAvatarSrc(agent.avatar)} alt="" loading="lazy" className="w-full h-full object-cover" />
                            ) : (agent.avatar || agent.name?.[0]?.toUpperCase())}
                        </button>
                    ))}
                </div>
            )}

            {/* ── Compact icon strip for secondaryNav items that have scrolled out of view ── */}
            {isOpen && hiddenSecondaryKeys.size > 0 && (
                <div className="px-2 py-1.5 flex items-center gap-1 flex-wrap flex-shrink-0 border-b border-[var(--border-subtle)]/50">
                    {secondaryNav.filter(item => hiddenSecondaryKeys.has(item.key)).map(item => (
                        <button
                            key={item.key}
                            onClick={item.onClick}
                            title={item.label}
                            aria-label={item.label}
                            className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors flex-shrink-0 ${item.active ? 'bg-[var(--accent-primary)]/10 text-[var(--accent-primary)]' : 'text-[var(--text-tertiary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'}`}
                        >
                            <item.icon className="w-4 h-4" strokeWidth={item.active ? 2.25 : 1.75} />
                        </button>
                    ))}
                </div>
            )}

            {/* ── Scrollable middle region (Secondary nav + Projects + My Agents + Chats) ── */}
            <div ref={scrollRef} className={`flex-1 min-h-0 flex flex-col overflow-y-auto custom-scrollbar ${isOpen ? '' : ''}`}>

            {/* ── Secondary nav (Agents, AI Tasks, KB, Meeting Notes, Skills, Tickets, Notebooks)
                 — sits inside the scroll region so it scrolls away like ChatGPT ── */}
            {isOpen && secondaryNav.length > 0 && (
                <nav aria-label="Secondary navigation" className="px-2 pt-1 flex-shrink-0 flex flex-col gap-1">
                    {secondaryNav.map(item => (
                        <div key={item.key} ref={setSecondaryRef(item.key)} data-nav-key={item.key}>
                            {renderNavRow(item)}
                        </div>
                    ))}
                </nav>
            )}

            {/* ── Projects ── */}
            {isOpen && !_simpleMode && hasLicenseFeature('projects') && user?.featureFlags?.projects !== false && projects.length > 0 && (
                <ProjectsSection
                    t={t}
                    projects={projects}
                    projectsOpen={projectsOpen}
                    toggleProjects={toggleProjects}
                    activeProject={activeProject}
                    onCreateProject={onCreateProject}
                    onOpenProject={onOpenProject}
                    onNewChatInProject={onNewChatInProject}
                    onBrowseProjects={onBrowseProjects}
                />
            )}

            {/* ── New Project (when no projects yet) ── same gate as the
                group above, Simple Mode included: on a phone the projects
                pages redirect to /app, so the row would lead nowhere. */}
            {isOpen && !_simpleMode && hasLicenseFeature('projects') && user?.featureFlags?.projects !== false && projects.length === 0 && (
                <div className="px-2 mt-1">
                    <button
                        onClick={() => onCreateProject?.()}
                        className={`${ROW} ${ROW_IDLE} text-[var(--text-tertiary)]`}
                    >
                        <Plus className="w-4 h-4" />
                        <span className="text-[13px]">{t('sidebar.new_project')}</span>
                    </button>
                </div>
            )}

            {/* ── Divider ── (only when My Agents is visible below) */}
            {isOpen && favoriteAgents.length > 0 && (
                <div className="mx-3 my-1.5 border-t border-[var(--border-subtle)]" />
            )}

            {/* ── My Agents ── (only when there are favorites) */}
            {isOpen && favoriteAgents.length > 0 && (
                <MyAgentsSection
                    t={t}
                    favoriteAgents={favoriteAgents}
                    agentsOpen={agentsOpen}
                    toggleAgents={toggleAgents}
                    selectedAgent={selectedAgent}
                    onSelectAgent={onSelectAgent}
                    onToggleFavorite={onToggleFavorite}
                />
            )}


            {/* ── Recent Chats ── */}
            <div className={`flex flex-col ${isOpen ? '' : 'hidden'}`}>
                <div className="flex items-center justify-between px-3 h-9 select-none">
                    <span className={SECTION_LBL}>{t('sidebar.chats')}</span>
                    {allConvs.length > 0 && (
                        <span className="text-[10px] text-[var(--text-tertiary)] font-medium tabular-nums">{allConvs.length}</span>
                    )}
                </div>

                <div className="px-1.5 pb-1">
                    {isOpen ? (allConvs.length === 0 ? (
                        <p className="px-3 py-2 text-[12px] text-[var(--text-tertiary)]">
                            {selectedAgent || directChatMode ? t('sidebar.no_chats_yet') : t('sidebar.select_agent_to_begin')}
                        </p>
                    ) : (
                        groupedConvs.map(group => (
                            <div key={group.label} className="mt-3 first:mt-0">
                                <h3 className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest ${group.isPinned ? 'text-[var(--accent-primary)]' : 'text-gray-500'}`}>
                                    {group.isPinned && <Pin className="w-2.5 h-2.5 inline mr-1 -mt-0.5 -rotate-45" />}
                                    {group.label}
                                </h3>
                                <div className="space-y-px">
                                    {group.items.map(c => <ConvRow key={c.id} conv={c} t={t} active={convIsActive(c)} selectConv={selectConv} deleteConv={deleteConv} conversationLabels={conversationLabels} projects={projects} activeProjectId={activeProject?.id} onRenameConversation={onRenameConversation} onPinConversation={onPinConversation} onLabelConversation={onLabelConversation} onDeleteLabel={onDeleteLabel} onEditLabel={onEditLabel} onCreateLabel={onCreateLabel} onMoveToProject={onMoveToProject} onShareToProject={onShareToProject} agentBadge={isAllChats ? (c._source === 'direct' ? { icon: '💬', name: 'Direct Chat' } : (() => { const a = agents.find(x => x.id === c.agent_id); if (!a) return { icon: DEFAULT_AGENT_EMOJI, name: c.agent_name || 'Agent' }; return isImageAvatar(a.avatar) ? { avatarUrl: resolveAvatarSrc(a.avatar), name: a.name } : { icon: a.avatar || DEFAULT_AGENT_EMOJI, name: a.name }; })()) : null} />)}
                                </div>
                            </div>
                        ))
                    )) : null}
                </div>
            </div>

            </div>{/* ── End scrollable middle region ── */}

            {/* ── Account footer ── */}
            <SidebarFooter
                isOpen={isOpen}
                isMobile={isMobile}
                user={user}
                t={t}
                profileRef={profileRef}
                showProfileMenu={showProfileMenu}
                setShowProfileMenu={setShowProfileMenu}
                _simpleMode={_simpleMode}
                currentPage={currentPage}
                showSettings={showSettings}
                onNavigate={onNavigate}
                onLogout={onLogout}
            />

            <style>{`
                @keyframes sidebarMenuIn {
                    from { opacity: 0; transform: translateY(4px); }
                    to   { opacity: 1; transform: translateY(0); }
                }
            `}</style>
        </div>
    );

    if (isMobile && isOpen) {
        return (
            <div className="fixed inset-0 z-50 flex">
                <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => onClose?.()} />
                <div className="relative sidebar-slide-in" style={{ zIndex: 1 }}>{content}</div>
            </div>
        );
    }
    return content;
};

export default Sidebar;
