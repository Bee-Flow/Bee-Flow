import React from 'react';
import { lazy } from '../utils/lazyWithReload';

// ── Lazy: admin / studio / notebooks / marketplaces ──────────────────
// Each of these is opened from a modal slot or a separate route. Lazy
// loading saves ~1.2 MB off the initial bundle.
export const AgentDesignerPanel = lazy(() => import('../components/agents/AgentDesignerPanel'));
export const AgentMarketplace = lazy(() => import('../components/agents/AgentMarketplace'));
export const MemoryPanel = lazy(() => import('../components/knowledge/memory/MemoryPanel'));
export const AdvancedSettings = lazy(() => import('../pages/AdvancedSettings'));
export const AgentStudio = lazy(() => import('../components/agents/AgentStudio/index'));
export const Studio = lazy(() => import('../components/admin/Studio'));
export const SkillsPanel = lazy(() => import('../components/skills/SkillsPanel'));
export const CoworkPage = lazy(() => import('../components/cowork/CoworkPage'));
// The two published directories. They render in this inline slot rather than
// as standalone routes so the app sidebar stays put — arriving at either used
// to leave the user with no navigation but the Back button.
export const AppsHomePage = lazy(() => import('../pages/apps/AppsHomePage'));
export const FormsHomePage = lazy(() => import('../pages/forms/FormsHomePage'));
export const DocumentsPage = lazy(() => import('../pages/documents/DocumentsPage'));
// One published form, shown inside the workspace at /app/forms/:token. The very
// same component serves it anonymously at /f/:token — being signed in does not
// change what the form is, only that the sidebar is still there around it.
export const PublicFormPage = lazy(() => import('../pages/PublicFormPage'));

// Shared Suspense fallback — keeps lazy slots from flashing layout shifts.
// Each modal slot already renders inside its own animated container so a
// plain spinner is sufficient.
export function LazyFallback() {
    return (
        <div className="flex items-center justify-center w-full h-full">
            <div className="w-6 h-6 rounded-full border-2 border-[var(--border-default)] border-t-[var(--accent-primary)] animate-spin" />
        </div>
    );
}
