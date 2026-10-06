import { useState } from 'react';
import useMediaQuery from '../../../../../pages/meeting-notes/hooks/useMediaQuery';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { humanizeFieldKey } from '../displayHelpers';
import {
    candidatesOf, freshPlan, nounsOf, routeOf, toggleField,
    type Candidate, type FlattenDraft, type FlattenParent,
} from './flattenEditorModel';

/**
 * "Choose fields" (F42): which of each parent's fields every row copies.
 * A ticked key is copied; a key the child already carries is shown checked
 * and greyed ("already on each attachment"); long text starts unticked. The
 * child's own fields are always all kept, so they are one line, not a list.
 * Any tick by hand ends auto-planning for that level; Reset plans afresh.
 */
interface Props {
    draft: FlattenDraft;
    sampleRoot: unknown;
    childKeys: string[];
    onParents: (parents: FlattenParent[]) => void;
}

function CandidateRow({ c, child, onToggle }: { c: Candidate; child: string; onToggle: (on: boolean) => void }) {
    const { t } = useTranslation();
    const note = c.fill
        ? t('flatten_node.fields.already', 'already on each {child}', { child })
        : c.long ? t('flatten_node.editor.reason_long', 'long text') : '';
    return (
        <label className={`flex items-center gap-2 py-0.5 text-xs ${c.fill ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]'}`}>
            <input type="checkbox" checked={c.on} disabled={c.fill} onChange={(e) => onToggle(e.target.checked)} />
            <span>{humanizeFieldKey(c.key)}</span>
            {note && <span className="text-[11px] text-[var(--text-tertiary)]">{note}</span>}
        </label>
    );
}

function LevelGroup({ draft, sampleRoot, childKeys, onParents, level }: Props & { level: number }) {
    const { t } = useTranslation();
    const { child, levelNouns } = nounsOf(draft.arrayRef, draft.parents);
    const candidates = candidatesOf(sampleRoot, draft, level);
    const all = () => {
        let next: FlattenDraft = draft;
        for (const c of candidates) if (!c.on) next = { ...next, parents: toggleField(next, level, c.key, true, childKeys) };
        if (next.parents) onParents(next.parents.map((p, i) => (i === level ? { ...p, auto: false } : p)));
    };
    return (
        <fieldset className="flex flex-col gap-0.5">
            <legend className="mb-1 text-[11px] font-semibold text-[var(--text-secondary)]">
                {t('flatten_node.fields.from_each', 'From each {parent}', { parent: levelNouns[level] })}
            </legend>
            {candidates.map(c => (
                <CandidateRow key={c.key} c={c} child={child} onToggle={(on) => onParents(toggleField(draft, level, c.key, on, childKeys))} />
            ))}
            <button type="button" onClick={all} className="self-start text-[11px] text-[var(--accent)] hover:underline">
                {t('flatten_node.fields.all', 'All')}
            </button>
        </fieldset>
    );
}

export default function FlattenColumnsPanel(props: Props) {
    const { draft, sampleRoot, childKeys, onParents } = props;
    const { t } = useTranslation();
    const small = useMediaQuery('(max-width: 479px)') as boolean;
    const [open, setOpen] = useState(false);
    const route = routeOf(draft.arrayRef);
    if (!route || !draft.parents?.length) return null;
    const { child } = nounsOf(draft.arrayRef, draft.parents);
    const levels = draft.parents.map((_, i) => i).reverse();
    const total = levels.reduce((n, level) => n + candidatesOf(sampleRoot, draft, level).length, 0);
    const on = draft.parents.reduce((n, p) => n + (p.fields || []).length, 0);
    if (small && !open) {
        return (
            <button type="button" onClick={() => setOpen(true)} className="self-start text-xs text-[var(--accent)] hover:underline" data-testid="flatten-fields-summary">
                {t('flatten_node.fields.summary', '{on} of {total} fields', { on, total })}
            </button>
        );
    }
    return (
        <div className="flex flex-col gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-3" data-testid="flatten-columns-panel">
            {levels.map(level => <LevelGroup key={level} {...props} level={level} />)}
            <div className="flex flex-col gap-0.5">
                <span className="text-[11px] font-semibold text-[var(--text-secondary)]">
                    {t('flatten_node.fields.from_each', 'From each {parent}', { parent: child })}
                </span>
                <span className="text-xs text-[var(--text-primary)]">
                    {t('flatten_node.fields.all_child', 'All {n} fields', { n: childKeys.length })}
                </span>
            </div>
            <button type="button" onClick={() => onParents(freshPlan(sampleRoot, route))} className="self-start text-[11px] text-[var(--accent)] hover:underline">
                {t('flatten_node.fields.reset', 'Reset')}
            </button>
        </div>
    );
}
