import { useQuery } from '@tanstack/react-query';
import { ExternalLink, Plus, Repeat, Workflow } from 'lucide-react';
import React from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import { API_BASE, authFetch } from '../../../../../utils/helpers';
import { cardRadius, kindColorVar, kindTileStyle } from '../../../../shared/kindColors';
import { appRefParam, buildStudioSearch, segmentForSection } from '../../studioRoutes';

/**
 * "Which routine" — the run_automation target, as a tile instead of a button.
 *
 * The old affordance was one wide button showing the routine's title. It said
 * nothing about what the routine IS, so choosing between two similarly named
 * ones meant leaving the app editor entirely. The tile answers the three
 * questions an author actually has — how big is it, is it running, where does
 * it live — and then gets out of the way.
 *
 * ── Nothing here is allowed to guess ───────────────────────────────────────
 * Every fact degrades ON ITS OWN and degrades to NOTHING:
 *
 *   • steps  — counted from the definition the list endpoint already returned.
 *              A row without a definition shows no step count, never "0 steps":
 *              zero is a claim, and an unloaded definition is not a claim.
 *   • runs   — the facets endpoint counts a ROLLING WINDOW (default 24h) for
 *              the SIGNED-IN user. So the label says "in the last 24 hours",
 *              not "today" — a calendar day is a different number, and a label
 *              that says one while counting the other is a lie the screen
 *              cannot back up. A failed or absent count shows nothing at all.
 *   • filed in — the routine row carries a projectId, not a project NAME, so
 *              the name needs a second request. If that request fails the line
 *              is simply absent; an id would be worse than silence.
 *
 * The shape is the object-kind language from shared/kindColors: an automation
 * tile has the half-round leading edge, here and on the canvas both.
 */

/**
 * Steps in a routine definition, or NULL when the definition is not there.
 *
 * An automation definition is `{ trigger, steps, edges, layers }`: the trigger
 * is not a step (it is the reason the steps run) and needs no filtering out.
 * Counted at the TOP LEVEL, which is what the builder canvas shows — steps
 * nested inside a loop body are part of one step from out here.
 *
 * `null` and `0` are different answers and must stay different: null is "the
 * row did not arrive with a definition", 0 is "this routine has no steps". A
 * tile that renders "0 steps" for a definition it never loaded is a claim the
 * screen cannot back up.
 */
export function stepCountOf(row) {
    const steps = row?.definition?.steps;
    return Array.isArray(steps) ? steps.length : null;
}

/** Run count for one routine over the window, or null when it is not known. */
function runCountOf(facets, automationId) {
    const byId = facets?.automationId;
    if (!byId || typeof byId !== 'object') return null;
    const n = byId[automationId];
    return Number.isFinite(n) ? n : null;
}

const RANGE_HOURS = 24;

async function fetchFacets(automationId) {
    const res = await authFetch(
        `${API_BASE}/api/automation/_runs/facets?automationId=${encodeURIComponent(automationId)}&range=${RANGE_HOURS}`,
    );
    if (!res.ok) return null;
    try { return (await res.json())?.facets ?? null; } catch { return null; }
}

async function fetchProjects() {
    const res = await authFetch(`${API_BASE}/api/projects`);
    if (!res.ok) return [];
    try {
        const body = await res.json();
        return Array.isArray(body?.projects) ? body.projects : (Array.isArray(body) ? body : []);
    } catch { return []; }
}

/**
 * The deep link to a routine in the Automations builder.
 *
 * Built from the same segment map the router parses (`segmentForSection`), not
 * from a hand-written string: an "Open" that lands on a 404 is worse than no
 * link, and the slug has already been renamed twice ('ai-tasks' → 'routines' →
 * 'automations', both old ones still parsed for back-compat).
 *
 * `appRef` adds `?from=app:<app>:<screen>:<node>` — the trail back to the
 * button being wired, drawn as a breadcrumb above the builder. Omitted when
 * the reference is not whole (appRefParam refuses to mint a partial one), so
 * the link degrades to exactly what it was before rather than to a broken
 * query string.
 *
 * `view`/`runId` open the builder ON something rather than at its front door —
 * a test run, in practice. They go through buildStudioSearch like everything
 * else: a `?view=runs&run=…` typed out by hand here is a link that stops
 * working the day the query vocabulary changes, and the router parses exactly
 * four keys (studioRoutes.parseStudioQuery).
 */
export function automationHref(automationId, appRef = null, { view = null, runId = null } = {}) {
    if (!automationId) return null;
    const search = buildStudioSearch({ view, runId, from: appRefParam(appRef) });
    return `/app/studio/${segmentForSection('aiTasks')}/${encodeURIComponent(automationId)}${search}`;
}

export default function AutomationTile({
    automationId, row, onChoose, onCreate, disabled = false, appRef = null,
}) {
    const { t } = useTranslation();

    const runsQuery = useQuery({
        queryKey: ['studio-app-automation-runs', automationId],
        queryFn: () => fetchFacets(automationId),
        enabled: !!automationId,
        staleTime: 30_000,
        retry: false,
    });
    const projectsQuery = useQuery({
        queryKey: ['studio-app-projects'],
        queryFn: fetchProjects,
        // Only when there is a project to name. An app whose routine is
        // standalone should not make this request at all.
        enabled: !!row?.projectId,
        staleTime: 60_000,
        retry: false,
    });

    if (!automationId) {
        return (
            <button
                type="button"
                onClick={onChoose}
                disabled={disabled}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md border border-dashed border-[var(--border-default)] bg-[var(--bg-tertiary)] text-sm text-[var(--text-primary)] hover:border-[var(--accent-primary)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
                <Workflow className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                <span className="truncate">{t('app_studio.inspector.choose_routine', 'Choose a routine…')}</span>
            </button>
        );
    }

    const steps = stepCountOf(row);
    const runs = runCountOf(runsQuery.data, automationId);
    const project = row?.projectId
        ? (projectsQuery.data || []).find((p) => p?.id === row.projectId)
        : null;
    const projectName = typeof project?.name === 'string' && project.name.trim() ? project.name.trim() : null;

    // Each fact is dropped, not defaulted. An empty facts line renders as
    // nothing rather than as a row of dashes pretending to be data.
    const facts = [
        steps === null ? null : t('app_studio.inspector.tile_steps', '{n} steps', { n: steps }),
        runs === null ? null : t('app_studio.inspector.tile_runs_24h', '{n} runs in the last 24 hours', { n: runs }),
        projectName === null ? null : t('app_studio.inspector.tile_in_solution', 'in {name}', { name: projectName }),
    ].filter(Boolean);

    const tile = kindTileStyle('automation', 28);

    return (
        <div
            className="flex flex-col gap-2 p-2.5 border"
            style={{
                borderRadius: cardRadius('automation'),
                borderColor: 'var(--border-subtle)',
                background: 'var(--bg-card)',
            }}
        >
            <div className="flex items-start gap-2 min-w-0">
                <span style={tile.tile} aria-hidden="true">
                    <Workflow style={tile.glyph} />
                </span>
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">
                        {row?.title || t('app_studio.inspector.tile_unnamed', 'This routine')}
                    </p>
                    {facts.length ? (
                        <p className="text-[11px] text-[var(--text-secondary)] truncate">
                            {facts.join(' · ')}
                        </p>
                    ) : null}
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
                <a
                    href={automationHref(automationId, appRef)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:ring-2"
                    style={{ outlineColor: kindColorVar('automation') }}
                >
                    {t('app_studio.inspector.tile_open', 'Open')}
                    <ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
                <button
                    type="button"
                    onClick={onChoose}
                    disabled={disabled}
                    className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2"
                >
                    <Repeat className="w-3 h-3" aria-hidden="true" />
                    {t('app_studio.inspector.tile_choose_other', 'Pick a different one')}
                </button>
                {onCreate ? (
                    <button
                        type="button"
                        onClick={onCreate}
                        disabled={disabled}
                        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2"
                    >
                        <Plus className="w-3 h-3" aria-hidden="true" />
                        {t('app_studio.inspector.tile_new_routine', 'New one from this button')}
                    </button>
                ) : null}
            </div>
        </div>
    );
}
