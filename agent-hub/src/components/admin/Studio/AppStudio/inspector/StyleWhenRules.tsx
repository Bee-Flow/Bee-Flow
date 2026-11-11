import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import useAdjustOnChange from '@/hooks/useAdjustOnChange';
import { SelectField, TextField } from './panels/kit';
import { earnedKnobGroups } from './extensionKnobGroups';
import { COLOR_ROLES, getKnobsForType } from './styleKnobMeta';
import { deepClone, findNode } from '../state/definitionOps';
import type { AppDefinition, AppNode } from './appDefinition';

/**
 * The conditional style of one component (`node.styleWhen`, schema 3): a short list of rules,
 * each a formula and the knobs that apply while it is true. Drawn in the Style section.
 *
 * The editor offers the text colour, the fill and the weight where the component's type has
 * them; any other knob a rule carries (set by the builder) is kept as it is. A rule is committed
 * once it has a formula and a knob; the server cleans the rest (canonicalize/styleWhen.mts).
 */

/** Rules per node, as componentSpecs/limits.js MAX_STYLE_WHEN_RULES. */
const MAX_STYLE_WHEN_RULES = 6;

/** The knobs this editor draws, in this order. */
const EDITED_KNOBS = ['color', 'backgroundColor', 'weight'] as const;
const WEIGHTS = ['regular', 'medium', 'semibold', 'bold'];

interface Rule {
    when: { kind: 'formula'; expr: string };
    style: Record<string, unknown>;
}

/** The knobs of EDITED_KNOBS a node of `type` has (its own list and the groups it earns). */
export function editableRuleKnobs(type: string): string[] {
    const own = getKnobsForType(type);
    const all = [...own, ...earnedKnobGroups(own, type).flatMap((g) => g.knobs)];
    return EDITED_KNOBS.filter((k) => all.includes(k));
}

function rulesOf(node: AppNode): Rule[] {
    if (!Array.isArray(node.styleWhen)) return [];
    return node.styleWhen.map((r: unknown) => {
        const rule = (r && typeof r === 'object' ? r : {}) as { when?: { expr?: unknown } | string; style?: Record<string, unknown> };
        const expr = typeof rule.when === 'string' ? rule.when : String(rule.when?.expr ?? '');
        return { when: { kind: 'formula', expr }, style: { ...(rule.style || {}) } };
    });
}

/** The definition with `nodeId`'s styleWhen replaced; an empty list removes the key. */
export function setNodeStyleWhen(definition: AppDefinition, nodeId: string, rules: Rule[]): AppDefinition {
    const next = deepClone(definition);
    const node = findNode(next, nodeId)?.node as AppNode | undefined;
    if (!node) return definition;
    if (rules.length) node.styleWhen = rules;
    else delete node.styleWhen;
    return next;
}

interface Props {
    definition: AppDefinition;
    node: AppNode;
    onCommit: (definition: AppDefinition) => void;
    disabled: boolean;
}

export default function StyleWhenRules({ definition, node, onCommit, disabled }: Props) {
    const { t } = useTranslation();
    const knobs = editableRuleKnobs(node.type);
    const stored = rulesOf(node);
    const [draft, setDraft] = useState<Rule[]>(stored);
    useAdjustOnChange([node.id, JSON.stringify(node.styleWhen ?? null)] as const, () => setDraft(rulesOf(node)));
    if (!knobs.length) return null;

    // Only rules with a formula and a knob reach the definition; one being written stays in the draft.
    const commit = (rules: Rule[]) => {
        setDraft(rules);
        const usable = rules.filter((r) => r.when.expr.trim() && Object.keys(r.style).length);
        if (JSON.stringify(usable) !== JSON.stringify(stored)) onCommit(setNodeStyleWhen(definition, node.id, usable));
    };
    const update = (i: number, rule: Rule) => commit(draft.map((r, j) => (j === i ? rule : r)));
    const setKnob = (i: number, knob: string, value: string) => {
        const style = { ...draft[i].style };
        if (value) style[knob] = value;
        else delete style[knob];
        update(i, { ...draft[i], style });
    };

    const roleOptions = [{ value: '', label: t('studio_apps_lk15.rules.unchanged', 'Unchanged') }, ...COLOR_ROLES.map((r) => ({ value: r, label: r }))];
    const weightOptions = [{ value: '', label: t('studio_apps_lk15.rules.unchanged', 'Unchanged') }, ...WEIGHTS.map((w) => ({ value: w, label: w }))];
    const knobLabels: Record<string, string> = {
        color: t('studio_apps_lk15.rules.color', 'Text colour'),
        backgroundColor: t('studio_apps_lk15.rules.fill', 'Fill colour'),
        weight: t('studio_apps_lk15.rules.weight', 'Weight'),
    };

    return (
        <div className="mt-4 flex flex-col gap-3" data-testid="app-style-when-rules">
            <div className="text-xs font-semibold text-[var(--text-secondary)]">{t('studio_apps_lk15.rules.title', 'Conditional style')}</div>
            {draft.map((rule, i) => (
                <div key={i} className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] p-2" data-testid="app-style-when-rule">
                    <TextField
                        label={t('studio_apps_lk15.rules.when', 'When')}
                        value={rule.when.expr}
                        onChange={(expr) => update(i, { ...rule, when: { kind: 'formula', expr } })}
                        placeholder={t('studio_apps_lk15.rules.when_placeholder', 'vars.total > 100')}
                        disabled={disabled}
                    />
                    {knobs.map((knob) => (
                        <SelectField
                            key={knob}
                            label={knobLabels[knob]}
                            value={typeof rule.style[knob] === 'string' ? String(rule.style[knob]) : ''}
                            onChange={(v) => setKnob(i, knob, v)}
                            options={knob === 'weight' ? weightOptions : roleOptions}
                            disabled={disabled}
                        />
                    ))}
                    <button
                        type="button"
                        className="inline-flex items-center gap-1 self-start text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                        onClick={() => commit(draft.filter((_, j) => j !== i))}
                        disabled={disabled}
                    >
                        <Trash2 className="h-3 w-3" aria-hidden="true" />
                        {t('studio_apps_lk15.rules.remove', 'Remove rule')}
                    </button>
                </div>
            ))}
            {draft.length < MAX_STYLE_WHEN_RULES ? (
                <button
                    type="button"
                    className="inline-flex items-center gap-1 self-start text-xs font-medium text-[var(--app-primary,var(--text-primary))]"
                    onClick={() => setDraft([...draft, { when: { kind: 'formula', expr: '' }, style: {} }])}
                    disabled={disabled}
                >
                    <Plus className="h-3 w-3" aria-hidden="true" />
                    {t('studio_apps_lk15.rules.add', 'Add a rule')}
                </button>
            ) : null}
            <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_lk15.rules.hint', 'Each rule applies while its formula is true; a later rule wins. A formula that fails changes nothing.')}</p>
        </div>
    );
}
