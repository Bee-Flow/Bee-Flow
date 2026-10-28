import { useMemo, type ComponentType } from 'react';
import { seg } from '@/components/automation/Builder/mapping/upstream/sampleFields';
import { useTranslation } from '@/hooks/useTranslation';
import BindingFieldJs from '@/components/automation/Builder/mapping/BindingField';
import ConditionBuilderJs from '@/components/automation/Builder/mapping/ConditionBuilder';
import { ColumnSelect } from '../TableColumnSelect';
import { RULE_TESTS, isBlankBinding, type Binding, type FilterOp, type Rule } from '../tableOpModel';
import { AddButton, Check, Choice, LinesInput, Radios, Row, TextInput } from './inputs';
import type { OpFormProps } from './opFormTypes';
import OpField from './OpField';

// Untyped JS components; their props are checked there.
const BindingField = BindingFieldJs as unknown as ComponentType<Record<string, unknown>>;
const ConditionBuilder = ConditionBuilderJs as unknown as ComponentType<Record<string, unknown>>;

const NO_VALUE = new Set(['is_empty', 'is_not_empty']);
const LIST_TESTS = new Set(['in', 'not_in']);
const MAX_RULES = 50;

const shapeOf = (test: string) => (NO_VALUE.has(test) ? 'none' : LIST_TESTS.has(test) ? 'list' : test === 'between' ? 'pair' : 'one');
const asText = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(asText) : v === undefined || v === null || v === '' ? [] : [asText(v)]);

interface ValueProps { rule: Rule; index: number; onChange: (patch: Partial<Rule>) => void; ctx: OpFormProps<FilterOp>['ctx'] }

function RuleValue({ rule, index, onChange, ctx }: ValueProps) {
    const { t } = useTranslation();
    const shape = shapeOf(rule.test);
    const name = `rules[${index}].value`;
    if (shape === 'none') return null;
    if (shape === 'list') {
        return (
            <OpField ctx={ctx} name={name} label={t('automation_tables.filter.values', 'Values')} help={ctx.help.filter.list}>
                {id => <LinesInput id={id} value={asList(rule.value)} onChange={value => onChange({ value })} ariaLabel={t('automation_tables.filter.values', 'Values')} />}
            </OpField>
        );
    }
    if (shape === 'pair') {
        const [lo, hi] = [asText(asList(rule.value)[0]), asText(asList(rule.value)[1])];
        return (
            <OpField ctx={ctx} name={name} label={t('automation_tables.filter.range', 'Between')}>
                <div className="grid grid-cols-2 gap-2">
                    <TextInput value={lo} onChange={v => onChange({ value: [v, hi] })} ariaLabel={t('automation_tables.filter.range_low', 'Lowest value')} />
                    <TextInput value={hi} onChange={v => onChange({ value: [lo, v] })} ariaLabel={t('automation_tables.filter.range_high', 'Highest value')} />
                </div>
            </OpField>
        );
    }
    return (
        <>
            <OpField ctx={ctx} name={name} label={t('automation_tables.filter.value', 'Value')} help={ctx.help.filter.value}>
                <BindingField
                    value={rule.value as Binding | undefined}
                    onChange={(value: Binding) => onChange({ value })}
                    label={t('automation_tables.filter.value', 'Value')}
                    placeholder={t('automation_tables.filter.value_placeholder', 'A value, or data from an earlier step')}
                    onFocusField={ctx.onFocusField}
                    previewSample={ctx.previewSample}
                    showExpressionHelp={false}
                />
            </OpField>
            {rule.test === 'contains_item' && (
                <OpField ctx={ctx} name={`rules[${index}].separator`} label={t('automation_tables.filter.separator', 'Items are separated by')} help={ctx.help.filter.separator}>
                    {id => <TextInput id={id} value={rule.separator ?? ';'} onChange={separator => onChange({ separator })} ariaLabel={t('automation_tables.filter.separator', 'Items are separated by')} />}
                </OpField>
            )}
        </>
    );
}

type SetFilter = (patch: Partial<FilterOp>) => void;
type Ctx = OpFormProps<FilterOp>['ctx'];

function RulesFrom({ op, set, ctx }: { op: FilterOp; set: SetFilter; ctx: Ctx }) {
    const { t } = useTranslation();
    const h = ctx.help.filter;
    return (
        <OpField ctx={ctx} name="rulesFrom" help={h.rulesFrom}>
            <Check
                checked={op.rulesFrom !== null} label={t('automation_tables.filter.rules_from', 'Also use rules from the run')}
                onChange={on => set({ rulesFrom: on ? { kind: 'ref', path: '' } : null })}
            />
            {op.rulesFrom !== null && (
                <div className="flex flex-col gap-1.5">
                    <BindingField
                        value={isBlankBinding(op.rulesFrom) ? undefined : op.rulesFrom}
                        onChange={(b: Binding) => set({ rulesFrom: b })}
                        label={t('automation_tables.filter.rules_from_source', 'Where the rules come from')}
                        placeholder={t('automation_tables.filter.rules_from_placeholder', 'Data from an earlier step')}
                        onFocusField={ctx.onFocusField}
                        previewSample={ctx.previewSample}
                        showExpressionHelp={false}
                    />
                    {op.rules.length > 0 && (
                        <Radios
                            ariaLabel={t('automation_tables.filter.rules_from_match', 'How these rules combine')} value={op.rulesFromMatch} onChange={rulesFromMatch => set({ rulesFromMatch })}
                            options={[
                                { value: 'all', label: t('automation_tables.filter.rules_from_all', 'All of them must be true') },
                                { value: 'any', label: t('automation_tables.filter.rules_from_any', 'Any one of them is enough') },
                            ]}
                        />
                    )}
                </div>
            )}
        </OpField>
    );
}

function FormulaBox({ op, set, ctx, fieldOptions }: { op: FilterOp; set: SetFilter; ctx: Ctx; fieldOptions: unknown[] }) {
    const { t } = useTranslation();
    const h = ctx.help.filter;
    return (
        <details className="text-xs" open={!!op.expr}>
            <summary className="cursor-pointer text-[var(--accent)]">{t('automation_tables.filter.expr', 'Advanced: write a formula')}</summary>
            <div className="mt-2">
                <OpField ctx={ctx} name="expr" help={h.expr}>
                    <ConditionBuilder
                        value={op.expr || ''}
                        onChange={(expr: string) => set({ expr: expr || null })}
                        onFocusField={ctx.onFocusField}
                        previewSample={ctx.previewSample}
                        context="filter"
                        fieldOptions={fieldOptions}
                        fieldBase="row"
                        showSerialized={false}
                    />
                </OpField>
            </div>
        </details>
    );
}

export default function FilterForm({ op, onChange, ctx }: OpFormProps<FilterOp>) {
    const { t } = useTranslation();
    const h = ctx.help.filter;
    const set = (patch: Partial<FilterOp>) => onChange({ ...op, ...patch });
    const editRule = (i: number, patch: Partial<Rule>) => set({ rules: op.rules.map((r, j) => (j === i ? { ...r, ...patch } : r)) });
    const changeTest = (i: number, test: string) => {
        const before = op.rules[i];
        const keep = shapeOf(before.test) === shapeOf(test);
        const next: Rule = { column: before.column, test };
        if (keep && before.value !== undefined) next.value = before.value;
        if (before.separator !== undefined) next.separator = before.separator;
        set({ rules: op.rules.map((r, j) => (j === i ? next : r)) });
    };
    const fieldOptions = useMemo(() => (ctx.columns || []).map(c => ({
        path: `row${seg(c.key)}`, label: c.label || c.key, sample: ctx.sampleRow?.[c.key] ?? null, group: t('automation_tables.filter.columns_group', 'Columns'),
    })), [ctx.columns, ctx.sampleRow, t]);
    return (
        <div className="flex flex-col gap-3">
            {op.rules.length > 1 && (
                <OpField ctx={ctx} name="match" label={t('automation_tables.filter.match', 'A row stays when')} help={h.match}>
                    <Radios
                        ariaLabel={t('automation_tables.filter.match', 'A row stays when')} value={op.match} onChange={match => set({ match })}
                        options={[
                            { value: 'all', label: t('automation_tables.filter.match_all', 'All the rules are true') },
                            { value: 'any', label: t('automation_tables.filter.match_any', 'Any one of the rules is true') },
                        ]}
                    />
                </OpField>
            )}
            <OpField ctx={ctx} name="rules" exact label={t('automation_tables.filter.rules', 'Rules')} help={h.rules}>
                <div className="flex flex-col gap-1.5">
                    {op.rules.map((r, i) => (
                        <Row key={i} onRemove={() => set({ rules: op.rules.filter((_, j) => j !== i) })} removeLabel={t('automation_tables.filter.remove_rule', 'Remove this rule')}>
                            <OpField ctx={ctx} name={`rules[${i}].column`} label={t('automation_tables.filter.column', 'Column')}>
                                {id => <ColumnSelect id={id} value={r.column} onChange={column => editRule(i, { column })} columns={ctx.columns} described={ctx.described} ariaLabel={t('automation_tables.filter.column', 'Column')} />}
                            </OpField>
                            <OpField ctx={ctx} name={`rules[${i}].test`} label={t('automation_tables.filter.test', 'Test')}>
                                {id => <Choice id={id} ariaLabel={t('automation_tables.filter.test', 'Test')} value={r.test} onChange={test => changeTest(i, test)} options={RULE_TESTS.map(test => ({ value: test, label: ctx.help.tests[test] }))} />}
                            </OpField>
                            <RuleValue rule={r} index={i} onChange={patch => editRule(i, patch)} ctx={ctx} />
                        </Row>
                    ))}
                    {op.rules.length < MAX_RULES && <AddButton onClick={() => set({ rules: [...op.rules, { column: '', test: 'equals' }] })}>{t('automation_tables.filter.add_rule', 'Add a rule')}</AddButton>}
                </div>
            </OpField>
            <RulesFrom op={op} set={set} ctx={ctx} />
            <FormulaBox op={op} set={set} ctx={ctx} fieldOptions={fieldOptions} />
        </div>
    );
}
