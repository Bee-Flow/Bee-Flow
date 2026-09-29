import { AlertTriangle, AppWindow, ArrowRight, Globe, Info, Loader2, ShieldCheck, Workflow } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import { Strip, sectionNames } from './solutionNotices';

/**
 * How the pieces of this Solution are wired to each other.
 *
 * Deliberately a list and not a node diagram. What a builder needs from this
 * view is "what depends on what, and what is broken" — and a hand-laid graph
 * answers that worse than prose does at this size, while costing a layout
 * engine and a lot of ways to look wrong on a narrow screen.
 *
 * PROBLEMS COME FIRST, in words. That is the whole reason the tab exists: a
 * cross-owner edge passes every review and then refuses at the moment a user
 * presses the button, and an external dependency is the difference between a
 * Blueprint that installs working and one that installs inert. Neither is
 * visible anywhere else in the product.
 *
 * ── What this tab may and may not claim ─────────────────────────────────────
 *
 * `GET /:id/graph` draws from six member kinds that load independently, and
 * says which of them it could not read (`unavailable[]`, `complete`). So an
 * empty problems list has TWO causes and only one of them is good news:
 *
 *   complete: true    nothing is wrong — the one state that may be said aloud
 *   complete: false   part of the Solution never loaded; the routine with the
 *                     cross-owner edge may be sitting in the half that failed
 *   neither           an answer from a server that predates the field, or one
 *                     off a cache — unknown, and unknown narrows
 *
 * Reassurance is therefore gated on `complete === true` and nothing else, the
 * same rule the Control tab follows. This tab printing "Everything in this
 * project is connected and owned consistently." over a half-read graph would
 * be the fail-open the server side was fixed to prevent, restated by the
 * client one layer up.
 */

const TYPE_ICON = { app: AppWindow, webpage: Globe, automation: Workflow, approval: ShieldCheck };
const EDGE_VERB = { runs: 'runs', calls: 'calls', asks: 'asks' };

function NodeChip({ node }) {
    const Icon = TYPE_ICON[node?.type] || Workflow;
    return (
        <span className="inline-flex items-center gap-1.5 min-w-0">
            <Icon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
            <span className="truncate">{node?.name || 'Unknown'}</span>
        </span>
    );
}

/** A quiet line under a heading, for a section that has nothing to list. */
function Note({ children }) {
    return (
        <p className="px-3 py-2.5 rounded-lg text-xs"
           style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
            {children}
        </p>
    );
}

function Problems({ problems, whole }) {
    const { t } = useTranslation();
    if (problems.length === 0) {
        // Two different sentences, because they are two different facts. The
        // first is a verdict about the Solution; the second is a verdict about
        // the part of it that could be read, and says so.
        return (
            <Note>
                {whole
                    ? t('projects.flow_all_connected', 'Everything in this project is connected and owned consistently.')
                    : t('projects.flow_no_problems_partial', 'Nothing was wrong in the parts that could be read.')}
            </Note>
        );
    }
    return (
        <ul className="space-y-1.5">
            {problems.map((p, i) => (
                <li key={`${p.code}-${p.from}-${p.targetId || i}`}
                    className="flex items-start gap-2.5 px-3 py-2 rounded-lg"
                    style={{ background: 'var(--bg-secondary)' }}>
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" style={{ color: 'var(--warning)' }} />
                    <span className="text-sm" style={{ color: 'var(--text-primary)' }}>{p.message}</span>
                </li>
            ))}
        </ul>
    );
}

function Wiring({ edges, byId, whole }) {
    const { t } = useTranslation();
    if (edges.length === 0) {
        // Same split as Problems: "nothing calls anything" is a claim about the
        // whole project, and it is not one a half-read graph can make.
        return (
            <Note>
                {whole
                    ? t('projects.flow_nothing_wired', 'Nothing in this project calls anything else yet.')
                    : t('projects.flow_nothing_wired_partial', 'Nothing that could be read calls anything else.')}
            </Note>
        );
    }
    // Grouped by what does the calling, because that is how someone looks for
    // it: "what does this app touch?", not "who touches this routine?".
    const groups = new Map();
    for (const e of edges) {
        if (!groups.has(e.from)) groups.set(e.from, []);
        groups.get(e.from).push(e);
    }
    return (
        <div className="space-y-3">
            {[...groups.entries()].map(([from, outgoing]) => (
                <div key={from}>
                    <div className="text-sm font-medium mb-1.5" style={{ color: 'var(--text-primary)' }}>
                        <NodeChip node={byId.get(from)} />
                    </div>
                    <ul className="space-y-1">
                        {outgoing.map((e, i) => (
                            <li key={`${e.to || 'none'}-${i}`}
                                className="flex items-center gap-2 px-3 py-1.5 ml-5 rounded-lg text-sm"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                                <span className="text-[11px] uppercase tracking-wide flex-shrink-0"
                                      style={{ color: 'var(--text-tertiary)' }}>
                                    {EDGE_VERB[e.kind] || e.kind}
                                </span>
                                <ArrowRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} />
                                {e.to && byId.has(e.to)
                                    ? <NodeChip node={byId.get(e.to)} />
                                    : <span className="truncate" style={{ color: 'var(--text-tertiary)' }}>
                                        {e.targetId || t('projects.flow_nothing_picked', 'nothing picked yet')}
                                      </span>}
                                {e.problem && (
                                    <AlertTriangle className="w-3.5 h-3.5 ml-auto flex-shrink-0"
                                                   style={{ color: 'var(--warning)' }} />
                                )}
                            </li>
                        ))}
                    </ul>
                </div>
            ))}
        </div>
    );
}

export default function ProjectFlowTab({ graph, loading }) {
    const { t } = useTranslation();

    if (loading && !graph) {
        return (
            <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }
    if (!graph) {
        return (
            <p className="px-3 py-2.5 rounded-lg text-xs"
               style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                {t('projects.section_unavailable', 'Could not load this section. Your items are safe — try again shortly.')}
            </p>
        );
    }

    const byId = new Map((graph.nodes || []).map(n => [n.id, n]));
    const problems = graph.problems || [];
    const externals = graph.externals || [];
    // The one place the verdict is computed. `=== true`, never `!== false`:
    // a missing field is not a promise.
    const whole = graph.complete === true;
    const gaps = sectionNames(graph.unavailable, t);

    return (
        <div className="space-y-6">
            {graph.complete === false && (
                <Strip tone="var(--warning)" icon={AlertTriangle} testId="project-flow-incomplete">
                    {t('projects.flow_incomplete',
                        'Part of this project could not be read, so what is drawn here is not the whole picture.')}
                    {gaps.length > 0 && (
                        <span className="block text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>
                            {gaps.join(', ')}
                        </span>
                    )}
                </Strip>
            )}
            {/* Not false and not true: an answer with no verdict in it. Says
                less than the strip above, and still says it out loud. */}
            {graph.complete === undefined && (
                <Strip tone="var(--text-tertiary)" icon={Info} testId="project-flow-unverified">
                    {t('projects.flow_completeness_unknown',
                        'This view could not confirm it read the whole project, so treat it as partial.')}
                </Strip>
            )}

            <div>
                <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    {t('projects.flow_health', 'Health')}
                </h3>
                <Problems problems={problems} whole={whole} />
            </div>

            <div>
                <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                    {t('projects.flow_wiring', 'How it fits together')}
                </h3>
                <Wiring edges={graph.edges || []} byId={byId} whole={whole} />
            </div>

            {externals.length > 0 && (
                <div>
                    <h3 className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>
                        {t('projects.flow_externals', 'Depends on things outside this project')}
                    </h3>
                    <ul className="space-y-1">
                        {externals.map(ext => (
                            <li key={ext.id} className="px-3 py-2 rounded-lg text-sm"
                                style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)' }}>
                                <span className="font-mono text-xs">{ext.id}</span>
                                <span className="ml-2 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                    {t('projects.flow_used_by', 'used by')} {ext.referencedBy.length}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            )}
        </div>
    );
}
