import { Plus, Clock } from 'lucide-react';
import React, { useState } from 'react';
import AutomationsOverview from './AutomationsOverview';
import FindRepeatingWorkTab from './FindRepeatingWorkTab';
import TemplatesTab from './TemplatesTab';
import scopedStorage from '../../../../utils/scopedStorage';
import EmptyState from '../../../shared/EmptyState';
import ExecutionsPanel from '../Executions/ExecutionsPanel';

/**
 * Right-pane start screen shown when no routine is selected.
 *
 * For the `automation` segment it's a tabbed launcher: the library overview
 * first (All automations: list · cards · board), then the ways to make a new
 * one (Find repeating work · Templates) and Runs. There is no "Build with AI"
 * tab any more (owner, 2026-09-28): the + opens a new automation, and its
 * builder has the assistant built in. Nor a Steps tab (same day): building
 * blocks sit in the automations list itself, and the chevron beside every +
 * makes a new one. The
 * launcher panels stay mounted and are shown/hidden with a `hidden` class so
 * each tab keeps its own state across switches (e.g. a completed scan), and
 * network behaviour matches the old single-scroll page (no extra fetches).
 * The chosen tab persists per-user via scopedStorage.
 *
 * The default tab is the overview (it has its own empty state with a create
 * button). A saved choice wins; a saved choice for a tab that no longer exists
 * (the retired 'build' and 'steps') falls back to the overview.
 *
 * The `prompt_task` segment keeps its original simple CTA layout.
 */
const TABS = [
    { id: 'overview', label: 'All automations' },
    { id: 'repeating', label: 'Find repeating work' },
    { id: 'templates', label: 'Templates' },
    { id: 'history', label: 'Runs' },
];
const TAB_KEY = 'routinesStartTab';

export default function RoutinesLauncher({
    segment, onCreateAutomation, onCreateTask, onOpenAutomation, onPickTemplate, onBuildSuggestion, onAskSuggestion,
    // A new building block, offered beside "New automation" in the overview.
    onCreateStep = null, onEditingChange = null,
    // "New folder" — the third entry in the overview's New menu (BFSF-478).
    onCreateFolder = null,
    // The overview tab: the sidebar's (filtered) automations, the filter that
    // produced them, folders for the board's folder lanes, the live-run poll,
    // and the per-row callback builder the sidebar rows use.
    automations = [], automationsQuery = '', automationsLoading = false, folders = [], activeRunIds = null,
    automationRowProps = null, canCreateAutomation = true,
}) {
    // `chosen` = a tab picked on purpose, by this user now or in an earlier
    // session; null until then, which means the overview.
    const [chosen, setChosen] = useState(() => {
        const v = scopedStorage.getItem(TAB_KEY);
        return TABS.some(t => t.id === v) ? v : null;
    });
    const activeTab = chosen ?? 'overview';
    const selectTab = (id) => {
        setChosen(id);
        try { scopedStorage.setItem(TAB_KEY, id); } catch (_) { /* storage best-effort */ }
    };

    if (segment === 'prompt_task') {
        return (
            <EmptyState
                icon={(
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center bg-[var(--bg-secondary)]">
                        <Clock size={28} className="text-[var(--text-primary)] opacity-60" />
                    </div>
                )}
                title="Pick an agent routine"
                description="Schedules that run through one of your agents. New ones are set up from the agent that owns them; plain scheduled work lives under Cowork."
                action={{ label: 'New agent routine', onClick: onCreateTask, icon: <Plus size={15} /> }}
            />
        );
    }

    return (
        // @container/launcher: the launcher panels widen by the launcher's OWN
        // width (the sidebar beside it takes a share of the screen), never by
        // the viewport's.
        <div className="@container/launcher h-full flex flex-col">
            {/* Tab bar, underline style, matching the builder's chrome. The
                data-tour anchor lets the Learning Center spotlight the ways
                into the feature (see onboarding/tourAnchors.js). */}
            <div className="flex-shrink-0 border-b border-[var(--border-default)]">
                <div className="max-w-3xl mx-auto px-6 flex items-center justify-center gap-1" data-tour="automation-start-tabs">
                    {TABS.map(t => (
                        <Tab key={t.id} id={t.id} active={activeTab} onClick={selectTab}>{t.label}</Tab>
                    ))}
                </div>
            </div>

            {/* Panels. The two "launcher" tabs stay mounted (so each keeps its
                own state) in a centered column. Runs now mounts the same way,
                HIDDEN while inactive — its `active` prop stands fetching and
                streaming down entirely, so the background cost is zero and the
                list keeps its filters/scroll across tab switches. */}
            <div className="flex-1 min-h-0 flex flex-col">
                {/* The overview is full-width like Runs, and — unlike the
                    launcher panels — it is only mounted while shown: its state
                    (view, sort, group) lives in scopedStorage, so there is
                    nothing to keep alive, and its rows re-render on every
                    5-second run poll. */}
                {activeTab === 'overview' && (
                    <div className="flex-1 min-h-0">
                        <AutomationsOverview
                            automations={automations}
                            query={automationsQuery}
                            loading={automationsLoading}
                            folders={folders}
                            activeRunIds={activeRunIds}
                            rowProps={automationRowProps}
                            onCreate={onCreateAutomation}
                            onCreateBlock={onCreateStep}
                            onCreateFolder={onCreateFolder}
                            canCreate={canCreateAutomation}
                        />
                    </div>
                )}
                <div className={`flex-1 min-h-0 overflow-y-auto ${activeTab === 'history' || activeTab === 'overview' ? 'hidden' : ''}`}>
                    {/* A readable centred column that grows in two steps, so a
                        wide screen gets more template columns and side-by-side
                        suggestions instead of one narrow strip in the middle. */}
                    <div className="mx-auto px-6 py-8 max-w-3xl @[88rem]/launcher:max-w-5xl @[140rem]/launcher:max-w-7xl">
                        <div className={activeTab === 'repeating' ? '' : 'hidden'}>
                            <FindRepeatingWorkTab onBuildSuggestion={onBuildSuggestion} onAskSuggestion={onAskSuggestion} />
                        </div>
                        <div className={activeTab === 'templates' ? '' : 'hidden'}>
                            <TemplatesTab onPickTemplate={onPickTemplate} />
                        </div>
                    </div>
                </div>
                <div className={`flex-1 min-h-0 ${activeTab === 'history' ? '' : 'hidden'}`}>
                    <ExecutionsPanel
                        scope="global"
                        active={activeTab === 'history'}
                        onOpenEditor={onOpenAutomation}
                        onEditingChange={onEditingChange}
                    />
                </div>
            </div>
        </div>
    );
}

// Underline tab button — copied from the builder header so the start-screen
// tabs read as the same control. Uses the theme accent token, not a
// hardcoded brand hue.
function Tab({ id, active, onClick, children }) {
    const isActive = active === id;
    return (
        <button
            onClick={() => onClick(id)}
            className={`px-3 py-2.5 border-b-2 transition text-sm font-medium ${
                isActive
                    ? 'border-[var(--accent-primary,var(--accent))] text-[var(--text-primary)]'
                    : 'border-transparent text-[var(--text-tertiary)] hover:text-[var(--text-primary)]'
            }`}
        >
            {children}
        </button>
    );
}
