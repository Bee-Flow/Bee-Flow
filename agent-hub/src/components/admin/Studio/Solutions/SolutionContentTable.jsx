import { AlertTriangle, ArrowRight, Loader2, X } from 'lucide-react';
import React, { useMemo } from 'react';
import SolutionAddResource from './SolutionAddResource';
import { SECTIONS, itemLabel, mayRemove } from './solutionSections';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * What is IN this Solution, grouped by what it is FOR.
 *
 * `SECTIONS` (solutionSections.ts) lists the eight kinds a Solution holds as
 * flat sections, in the order server/projects/membership.js declares them.
 * This view is grouped over that SAME source — `SECTIONS` is imported, never
 * copied — and answers the builder's question: not "what is filed here" but
 * "who touches what".
 *
 * Three bands, and the wording is the point. "People use" is the surface a human
 * clicks; "Work happens" is what runs and who has to agree to it; "Knowledge &
 * data" is what the other two read from. Every kind lands in exactly one band,
 * and a kind that gains a section on the server with no band here renders in
 * "Knowledge & data" rather than disappearing — a missing row is the failure
 * this file must not have.
 *
 * ── Nothing on a row is invented ────────────────────────────────────────────
 *
 * Each cell is drawn only from something the payload actually says:
 *
 *   Depends on   edges the graph drew, resolved to nodes it also drew. An edge
 *                pointing at something outside the Solution is NOT a pill: it
 *                is a finding, and the Control tab is where findings live.
 *   Status       the worst finding the aggregator raised for that entity.
 *                No aggregator answer yet, or one that could not be built, and
 *                the column stays blank — a green tick nobody verified is the
 *                exact claim this product must never make.
 *   Sub-line     only facts the listing carries: whether a routine is live or
 *                still a draft, whether a page is public, and whether a routine
 *                is reachable through a public form (from the graph's form
 *                node, never from `automation_form_pages` — that row's id is
 *                the URL and the only credential guarding it).
 *
 * Two sub-lines the brief asks for are deliberately ABSENT rather than
 * approximated. "3 screens" would need the app DEFINITION, and `/resources`
 * carries meta only. "318 rows" would need a row count the store hands over as
 * `Number(row_count) || 0` — a table the retention sweep has never touched
 * reads as "0 rows", and printing that is a claim about somebody's data being
 * empty when the truth is that nobody counted.
 */

/** The three bands, and which membership sections land in each. */
export const BANDS = [
    { key: 'people', labelKey: 'solutions.band_people', fallback: 'People use', sections: ['apps', 'webpages'] },
    { key: 'work', labelKey: 'solutions.band_work', fallback: 'Work happens', sections: ['automations', 'approvals'] },
    { key: 'knowledge', labelKey: 'solutions.band_knowledge', fallback: 'Knowledge & data', sections: ['datatables', 'agents', 'knowledgeBases', 'notebooks'] },
];

/** The graph and the palette spell a knowledge base differently. One map. */
const FINDING_KIND = { knowledge_base: 'kb' };
const findingKind = (kind) => FINDING_KIND[kind] || kind;

/** A kind with no band still gets a row — in the last one. */
function bandFor(sectionKey) {
    const band = BANDS.find(b => b.sections.includes(sectionKey));
    return band ? band.key : BANDS[BANDS.length - 1].key;
}

/**
 * entity → the worst finding raised about it, or undefined.
 *
 * `undefined` and "no findings" are different and the caller must be able to
 * tell them apart: an aggregator that has not answered gets no status cell,
 * whereas one that answered with nothing gets none either — but for a reason
 * the Control tab states. Neither ever paints an "all good" tick here.
 */
export function worstByEntity(findings) {
    const map = new Map();
    for (const f of (findings || [])) {
        const id = f?.targetRef?.id;
        if (!id) continue;
        const key = `${findingKind(f.targetRef.kind)}:${id}`;
        const seen = map.get(key);
        if (!seen || (seen.severity !== 'error' && f.severity === 'error')) map.set(key, f);
    }
    return map;
}

/** Outgoing edges per node, resolved against nodes the graph actually drew. */
function dependenciesByNode(graph) {
    const nodes = new Map((graph?.nodes || []).map(n => [n.id, n]));
    const out = new Map();
    for (const e of (graph?.edges || [])) {
        if (!e?.from || !e.to) continue;
        const target = nodes.get(e.to);
        if (!target) continue;          // outside the Solution — a finding, not a pill
        if (!out.has(e.from)) out.set(e.from, []);
        const list = out.get(e.from);
        if (!list.some(d => d.id === target.id)) list.push(target);
    }
    return out;
}

/** Which routines the graph says have a public form trigger. */
function formTriggeredRoutines(graph) {
    const ids = new Set();
    for (const n of (graph?.nodes || [])) {
        if (n?.type === 'form' && typeof n.triggers === 'string') ids.add(n.triggers);
    }
    return ids;
}

/** The facts a listing row carries about itself — nothing derived, nothing guessed. */
function subLines(sectionKey, item, isFormTriggered, t) {
    const out = [];
    if (sectionKey === 'automations') {
        if (item.isActive === true) out.push(t('solutions.sub_live', 'live'));
        else if (item.isActive === false) out.push(t('solutions.sub_paused', 'paused'));
        if (item.isDraft === true) out.push(t('solutions.sub_draft', 'draft'));
        if (isFormTriggered) out.push(t('solutions.sub_public_form', 'public form'));
    }
    if (sectionKey === 'webpages' && item.isPublished === true) out.push(t('solutions.sub_public', 'public'));
    if (sectionKey === 'knowledgeBases' && typeof item.description === 'string' && item.description.trim()) {
        out.push(item.description.trim());
    }
    return out;
}

function StatusCell({ finding, t }) {
    if (!finding) return null;
    const isError = finding.severity === 'error';
    return (
        <span
            data-testid="solution-row-status"
            className="inline-flex items-center gap-1 text-[11px] whitespace-nowrap flex-shrink-0"
            style={{ color: isError ? 'var(--error)' : 'var(--warning)' }}
            title={finding.message}
        >
            <AlertTriangle className="w-3 h-3" aria-hidden="true" />
            {isError
                ? t('solutions.status_blocking', 'Needs fixing')
                : t('solutions.status_advice', 'Worth a look')}
        </span>
    );
}

function DependsOn({ targets, t }) {
    if (!targets || targets.length === 0) return null;
    return (
        <span className="flex items-center gap-1 min-w-0 flex-wrap" data-testid="solution-row-depends">
            <ArrowRight className="w-3 h-3 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            <span className="sr-only">{t('solutions.depends_on', 'Depends on')}</span>
            {targets.map(target => (
                <span key={target.id}
                      className="inline-flex items-center px-1.5 py-0.5 rounded text-[11px] max-w-[10rem] truncate"
                      style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                    {target.name || t('solutions.depends_unnamed', 'Untitled')}
                </span>
            ))}
        </span>
    );
}

function Row({ section, item, deps, finding, isFormTriggered, removable, onOpen, onRemove, t }) {
    const lines = subLines(section.key, item, isFormTriggered, t);
    return (
        <div className="flex items-start gap-3 px-3 py-2 rounded-lg group" style={{ background: 'var(--bg-secondary)' }}
             data-testid="solution-row">
            <section.icon className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
            <span className="flex-1 min-w-0">
                <button
                    onClick={() => onOpen?.(section.kind, item)}
                    className="block text-left text-sm truncate w-full"
                    style={{ color: 'var(--text-primary)' }}
                >
                    {itemLabel(item)}
                </button>
                {(lines.length > 0 || deps.length > 0) && (
                    <span className="flex items-center gap-2 flex-wrap mt-0.5 text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                        {lines.length > 0 && <span className="truncate">{lines.join(' · ')}</span>}
                        <DependsOn targets={deps} t={t} />
                    </span>
                )}
            </span>
            <StatusCell finding={finding} t={t} />
            {removable && (
                <button
                    onClick={() => onRemove?.(section.kind, item)}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded transition-opacity flex-shrink-0"
                    style={{ color: 'var(--text-tertiary)' }}
                    title={t('projects.remove_from_project')}
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            )}
        </div>
    );
}

export default function SolutionContentTable({
    projectId,
    resources,
    loading,
    role,
    currentUserId,
    graph,
    completeness,
    onOpen,
    onRemove,
    onAdded,
}) {
    const { t } = useTranslation();
    const canEdit = role === 'owner' || role === 'editor';

    const deps = useMemo(() => dependenciesByNode(graph), [graph]);
    const forms = useMemo(() => formTriggeredRoutines(graph), [graph]);
    const worst = useMemo(() => worstByEntity(completeness?.findings), [completeness]);

    if (loading && !resources) {
        return (
            <div className="flex items-center justify-center py-16" style={{ color: 'var(--text-tertiary)' }}>
                <Loader2 className="w-5 h-5 animate-spin" />
            </div>
        );
    }

    const inProject = new Set();
    for (const s of SECTIONS) {
        for (const item of (Array.isArray(resources?.[s.key]) ? resources[s.key] : [])) {
            if (item?.id) inProject.add(`${s.kind}:${item.id}`);
        }
    }

    return (
        <div className="space-y-6">
            {canEdit && (
                <SolutionAddResource
                    projectId={projectId}
                    alreadyIn={inProject}
                    onAdded={onAdded}
                />
            )}

            {BANDS.map(band => {
                const sections = SECTIONS.filter(s => bandFor(s.key) === band.key);
                return (
                    <div key={band.key} data-testid={`solution-band-${band.key}`}>
                        <h3 className="text-[11px] uppercase tracking-wide mb-2" style={{ color: 'var(--text-tertiary)' }}>
                            {t(band.labelKey, band.fallback)}
                        </h3>
                        <div className="space-y-3">
                            {sections.map(section => {
                                const items = resources?.[section.key];
                                // null ≠ [] — the server says null when a store
                                // could not be reached, and rendering that as
                                // "nothing here" tells someone their work is gone.
                                if (items === null || items === undefined) {
                                    return (
                                        <div key={section.key}
                                             data-testid={`solution-section-unavailable-${section.key}`}
                                             className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs"
                                             style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                                            <AlertTriangle className="w-3.5 h-3.5" />
                                            {t(section.labelKey)} — {t('projects.section_unavailable', 'Could not load this section. Your items are safe — try again shortly.')}
                                        </div>
                                    );
                                }
                                if (items.length === 0) return null;
                                return (
                                    <div key={section.key} className="space-y-1.5">
                                        {items.map(item => (
                                            <Row
                                                key={item.id}
                                                section={section}
                                                item={item}
                                                deps={deps.get(`${section.kind}:${item.id}`) || []}
                                                finding={worst.get(`${findingKind(section.kind)}:${item.id}`)}
                                                isFormTriggered={section.key === 'automations' && forms.has(`automation:${item.id}`)}
                                                removable={mayRemove(section, item, currentUserId, canEdit)}
                                                onOpen={onOpen}
                                                onRemove={onRemove}
                                                t={t}
                                            />
                                        ))}
                                    </div>
                                );
                            })}
                            {sections.every(s => Array.isArray(resources?.[s.key]) && resources[s.key].length === 0) && (
                                <p className="px-3 py-2.5 rounded-lg text-xs"
                                   style={{ background: 'var(--bg-secondary)', color: 'var(--text-tertiary)' }}>
                                    {t('projects.section_empty', 'Nothing here yet.')}
                                </p>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
}
