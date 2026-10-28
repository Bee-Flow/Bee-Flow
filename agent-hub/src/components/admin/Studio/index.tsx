import { Lock } from 'lucide-react';
import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { STUDIO_APPS } from './studioApps';
import { studioGateContext, studioNavSections, studioSectionAccess, type StudioNavUser } from './studioNav';
import { STUDIO_START } from './studioStart';
import useTranslation from '@/hooks/useTranslation';
import { useRuntimeStudioApps } from '@/moduleRuntime/registry';
import { useEntitlements } from '../../licensing/EntitlementsContext';
import { useLicenseContext } from '../../licensing/LicenseContext';

// Unified Studio: a single shell hosting Agents, Skills, Knowledge Bases, and
// AI Tasks. All sections share a sidebar-list + editor-right split layout.
// Navigation between sections lives in the app sidebar (the Studio group in
// Sidebar.jsx renders the registry, gates included) — the shell itself has no
// tab bar anymore; it only resolves and renders the active section. Per-app
// props still come from the studioApps.jsx registry; each app loads as its
// own lazy chunk.

// Local Suspense fallback (same spinner as AgentHub's LazyFallback). Must stay
// local: without a boundary here, the first visit to a lazy tab would suspend
// the whole hub instead of just the section pane.
function StudioSectionLoading() {
    return (
        <div className="flex items-center justify-center w-full h-full">
            <div className="w-6 h-6 rounded-full border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] animate-spin" />
        </div>
    );
}

// A direct URL to a section this person's role does not open, with nowhere of
// their own to send them instead.
function StudioNoAccess() {
    const { t } = useTranslation();
    return (
        <div className="flex items-center justify-center w-full h-full p-6" data-testid="studio-no-access">
            <div className="max-w-sm text-center rounded-2xl border border-[var(--border-default)] bg-[var(--bg-secondary)] p-8">
                <Lock className="w-6 h-6 mx-auto mb-3 text-[var(--text-tertiary)]" strokeWidth={1.75} aria-hidden="true" />
                <h3 className="text-[15px] font-semibold text-[var(--text-primary)]">
                    {t('studio.no_access.title', 'This part of Studio is not open to you')}
                </h3>
                <p className="mt-1 text-[13px] text-[var(--text-tertiary)]">
                    {t('studio.no_access.desc', 'Your role does not include it. An administrator can change that under Roles.')}
                </p>
            </div>
        </div>
    );
}

interface StudioProps {
    user: StudioNavUser | null;
    section?: string;
    initialPlaybookId?: string | null;
    initialAgentId?: string | null;
    initialSkillId?: string | null;
    initialKbId?: string | null;
    initialKbTab?: string | null;
    initialSourceId?: string | null;
    initialTaskId?: string | null;
    initialStepId?: string | null;
    initialFlowletKey?: string | null;
    initialWebpageId?: string | null;
    initialDocumentId?: string | null;
    initialStudioAppId?: string | null;
    initialMeetingId?: string | null;
    initialApprovalId?: string | null;
    initialSolutionId?: string | null;
    initialDatatableId?: string | null;
    initialDatatableTab?: string | null;
    initialFormId?: string | null;
    initialFormTab?: string | null;
    initialBuilderView?: string | null;
    initialRunId?: string | null;
    initialRunStepId?: string | null;
    initialFrom?: string | null;
    onClose?: () => void;
    onNavigate?: (target: string, options?: { replace?: boolean }) => void;
    onEditingChange?: (editing: boolean) => void;
    hasPermission?: (perm: string) => boolean;
    modelTiers?: {};
}

export default function Studio({
    user,
    section = 'agents',     // 'agents' | 'skills' | 'knowledge' | 'aiTasks' | 'webpages'
    initialAgentId = null,
    initialSkillId = null,
    initialKbId = null,
    initialKbTab = null,
    initialSourceId = null,
    initialTaskId = null,
    initialStepId = null,
    initialFlowletKey = null,
    initialWebpageId = null,
    initialDocumentId = null,
    initialStudioAppId = null,
    initialMeetingId = null,
    initialApprovalId = null,
    initialSolutionId = null,
    initialDatatableId = null,
    initialDatatableTab = null,
    initialFormId = null,
    initialFormTab = null,
    initialPlaybookId = null,
    // Builder query state (?view/run/step) — REQUIRED here: getProps below is
    // called with a fixed object literal, so a prop missing from either the
    // signature or that literal silently never reaches the app.
    initialBuilderView = null,
    initialRunId = null,
    initialRunStepId = null,
    initialFrom = null,
    onClose,
    onNavigate,
    hasPermission = () => true,
    modelTiers = {},
    onEditingChange,
}: StudioProps) {
    // Runtime (remotely-installed) modules contribute extra Studio apps. They
    // merge AFTER the build-time apps; their gating renders in the sidebar
    // (server is authoritative — display-only either way).
    const runtimeApps = useRuntimeStudioApps();
    // Start first: it is the section /app/studio resolves to with no segment
    // (studioRoutes.js), it lives beside the registry rather than in it (see
    // studioStart.js), and listing it ahead of the runtime modules means a
    // remote module declaring id 'start' cannot shadow Studio's front door —
    // the same rule studioRoutes.js applies to the built-in segments.
    const allApps = useMemo(() => [STUDIO_START, ...STUDIO_APPS, ...runtimeApps], [runtimeApps]);
    // Per-app fullscreen-editing flags (Agents + Automations report these).
    // onEditingChange fires with the aggregate (AgentHub uses it to drop its
    // own chrome), computed against the render-scope map — same semantics as
    // the old per-app handlers (only the mounted app ever reports in a tick).
    const [editingById, setEditingById] = useState<Record<string, boolean>>({});
    const editing = Object.values(editingById).some(Boolean);
    // The `setEditing` prop handed to the active app (below) is a fresh arrow
    // function every render (it closes over `activeApp.id`), so any child
    // effect keyed on that prop's identity re-fires every render. Without a
    // no-op guard here, that re-fire calls reportEditing → setEditingById with
    // a new object → Studio re-renders → new setEditing → the child's effect
    // deps change again → infinite render loop (React error #185, seen on
    // /app/studio/automations). Bailing out (returning the SAME object) when the
    // value hasn't actually changed makes React skip the re-render and stops
    // the cascade regardless of how often the child's unstable-prop effect
    // re-invokes us with the same value.
    const reportEditing = useCallback((appId: string, next: boolean) => {
        const nextVal = !!next;
        setEditingById(prev => (prev[appId] === nextVal ? prev : { ...prev, [appId]: nextVal }));
    }, []);
    // Notify the parent only when the AGGREGATE boolean actually flips — not
    // on every render — using a ref for the callback so an unstable
    // `onEditingChange` identity from the parent can't retrigger this either.
    const onEditingChangeRef = useRef(onEditingChange);
    useEffect(() => { onEditingChangeRef.current = onEditingChange; });
    useEffect(() => { onEditingChangeRef.current?.(editing); }, [editing]);

    // Direct-URL guard: the sidebar and the rail only LIST the sections that
    // pass; this keeps a typed or shared address from opening one this
    // person's role does not (studioNav.studioSectionAccess has the rules —
    // a PERMISSION miss is refused, a licence/capability miss still renders
    // and the section or the server's 403 says why). The redirect target is
    // the first section of their own, resolved through the same gates as the
    // sidebar; it waits for the entitlements, because until they answer the
    // licensed sections are hidden and "nowhere to go" would be a guess.
    const { hasFeature: hasLicenseFeature } = useLicenseContext();
    const {
        can, lockReason, loading: entitlementsLoading, error: entitlementsError,
    } = useEntitlements();
    const navSections = studioNavSections([...STUDIO_APPS, ...runtimeApps], studioGateContext({
        user, hasLicenseFeature, hasPermission, can, lockReason, entitlementsLoading, entitlementsError,
    }));
    const access = studioSectionAccess({ section, apps: allApps, user, hasPermission, sections: navSections });
    const redirectTo = !access.allowed && !entitlementsLoading ? access.redirectTo : null;
    useEffect(() => {
        if (redirectTo) onNavigate?.(`studio/${redirectTo}`, { replace: true });
    }, [redirectTo, onNavigate]);

    const activeApp = access.allowed ? (allApps.find((app) => app.id === section) || null) : null;
    const ActiveComponent = activeApp?.Component as React.ComponentType<Record<string, unknown>>;
    // Stable per-app-id identity (only changes when the active tab does) so
    // a child effect keyed on this prop's reference doesn't re-fire every
    // Studio render — belt-and-braces alongside the no-op guard above.
    const setEditing = useCallback((next: boolean) => reportEditing(activeApp?.id as string, next), [activeApp?.id, reportEditing]);

    return (
        <div className="flex flex-col h-full bg-[var(--bg-primary)]">
            {/* Sub-section — no tab chrome; section switching lives in the
                app sidebar's Studio group. */}
            <div className="flex-1 min-h-0">
                {!access.allowed && (
                    (entitlementsLoading || redirectTo) ? <StudioSectionLoading /> : <StudioNoAccess />
                )}
                {activeApp && (
                    <Suspense fallback={<StudioSectionLoading />}>
                        <ActiveComponent
                            {...(activeApp.getProps as NonNullable<typeof activeApp.getProps>)({
                                user,
                                initialAgentId,
                                initialSkillId,
                                initialKbId,
                                initialKbTab,
                                initialSourceId,
                                initialTaskId,
                                initialStepId,
                                initialFlowletKey,
                                initialWebpageId,
                                initialDocumentId,
                                initialStudioAppId,
                                initialMeetingId,
                                initialApprovalId,
                                initialSolutionId,
                                initialDatatableId,
                                initialDatatableTab,
                                initialFormId,
                                initialFormTab,
                                initialPlaybookId,
                                initialBuilderView,
                                initialRunId,
                                initialRunStepId,
                                initialFrom,
                                onClose,
                                onNavigate,
                                hasPermission,
                                modelTiers,
                                setEditing,
                            })}
                        />
                    </Suspense>
                )}
            </div>
        </div>
    );
}
