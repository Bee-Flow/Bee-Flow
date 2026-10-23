import { AlertTriangle, ArrowRight, Loader2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import AddEntry from './AddEntry';
import { NO_FILTER, isFiltering, kindsPresent, rowMatches } from './contentFilter';
import ContentToolbar from './ContentToolbar';
import { kindBarClass, kindInkClass } from './kindBar';
import { SECTIONS, itemLabel, mayRemove, type SolutionItem, type SolutionSection } from './solutionSections';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import type { ControlFinding } from './ControlFindingGroup';
import type { GraphNode, GraphData, ContentResources, TargetedFinding, StatusCellProps, DependsOnProps, RowProps, EmptyIntroProps, SolutionContentTableProps } from './SolutionContentTable.types';
export type { ContentResources, TargetedFinding } from './SolutionContentTable.types';

/** The three bands, and which membership sections land in each. */
export const BANDS = [
    { key: 'people', labelKey: 'solutions.band_people', fallback: 'People use', sections: ['apps', 'webpages'] },
    { key: 'work', labelKey: 'solutions.band_work', fallback: 'Work happens', sections: ['automations', 'approvals'] },
    { key: 'knowledge', labelKey: 'solutions.band_knowledge', fallback: 'Knowledge & data', sections: ['datatables', 'agents', 'skills', 'documentTemplates', 'knowledgeBases', 'notebooks'] },
];

/** The graph and the palette spell a knowledge base differently. One map. */
const FINDING_KIND: Record<string, string> = { knowledge_base: 'kb' };
const findingKind = (kind: string) => FINDING_KIND[kind] || kind;

/** A kind with no band still gets a row — in the last one. */
function bandFor(sectionKey: string) {
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
export function worstByEntity(findings: TargetedFinding[] | undefined) {
    const map = new Map<string, TargetedFinding>();
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
function dependenciesByNode(graph: GraphData | null | undefined) {
    const nodes = new Map<string, GraphNode>((graph?.nodes || []).map(n => [n.id, n]));
    const out = new Map<string, GraphNode[]>();
    for (const e of (graph?.edges || [])) {
        if (!e?.from || !e.to) continue;
        const target = nodes.get(e.to);
        if (!target) continue;          // outside the Solution — a finding, not a pill
        if (!out.has(e.from)) out.set(e.from, []);
        const list = out.get(e.from);
        if (!list?.some(d => d.id === target.id)) list?.push(target);
    }
    return out;
}

/** Which automations the graph says have a public form trigger. */
function formTriggeredAutomations(graph: GraphData | null | undefined) {
    const ids = new Set<string>();
    for (const n of (graph?.nodes || [])) {
        if (n?.type === 'form' && typeof n.triggers === 'string') ids.add(n.triggers);
    }
    return ids;
}

/** The facts a listing row carries about itself — nothing derived, nothing guessed. */
function subLines(sectionKey: string, item: SolutionItem, isFormTriggered: boolean, t: TranslateFn) {
    const out: string[] = [];
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

function StatusCell({ finding, t }: StatusCellProps) {
    if (!finding) return null;
    const isError = finding.severity === 'error';
    return (
        <span
            data-testid="solution-row-status"
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap flex-shrink-0 bg-[var(--bg-tertiary)] ${isError ? 'text-[var(--error)]' : 'text-[var(--warning)]'}`}
            title={finding.message}
        >
            <AlertTriangle className="w-3 h-3" aria-hidden="true" />
            {isError
                ? t('solutions.status_blocking', 'Needs fixing')
                : t('solutions.status_advice', 'Worth a look')}
        </span>
    );
}

function DependsOn({ targets, t }: DependsOnProps) {
    if (!targets || targets.length === 0) return null;
    return (
        <span className="flex items-center gap-1 min-w-0 flex-wrap" data-testid="solution-row-depends">
            <ArrowRight className="w-3 h-3 flex-shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
            <span className="sr-only">{t('solutions.depends_on', 'Depends on')}</span>
            {targets.map(target => (
                <span key={target.id}
                      className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] max-w-[10rem] truncate bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    {target.name || t('solutions.depends_unnamed', 'Untitled')}
                </span>
            ))}
        </span>
    );
}

function Row({ section, item, deps, finding, isFormTriggered, removable, onOpen, onRemove, t }: RowProps) {
    const lines = subLines(section.key, item, isFormTriggered, t);
    return (
        <div className={`flex items-start gap-3 pl-3 pr-2 py-2 min-h-[44px] rounded-[var(--radius-md)] group border border-[var(--border-subtle)] border-l-[3px] ${kindBarClass(section.kind)} bg-[var(--bg-card)] hover:bg-[var(--bg-card-hover)] transition-colors motion-reduce:transition-none`}
             data-testid="solution-row">
            <section.icon className={`w-4 h-4 mt-1 flex-shrink-0 ${kindInkClass(section.kind)}`} aria-hidden="true" />
            <span className="flex-1 min-w-0">
                <button
                    type="button"
                    onClick={() => onOpen?.(section.kind, item)}
                    className="block text-left text-sm font-medium truncate w-full py-0.5 rounded text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                >
                    {itemLabel(item)}
                </button>
                {(lines.length > 0 || deps.length > 0) && (
                    <span className="flex items-center gap-2 flex-wrap mt-0.5 text-[11px] text-[var(--text-tertiary)]">
                        {lines.length > 0 && <span className="truncate">{lines.join(' · ')}</span>}
                        <DependsOn targets={deps} t={t} />
                    </span>
                )}
            </span>
            <StatusCell finding={finding} t={t} />
            {removable && (
                <button
                    type="button"
                    onClick={() => onRemove?.(section.kind, item)}
                    className="inline-flex items-center justify-center w-10 h-10 -my-1.5 rounded-[var(--radius-sm)] flex-shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]"
                    title={t('projects.remove_from_project')}
                    aria-label={`${t('projects.remove_from_project')}: ${itemLabel(item)}`}
                >
                    <X className="w-4 h-4" aria-hidden="true" />
                </button>
            )}
        </div>
    );
}

function EmptyIntro({ canEdit, t }: EmptyIntroProps) {
    return (
        <div className="space-y-1" data-testid="solution-empty">
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
                {canEdit
                    ? t('solutions.empty_title', 'Bring the parts together')
                    : t('projects.section_empty', 'Nothing here yet.')}
            </h3>
            <p className="text-sm text-[var(--text-secondary)]">
                {t('solutions.empty_body', 'A Solution bundles the parts that work together, such as automations, apps, pages, tables and agents, so you can check, test and deliver them as one.')}
            </p>
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
    readOnly = false,
}: SolutionContentTableProps) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState(NO_FILTER);
    // A stage's parts are managed: nothing is added, removed or filed from here.
    // The role still says who the reader is, but it can no longer grant edits.
    const canEdit = !readOnly && (role === 'owner' || role === 'editor');

    const deps = useMemo(() => dependenciesByNode(graph), [graph]);
    const forms = useMemo(() => formTriggeredAutomations(graph), [graph]);
    const worst = useMemo(() => worstByEntity(completeness?.findings), [completeness]);

    if (loading && !resources) {
        return (
            <div className="flex items-center justify-center py-16 text-[var(--text-tertiary)]" aria-busy="true">
                <Loader2 className="w-5 h-5 animate-spin motion-reduce:animate-none" aria-label={t('common.loading', 'Loading')} />
            </div>
        );
    }

    const inProject = new Set<string>();
    for (const s of SECTIONS) {
        for (const item of (Array.isArray(resources?.[s.key]) ? resources?.[s.key] as SolutionItem[] : [])) {
            if (item?.id) inProject.add(`${s.kind}:${item.id}`);
        }
    }

    // Every section read and none holding anything. A section that could not be
    // read (null) is NOT empty: that reads as "your work is gone".
    const isEmpty = SECTIONS.every(s => Array.isArray(resources?.[s.key]) && resources?.[s.key]?.length === 0);
    const kinds = kindsPresent(resources);
    const attentionCount = [...worst.keys()].filter(k => inProject.has(k)).length;
    const filtering = isFiltering(filter);
    const toolbar = {
        query: filter.query,
        onQuery: (query: string) => setFilter(f => ({ ...f, query })),
        kinds,
        activeKind: filter.kind,
        onKind: (kind: string | null) => setFilter(f => ({ ...f, kind })),
        attentionCount,
        attention: filter.attention,
        onAttention: (attention: boolean) => setFilter(f => ({ ...f, attention })),
    };
    let shown = 0;

    return (
        <div className="space-y-6">
            {isEmpty && <EmptyIntro canEdit={canEdit} t={t} />}

            {canEdit ? (
                <AddEntry
                    empty={isEmpty}
                    toolbar={toolbar}
                    projectId={projectId}
                    alreadyIn={inProject}
                    currentUserId={currentUserId}
                    onAdded={onAdded}
                />
            ) : (!isEmpty && <ContentToolbar {...toolbar} />)}

            {!isEmpty && BANDS.map(band => {
                const sections = SECTIONS.filter(s => bandFor(s.key) === band.key && (!filter.kind || s.kind === filter.kind));
                const visible = (section: SolutionSection) => (resources?.[section.key] ?? []).filter(item => rowMatches(item, worst.has(`${findingKind(section.kind)}:${item.id}`), filter));
                if (filtering && sections.every(sec => Array.isArray(resources?.[sec.key]) && visible(sec).length === 0)) return null;
                return (
                    <div key={band.key} data-testid={`solution-band-${band.key}`}>
                        <h3 className="text-[11px] font-medium uppercase tracking-wide mb-2 text-[var(--text-tertiary)]">
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
                                             role="alert"
                                             className="flex items-center gap-2 px-3 py-2.5 rounded-[var(--radius-md)] text-xs bg-[var(--bg-secondary)] text-[var(--text-secondary)]">
                                            <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 text-[var(--warning)]" aria-hidden="true" />
                                            {t(section.labelKey)} — {t('projects.section_unavailable', 'Could not load this section. Your items are safe — try again shortly.')}
                                        </div>
                                    );
                                }
                                const rows = visible(section);
                                if (rows.length === 0) return null;
                                shown += rows.length;
                                return (
                                    <div key={section.key} className="space-y-1.5">
                                        {rows.map(item => (
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
                        </div>
                    </div>
                );
            })}

            {!isEmpty && filtering && shown === 0 && (
                <div className="flex flex-col items-start gap-2 px-4 py-6 rounded-[var(--radius-md)] border border-dashed border-[var(--border-default)] text-sm text-[var(--text-secondary)]" data-testid="content-no-matches" role="status">
                    {t('solutions.content_no_matches', 'Nothing in this Solution matches those filters.')}
                    <button type="button" onClick={() => setFilter(NO_FILTER)}
                            className="inline-flex items-center min-h-[44px] sm:min-h-9 px-3 rounded-[var(--radius-sm)] text-[13px] font-medium text-[var(--accent-primary)] hover:bg-[var(--bg-secondary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary)]">
                        {t('solutions.content_clear_filters', 'Clear filters')}
                    </button>
                </div>
            )}
        </div>
    );
}
