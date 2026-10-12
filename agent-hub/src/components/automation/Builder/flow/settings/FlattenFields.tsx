import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { listPathLabel } from '../../mapping/listPathLabel';
import PathFieldJs from '../../mapping/PathField';
import { collectArrayPaths as collectArrayPathsJs } from '../../mapping/upstream';
import { useVariablePickerContext } from '../../mapping/VariablePickerContext';
import SmartTable from '../../output/SmartTable';
import { flattenPromotedKeys } from '../../output/columns';
import useOutputColumns from '../../output/useOutputColumns';
import WideOutputView from '../../output/WideOutputView';
import AccordionSection from '../AccordionSection';
import { humanizeFieldKey } from '../displayHelpers';
import FlattenColumnsPanel from './FlattenColumnsPanel';
import {
    childKeysOf, clashNotes, columnsSentence, depthOf, joinWords, leftOutParts, levelOptions, nounsOf,
    outerListOf, refreshPlan, routeOf, routePatch, sampleRows, sourcePatch, sourceResolves,
    type FlattenDraft, type FlattenParent, type Translate,
} from './flattenEditorModel';
import { FormRow as FormRowJs, inputClass as inputClassJs } from './formPrimitives';
import LevelChooser from './LevelChooser';

/**
 * "Flatten a list" (F35-F44). Simple says what the table will be, in
 * sentences: which list, one row per what, which parent fields each row
 * copies, and what the run will leave out. Advanced holds the full route,
 * the input cap and what happens to a parent with an empty list.
 */
type Draft = FlattenDraft & { maxItems?: number | '' };
interface Props {
    draft: Draft;
    set: (key: string, value: unknown) => void;
    groups?: unknown[];
    onFocusField?: unknown;
    previewSample?: unknown;
    sampleFromRun?: boolean;
    errorSections?: Set<string>;
}

// Untyped JS component; its props are checked there.
const PathField = PathFieldJs as unknown as ComponentType<Record<string, unknown>>;
const FormRow = FormRowJs as unknown as ComponentType<Record<string, unknown>>;
const inputClass = inputClassJs as () => string;
const collectArrayPaths = collectArrayPathsJs as (groups: unknown, sample?: unknown) => string[];

const MUTED = 'text-[11px] text-[var(--text-tertiary)]';
const AMBER = 'text-[11px] text-amber-600 dark:text-amber-400';
const LINK = 'ml-1 text-[11px] text-[var(--accent)] hover:underline';

function applyPatch(set: Props['set'], patch: Partial<FlattenDraft>) {
    for (const [k, v] of Object.entries(patch)) set(k, v);
}

function SourceRow({ source, onPick, groups, previewSample, onFocusField }: {
    source: string; onPick: (v: string) => void; groups?: unknown[]; previewSample?: unknown; onFocusField?: unknown;
}) {
    const { t } = useTranslation();
    const { stepLabelById } = useVariablePickerContext() as { stepLabelById?: Map<string, string> };
    const [open, setOpen] = useState(false);
    const quickPicks = useMemo(() => collectArrayPaths(groups, previewSample), [groups, previewSample]);
    const name = source ? listPathLabel(source, stepLabelById, t as Translate, { compact: true }) : '';
    return (
        <div className="flex flex-col gap-1 text-xs">
            <div className="flex items-center gap-2">
                <span className="text-[var(--text-secondary)]">{t('flatten_node.editor.working_through', 'Working through')}</span>
                {name
                    ? <span className="truncate text-[var(--text-primary)]">{name}</span>
                    : <span className={AMBER}>{t('flatten_node.editor.no_list', 'Pick the list to flatten.')}</span>}
                <button type="button" onClick={() => setOpen(o => !o)} className="ml-auto shrink-0 text-[11px] text-[var(--accent)] hover:underline">
                    {open ? t('flatten_node.editor.choose_list', 'Choose a list') : t('flatten_node.editor.change', 'Change')}
                </button>
            </div>
            {open && (
                <PathField
                    value={source}
                    onChange={(v: string) => onPick(v)}
                    expectArray
                    quickPicks={quickPicks}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    label={t('flatten_node.editor.choose_list', 'Choose a list')}
                />
            )}
        </div>
    );
}

function LevelLine({ draft, root, sampleFromRun, onRoute }: { draft: Draft; root: unknown; sampleFromRun: boolean; onRoute: (p: string) => void }) {
    const { t } = useTranslation();
    const source = outerListOf(draft.arrayRef);
    if (!source) return null;
    const nouns = nounsOf(draft.arrayRef, draft.parents);
    const route = routeOf(draft.arrayRef);
    const options = levelOptions(source, root);
    const one = (child: string) => t('flatten_node.editor.one_level', 'One row per {child}', { child });
    if (route && (depthOf(route) > 1 || !options.some(o => o.path === route))) {
        return <div className="text-sm font-semibold text-[var(--text-primary)]">{one(nouns.child)}</div>;
    }
    if (!options.length) {
        const parents = humanizeFieldKey(source.split('.').pop() || '').toLowerCase();
        return sourceResolves(source, root)
            ? <div className={AMBER}>{t('flatten_node.editor.no_inner', 'The {parents} in this list hold no list of their own, so there is nothing to flatten. Pick a list whose items each contain a list, such as emails with attachments.', { parents })}</div>
            : <div className={MUTED}>{t('flatten_node.editor.no_sample', 'Run the step before this one to see which lists it holds.')}</div>;
    }
    if (!route) {
        return (
            <div className="flex flex-wrap gap-2">
                {options.map(o => (
                    <button key={o.path} type="button" onClick={() => onRoute(o.path)} className="text-xs text-[var(--accent)] hover:underline">
                        {one(nounsOf(o.path, null).child)}
                    </button>
                ))}
            </div>
        );
    }
    const levels = options.map(o => {
        const n = nounsOf(o.path, null);
        const countLabel = sampleFromRun
            ? t('flatten_node.editor.count_run', '{count} {children} in {outerCount} {parents} (last run)', { count: o.count, children: n.children, outerCount: o.outerCount, parents: n.parents })
            : t('flatten_node.editor.count_shape', 'Each {parent} holds a list of {children}.', { parent: n.levelNouns[0], children: n.children });
        return { path: o.path, label: humanizeFieldKey(n.child), countLabel };
    });
    return (
        <LevelChooser
            levels={levels}
            value={route || ''}
            onChange={onRoute}
            label={t('flatten_node.editor.row_per', 'One row per')}
            sentence={() => one(nouns.child || levels[0].label.toLowerCase())}
        />
    );
}

function EmptyLine({ draft, emptyCount, inputCount, set }: { draft: Draft; emptyCount: number; inputCount: number; set: Props['set'] }) {
    const { t } = useTranslation();
    if (!emptyCount) return null;
    const { child, children, parents } = nounsOf(draft.arrayRef, draft.parents);
    if (draft.keepEmpty) {
        const note = t('flatten_node.editor.kept_note', '{parents} without {children} get one row without {child} details.', { parents: humanizeFieldKey(parents), children, child });
        return <div className={MUTED}>{note}<button type="button" className={LINK} onClick={() => set('keepEmpty', false)}>{t('flatten_node.editor.undo', 'Undo')}</button></div>;
    }
    const vars = { emptyCount, outerCount: inputCount, parents, children };
    const warn = emptyCount === 1
        ? t('flatten_node.editor.empty_warn', '{emptyCount} of the {outerCount} {parents} has no {children}, so it makes no row.', vars)
        : t('flatten_node.editor.empty_warn_plural', '{emptyCount} of the {outerCount} {parents} have no {children}, so they make no rows.', vars);
    return <div className={AMBER} data-testid="flatten-empty-warn">{warn}<button type="button" className={LINK} onClick={() => set('keepEmpty', true)}>{t('flatten_node.editor.keep_anyway', 'Keep it anyway')}</button></div>;
}

const PREVIEW_ROWS = 3;

/** F41: folded; open, the first three rows as the output table will show them, and Open for all of them. */
function Preview({ rows, count, draft }: { rows: unknown[]; count: number; draft: Draft }) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const [wide, setWide] = useState<number | null | false>(false);
    const promote = useMemo(() => flattenPromotedKeys({ type: 'flatten', ...draft }), [draft]);
    const cols = useOutputColumns(open ? rows : [], null, undefined, promote);
    const first = useMemo(() => rows.slice(0, PREVIEW_ROWS), [rows]);
    return (
        <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
                <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                    {open ? '▾' : '▸'} {count === 1 ? t('flatten_node.editor.preview', 'Preview: {count} row', { count }) : t('flatten_node.editor.preview_plural', 'Preview: {count} rows', { count })}
                </button>
                {open && <button type="button" onClick={() => setWide(null)} className="hidden text-[11px] text-[var(--accent)] hover:underline min-[480px]:inline">{t('flatten_node.editor.open', 'Open')}</button>}
            </div>
            {open && <div className="hidden min-[480px]:block"><SmartTable rows={first} cols={cols} onExpand={(row?: number) => setWide(row ?? null)} /></div>}
            {wide !== false && <WideOutputView rows={rows} cols={cols} initialRow={wide} stepLabel={draft.label || null} onClose={() => setWide(false)} />}
        </div>
    );
}

/**
 * The route itself, any depth (F44). Its own PathField rather than the list
 * steps' shared field: a `[*]` route is what a flatten is FOR, so the
 * "merges every row's values into one list" warning would be wrong here.
 */
function RouteFields({ draft, set, groups, previewSample, onFocusField, onRoute }: Props & { onRoute: (p: string) => void }) {
    const { t } = useTranslation();
    const quickPicks = useMemo(() => collectArrayPaths(groups, previewSample), [groups, previewSample]);
    const max = draft.maxItems === '' || draft.maxItems == null ? '' : draft.maxItems;
    return (
        <>
            <FormRow label={t('flatten_node.advanced.source', 'Source list')} required>
                <PathField value={draft.arrayRef || ''} onChange={(v: string) => onRoute(String(v || ''))} quickPicks={quickPicks} onFocusField={onFocusField} previewSample={previewSample} />
            </FormRow>
            <FormRow label={t('flatten_node.advanced.max_items', 'Max input items')} hint={t('flatten_node.advanced.max_help', 'Also the most rows this step may make.')}>
                <input
                    type="number" min={1} max={10000} value={max} placeholder="10000" className={inputClass()}
                    onChange={e => set('maxItems', e.target.value === '' ? '' : Number(e.target.value))}
                />
            </FormRow>
        </>
    );
}

function AdvancedSection(props: Props & { onRoute: (p: string) => void }) {
    const { draft, set, errorSections } = props;
    const { t } = useTranslation();
    const { child, children, parents, levelNouns } = nounsOf(draft.arrayRef, draft.parents);
    return (
        <AccordionSection stepType="flatten" sectionKey="more" title={t('flatten_node.advanced.title', 'More options')} forceOpen={!!errorSections?.has('more')}>
            <RouteFields {...props} />
            <FormRow label={t('flatten_node.advanced.empty_title', '{parents} without {children}', { parents: humanizeFieldKey(parents), children })}>
                <div className="flex flex-col gap-1 text-xs" role="radiogroup">
                    <label className="flex items-center gap-2"><input type="radio" checked={!draft.keepEmpty} onChange={() => set('keepEmpty', false)} />{t('flatten_node.advanced.empty_drop', 'Leave them out')}</label>
                    <label className="flex items-center gap-2"><input type="radio" checked={!!draft.keepEmpty} onChange={() => set('keepEmpty', true)} />{t('flatten_node.advanced.empty_keep', 'Keep each as one row with empty {child} fields', { child })}</label>
                    {draft.keepEmpty && <span className={MUTED}>{t('flatten_node.advanced.empty_keep_help', 'Steps after this one may then get rows without {children}.', { children })}</span>}
                </div>
            </FormRow>
            {(draft.parents || []).map((p, i) => (
                <div key={p.overRef || i} className={MUTED}>
                    {t('flatten_node.advanced.item_name', 'Each {parent} is called {var}', { parent: levelNouns[i], var: p.itemVar })}
                </div>
            ))}
        </AccordionSection>
    );
}

function useRefresh(draft: Draft, root: unknown, set: Props['set']): string[] {
    const [added, setAdded] = useState<string[]>([]);
    const done = useRef(false);
    useEffect(() => {
        if (done.current || !root || !routeOf(draft.arrayRef)) return;
        done.current = true;
        const next = refreshPlan(root, draft);
        if (!next) return;
        set('parents', next.parents);
        setAdded(next.added);
    }, [root, draft, set]);
    return added;
}

function ColumnsBlock({ draft, root, rows, set }: { draft: Draft; root: unknown; rows: Array<Record<string, unknown>>; set: Props['set'] }) {
    const { t } = useTranslation();
    const [choosing, setChoosing] = useState(false);
    if (!routeOf(draft.arrayRef) || !draft.parents) return null;
    const { child } = nounsOf(draft.arrayRef, draft.parents);
    const childKeys = childKeysOf(rows, draft);
    const { long, fills } = leftOutParts(root, draft);
    const muted = [
        long.length ? t('flatten_node.editor.left_out', 'Left out: {fields}.', { fields: joinWords(long.map(k => `${humanizeFieldKey(k)} (${t('flatten_node.editor.reason_long', 'long text')})`), t as Translate) }) : '',
        fills.length ? t('flatten_node.editor.already_on', '{fields} already come with each {child}.', { fields: joinWords(fills.map(humanizeFieldKey), t as Translate), child }) : '',
    ].filter(Boolean).join(' ');
    return (
        <div className="flex flex-col gap-1">
            <div className="text-xs text-[var(--text-primary)]" data-testid="flatten-columns-sentence">{columnsSentence(draft, childKeys.length, t as Translate)}</div>
            {muted && <div className={MUTED}>{muted}</div>}
            <button type="button" aria-expanded={choosing} onClick={() => setChoosing(c => !c)} className="self-start text-[11px] text-[var(--accent)] hover:underline">
                {t('flatten_node.editor.choose_fields', 'Choose fields')}
            </button>
            {choosing && <FlattenColumnsPanel draft={draft} sampleRoot={root} childKeys={childKeys} onParents={(p: FlattenParent[]) => set('parents', p)} />}
        </div>
    );
}

export default function FlattenFields(props: Props) {
    const { draft, set, groups, onFocusField, previewSample = null, sampleFromRun = false, errorSections } = props;
    const { t } = useTranslation();
    const tr = t as Translate;
    const added = useRefresh(draft, previewSample, set);
    const result = useMemo(() => sampleRows(previewSample, draft), [previewSample, draft]);
    const rows = (result?.items || []) as Array<Record<string, unknown>>;
    const onRoute = (path: string) => applyPatch(set, routePatch(draft, path, previewSample, tr));
    const onSource = (source: string) => applyPatch(set, sourcePatch(draft, source, previewSample, tr));
    return (
        <>
            <AccordionSection stepType="flatten" sectionKey="config" title={t('automations.node.flatten.typeLabel', 'Flatten a list')} defaultOpen forceOpen={!!errorSections?.has('config')}>
                <div className="flex flex-col gap-2.5">
                    <SourceRow source={outerListOf(draft.arrayRef)} onPick={onSource} groups={groups} previewSample={previewSample} onFocusField={onFocusField} />
                    <LevelLine draft={draft} root={previewSample} sampleFromRun={sampleFromRun} onRoute={onRoute} />
                    <ColumnsBlock draft={draft} root={previewSample} rows={rows} set={set} />
                    {added.length > 0 && <div className={MUTED}>{t('flatten_node.editor.refreshed', 'Now also copies {fields}.', { fields: joinWords(added.map(humanizeFieldKey), tr) })}</div>}
                    {result && <EmptyLine draft={draft} emptyCount={result.emptyCount} inputCount={result.inputCount} set={set} />}
                    {clashNotes(draft, tr).map(note => <div key={note} className={MUTED}>{note}</div>)}
                    {result && result.count > 0 && <Preview rows={rows} count={result.count} draft={draft} />}
                </div>
            </AccordionSection>
            <AdvancedSection {...props} onRoute={onRoute} />
        </>
    );
}
