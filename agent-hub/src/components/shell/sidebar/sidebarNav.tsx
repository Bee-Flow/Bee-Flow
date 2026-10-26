/**
 * The sidebar's nav rows as data: the pinned core nav and the secondary nav
 * that scrolls away, each row a descriptor NavRow / FlyoutRow render. Split
 * out of Sidebar.jsx without a change in behaviour.
 */
import { AppWindow, ClipboardList, FileText, Handshake, LayoutGrid, PenLine, Search, ShieldCheck, Store } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { appAccent } from './sidebarTokens';
import { countFor } from '@/hooks/useStudioCounts';
import type { StudioCounts } from '@/hooks/useStudioCounts';
import { recentForms, rememberFormOpened } from '@/utils/formRecents';
import { STUDIO_RECENT_SOURCES } from '@/utils/studioRecentSources';
import { groupStudioApps, studioLockHint } from '../../admin/Studio/studioApps';
import { studioLanding, studioSectionLabel } from '../../admin/Studio/studioNav';
import type { StudioNavUser } from '../../admin/Studio/studioNav';
import type { StudioNavDescriptor } from '../../admin/Studio/studioGates';
import AppIconJs from '../../icons/AppIcon';
import { kindColorVar } from '../../shared/kindColors';

type Translate = (key: string, fallback?: string) => string;
type Navigate = ((path: string) => void) | null | undefined;

const AppIcon = AppIconJs;

/** One row descriptor, as NavRow and FlyoutRow read it. */
export interface NavItem {
    key: string;
    label: string;
    desc?: string | null;
    icon?: ComponentType<{ className?: string; strokeWidth?: number }>;
    iconNode?: ReactNode;
    iconColor?: string;
    onClick?: (() => void) | null;
    active?: boolean;
    badge?: number;
    count?: number;
    locked?: boolean;
    lockHint?: string;
    subKey?: string;
    subSegment?: string;
    subLabel?: string;
    flyout?: { groups?: Array<{ key: string; label: string; children: NavItem[] }>; children?: NavItem[] };
}

type FlyoutGroups = NonNullable<NavItem['flyout']>['groups'];

/** A top-level nav row as NavRow draws it: it always has an icon, and a flyout lists groups or a flat list. */
export interface NavRowItem extends NavItem {
    icon: NonNullable<NavItem['icon']>;
    primary?: boolean;
    kbd?: string;
    flyout?: { groups: NonNullable<FlyoutGroups>; children?: undefined } | { groups?: undefined; children: NavItem[] };
}

/** A Studio section descriptor, as the registry (studioApps.jsx) declares it. */
interface StudioSection {
    id: string;
    gate: StudioNavDescriptor['gate'];
    urlSegment: string;
    Icon?: NavItem['icon'];
    kind?: string;
    runtime?: boolean;
    countKey?: string;
    locked?: string | false | null;
    descKey?: string;
    descFallback?: string;
    category?: string;
}

const go = (onNavigate: Navigate, path: string) => () => onNavigate && onNavigate(path);

export interface CoreNavOptions {
    t: Translate;
    onDirectChat?: (() => void) | null;
    /** New Chat is lit only while no other destination holds the main content (BFSF-172). */
    newChatActive: boolean;
    onNavigate: Navigate;
    currentPage?: string;
    studioSection?: string | null;
    activeCoworkCount: number;
    showApprovals: boolean;
    pendingApprovalCount?: number;
    onOpenSearch?: (() => void) | null;
    isMobile: boolean;
}

/** The pinned rows at the top: New Chat, Cowork, Approvals, Search, Documents. */
export function buildCoreNav(o: CoreNavOptions): NavRowItem[] {
    const { t, onNavigate, currentPage } = o;
    return [
        { key: 'new-chat', label: t('sidebar.new_chat', 'New Chat'), icon: PenLine, onClick: o.onDirectChat, active: o.newChatActive },
        // Cowork sits right under New Chat on purpose: "ask" and "delegate" are
        // the two things people come here to do. Handshake, not Sparkles:
        // Cowork is a colleague taking something off your plate, and Sparkles
        // already means "Skills" one level down in Studio. Phone-friendly.
        { key: 'cowork', label: t('sidebar.cowork', 'Cowork'), icon: Handshake, onClick: go(onNavigate, 'cowork'), active: currentPage === 'cowork', badge: o.activeCoworkCount },
        // Approvals — the ONLY entrance now that the Studio panel no longer
        // lists it, so it is here whenever this person is part of ANY approval
        // rather than only while something is waiting: the decided ones are a
        // record people go looking for. It DOES go away for someone with no
        // approvals at all (see useApprovalsNav). Phone-friendly and NOT
        // behind any builder gate: deciding is a member act, not an admin one.
        ...(o.showApprovals
            ? [{ key: 'approvals', label: t('sidebar.approvals', 'Approvals'), icon: ShieldCheck, onClick: go(onNavigate, 'studio/approvals'), active: currentPage === 'studio' && o.studioSection === 'approvals', badge: o.pendingApprovalCount }]
            : []),
        { key: 'search', label: t('sidebar.search'), icon: Search, onClick: o.onOpenSearch, active: false },
        // Personal and shared documents need no Studio builder permissions.
        // The desktop editors keep the existing restriction on phone access.
        ...(!o.isMobile ? [{ key: 'documents', label: t('documents.title', 'Documents'), icon: FileText, onClick: go(onNavigate, 'documents'), active: currentPage === 'documents' }] : []),
    ];
}

interface StudioRowContext {
    t: Translate;
    locale: string;
    studioCounts: StudioCounts | null | undefined;
    onNavigate: Navigate;
    currentPage?: string;
    studioSection?: string | null;
}

/**
 * One Studio section → one flyout row. The NAME comes from
 * studioNav.studioSectionLabel, shared with the rail; the one-line
 * description from the registry's descKey (runtime modules have none).
 */
function studioFlyoutRow(app: StudioSection, c: StudioRowContext): NavItem {
    const label = studioSectionLabel(app, c.t, c.locale) as string;
    return {
        key: `studio-${app.id}`,
        label,
        desc: app.descKey ? c.t(app.descKey, app.descFallback) : null,
        icon: app.Icon,
        // The glyph wears its kind's colour (Studio Nav artboard); a runtime
        // module has no kind and gets the neutral secondary ink.
        iconColor: app.kind ? kindColorVar(app.kind) : (app.runtime ? 'var(--text-secondary)' : undefined),
        // Absent until the counts poll answers, and for any key the server
        // left out. A runtime module never falls back to its id: one whose id
        // happens to equal a first-party key ('agents', …) would otherwise
        // wear that number.
        count: app.runtime ? countFor(c.studioCounts, app.countKey) : countFor(c.studioCounts, app.countKey || app.id),
        locked: !!app.locked,
        lockHint: app.locked ? studioLockHint(app.locked, c.t) : undefined,
        onClick: go(c.onNavigate, `studio/${app.urlSegment}`),
        active: c.currentPage === 'studio' && c.studioSection === app.id,
        // Sections with a known list source get the second-level "what was I
        // working on" panel; runtime sections and locked ones stay plain rows.
        subKey: (STUDIO_RECENT_SOURCES as Record<string, unknown>)[app.id] && !app.locked ? app.id : undefined,
        subSegment: app.urlSegment,
        subLabel: label,
    };
}

/**
 * Studio — a flyout, not a screen: its sections (registry-gated) open from
 * the side panel and each deep-links straight into the shell. The row's own
 * onClick (compact strip / mobile fallback) lands on the first visible
 * UNLOCKED section — a locked row is a signpost, not a door. Grouped, not
 * flat: Build · AI · Bundle for the first-party sections, Add-ons for
 * installed modules (declared in the registry, studioApps.jsx).
 */
function studioNavItem(sections: StudioSection[], user: StudioNavUser | null | undefined, c: StudioRowContext): NavRowItem {
    return {
        key: 'studio',
        label: c.t('studio.sidebar_link', 'Studio'),
        icon: LayoutGrid,
        onClick: () => {
            const landing = studioLanding({ user, sections }) as StudioSection | null;
            if (landing && c.onNavigate) c.onNavigate(`studio/${landing.urlSegment}`);
        },
        active: c.currentPage === 'studio',
        flyout: {
            groups: groupStudioApps(sections).map(({ category, apps }) => ({
                key: category.id,
                label: c.t(category.labelKey, category.labelFallback),
                children: apps.map(app => studioFlyoutRow(app, c)),
            })),
        },
    };
}

export interface PublishedApp { id: string; name?: string; description?: string | null; icon?: string; accentColor?: string }
export interface PublishedForm { id: string; title?: string; description?: string | null; live?: boolean }

const pathIs = (test: (path: string) => boolean) => typeof window !== 'undefined' && test(window.location.pathname);

/**
 * Apps — the published-apps directory PLUS every published app the user can
 * open, as its own flyout row. On phones the row navigates to the directory.
 */
function appsNavItem(publishedApps: PublishedApp[], t: Translate, onNavigate: Navigate, currentPage?: string): NavRowItem {
    return {
        key: 'apps',
        label: t('sidebar.apps', 'Apps'),
        icon: AppWindow,
        onClick: go(onNavigate, 'apps'),
        active: currentPage === 'apps' || currentPage === 'appRun',
        flyout: {
            children: [
                {
                    key: 'apps-all',
                    label: t('sidebar.all_apps', 'All apps'),
                    desc: t('sidebar.all_apps_desc', 'Browse everything published for you'),
                    icon: AppWindow,
                    onClick: go(onNavigate, 'apps'),
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
                    onClick: go(onNavigate, `apps/${app.id}`),
                    active: currentPage === 'appRun' && pathIs(p => p.startsWith(`/app/apps/${app.id}`)),
                })),
            ],
        },
    };
}

/**
 * Forms — every form published in the organisation, built the same way Apps
 * is. At most five rows, because an organisation can publish far more than a
 * menu can hold: the ones THIS user opens, most recent first, then
 * newest-published. Rows open the form in this tab: forms are signed-in only
 * now, so /f/<token> is just a redirect back here.
 */
function formsNavItem(publishedForms: PublishedForm[], t: Translate, onNavigate: Navigate, currentPage?: string): NavRowItem {
    return {
        key: 'forms',
        label: t('sidebar.forms', 'Forms'),
        icon: ClipboardList,
        onClick: go(onNavigate, 'forms'),
        active: currentPage === 'forms' || currentPage === 'formView',
        flyout: {
            children: [
                {
                    key: 'forms-all',
                    label: t('sidebar.all_forms', 'All forms'),
                    desc: t('sidebar.all_forms_desc', 'Every form published in your organisation'),
                    icon: ClipboardList,
                    onClick: go(onNavigate, 'forms'),
                    active: currentPage === 'forms',
                },
                ...(recentForms(publishedForms, 5) as PublishedForm[]).map(form => ({
                    key: `form-${form.id}`,
                    label: form.title || 'Untitled form',
                    // A paused or draft automation answers 404 to its visitors,
                    // so say so rather than let someone hand out a dead link.
                    desc: form.live
                        ? (form.description || null)
                        : t('sidebar.form_not_live', 'Not live — the automation is paused or still a draft'),
                    icon: ClipboardList,
                    onClick: () => {
                        rememberFormOpened(form.id);
                        if (onNavigate) onNavigate(`forms/${form.id}`);
                    },
                    active: currentPage === 'formView' && pathIs(p => p === `/app/forms/${form.id}`),
                })),
            ],
        },
    };
}

export interface SecondaryNavOptions extends StudioRowContext {
    onOpenMarketplace?: (() => void) | null;
    showMarketplace: boolean;
    user: StudioNavUser | null | undefined;
    /** Studio sections this person sees; the row needs both the right and something in it. */
    studioSections: StudioSection[] | null;
    /** app_studio + use_apps, and at least one published app to open. */
    publishedApps: PublishedApp[] | null;
    /** Forms visible, use_forms, a published form, and not a phone. */
    publishedForms: PublishedForm[] | null;
}

/**
 * The rows that scroll away: Agents, Studio, Apps, Forms. A null list means
 * the row is not shown. Meeting Notes lives inside Studio; notebooks are a
 * document type in Studio → Documents — neither has a row of its own.
 */
export function buildSecondaryNav(o: SecondaryNavOptions): NavRowItem[] {
    const { t, onNavigate, currentPage } = o;
    const items: NavRowItem[] = [
        { key: 'agents', label: t('sidebar.agents', 'Agents'), icon: Store, onClick: o.onOpenMarketplace, active: o.showMarketplace },
    ];
    if (o.studioSections) items.push(studioNavItem(o.studioSections, o.user, o));
    if (o.publishedApps) items.push(appsNavItem(o.publishedApps, t, onNavigate, currentPage));
    if (o.publishedForms) items.push(formsNavItem(o.publishedForms, t, onNavigate, currentPage));
    return items;
}
