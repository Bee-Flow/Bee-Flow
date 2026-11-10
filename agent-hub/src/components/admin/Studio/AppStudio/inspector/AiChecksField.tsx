import useTranslation from '@/hooks/useTranslation';
import FormField from '@/components/shared/FormField';
import { INPUT_CLS } from './panels/kit';

/**
 * The answer checks of an AI step (`checks` on ai_generate / ai_extract, schema v3): a list of
 * { kind, field, ... } in the automation ai_step's shapes, checked after every answer. A failing
 * answer goes back to the AI with what failed (`repairRounds`), then the step fails.
 *
 * The kinds and scripts mirror core/automationModel/aiStepReliabilitySpec.js (AiChecksField.lockstep.test.ts).
 * An empty list is written as no field at all, so a step without checks stays as it was.
 */

export const AI_CHECK_KINDS = ['allowedFrom', 'numbersFrom', 'script', 'items'] as const;
export const AI_CHECK_SCRIPTS = ['latin', 'cyrillic', 'greek', 'arabic', 'hebrew', 'han', 'japanese', 'hangul', 'devanagari', 'thai'] as const;

type CheckKind = typeof AI_CHECK_KINDS[number];
export type AiCheck = { kind?: string; field?: string; [key: string]: unknown };

/** The keys each kind takes (aiStepReliabilitySpec CHECK_KEYS), so a kind change drops the other kind's keys. */
const KIND_KEYS: Record<CheckKind, readonly string[]> = {
    allowedFrom: ['kind', 'field', 'ref', 'value', 'ignoreCase', 'allowEmpty'],
    numbersFrom: ['kind', 'field', 'ref', 'tolerance', 'ignoreUpTo', 'percent', 'ignoreDates'],
    script: ['kind', 'field', 'script', 'minRatio'],
    items: ['kind', 'field', 'minItems', 'maxItems', 'sameCountAs'],
};

const SMALL_BTN = 'px-2 py-1 text-[11px] rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]';

const asList = (v: unknown): AiCheck[] => (Array.isArray(v) ? v.filter((c): c is AiCheck => !!c && typeof c === 'object' && !Array.isArray(c)) : []);
const isKind = (k: unknown): k is CheckKind => typeof k === 'string' && (AI_CHECK_KINDS as readonly string[]).includes(k);

/** The entry with `key` set, or removed when the value is blank. */
function withKey(check: AiCheck, key: string, value: unknown): AiCheck {
    const next = { ...check };
    if (value === undefined || value === null || value === '') delete next[key];
    else next[key] = value;
    return next;
}

/** The entry as another kind: the shared keys stay, the other kind's keys go. */
function withKind(check: AiCheck, kind: CheckKind): AiCheck {
    const keep = KIND_KEYS[kind];
    const next: AiCheck = { kind };
    for (const [k, v] of Object.entries(check)) if (k !== 'kind' && keep.includes(k)) next[k] = v;
    if (kind === 'script' && next.script === undefined) next.script = 'latin';
    return next;
}

const numberOrUndefined = (raw: string): number | undefined => (raw.trim() === '' || !Number.isFinite(Number(raw)) ? undefined : Number(raw));

interface AiChecksFieldProps {
    label?: string;
    value: unknown;
    onChange: (next: AiCheck[] | undefined) => void;
    disabled?: boolean;
}

export default function AiChecksField({ label, value, onChange, disabled = false }: AiChecksFieldProps) {
    const { t } = useTranslation();
    const checks = asList(value);
    const commit = (next: AiCheck[]) => onChange(next.length ? next : undefined);
    const update = (i: number, next: AiCheck) => commit(checks.map((c, j) => (j === i ? next : c)));
    const kindLabel: Record<CheckKind, string> = {
        allowedFrom: t('studio_apps_aichecks.kind_allowed_from', 'Is one of a list'),
        numbersFrom: t('studio_apps_aichecks.kind_numbers_from', 'Its numbers appear in the source'),
        script: t('studio_apps_aichecks.kind_script', 'Is written in a script'),
        items: t('studio_apps_aichecks.kind_items', 'Has a number of list items'),
    };

    return (
        <FormField
            label={label || t('studio_apps_aichecks.label', 'Answer checks')}
            hint={t('studio_apps_aichecks.hint', 'Checked after every answer. An answer that fails is sent back to the AI with what failed; if it still fails, the step fails.')}
        >
            <div className="flex flex-col gap-2" data-ai-checks>
                {checks.map((c, i) => {
                    const kind = isKind(c.kind) ? c.kind : null;
                    const n = i + 1;
                    return (
                        <div key={i} className="flex flex-col gap-1.5 rounded-md border border-[var(--border-default)] p-2" data-ai-check={i}>
                            <div className="flex items-center gap-1.5">
                                <select
                                    className={INPUT_CLS}
                                    value={kind || ''}
                                    onChange={(e) => { if (isKind(e.target.value)) update(i, withKind(c, e.target.value)); }}
                                    disabled={disabled}
                                    aria-label={t('studio_apps_aichecks.kind_aria', 'Kind of check {n}', { n })}
                                >
                                    {!kind ? <option value="">{t('studio_apps_aichecks.kind_pick', 'Pick a kind…')}</option> : null}
                                    {AI_CHECK_KINDS.map((k) => <option key={k} value={k}>{kindLabel[k]}</option>)}
                                </select>
                                <button
                                    type="button"
                                    className={SMALL_BTN}
                                    onClick={() => commit(checks.filter((_, j) => j !== i))}
                                    disabled={disabled}
                                    aria-label={t('studio_apps_aichecks.remove_aria', 'Remove check {n}', { n })}
                                >
                                    {t('studio_apps_aichecks.remove', 'Remove')}
                                </button>
                            </div>
                            <TextInput
                                value={c.field}
                                onChange={(v) => update(i, withKey(c, 'field', v))}
                                placeholder={t('studio_apps_aichecks.field_placeholder', 'Answer field: category, text or rows[].category')}
                                ariaLabel={t('studio_apps_aichecks.field_aria', 'Answer field of check {n}', { n })}
                                disabled={disabled}
                            />
                            {kind ? <KindInputs kind={kind} check={c} n={n} onChange={(next) => update(i, next)} disabled={disabled} /> : null}
                        </div>
                    );
                })}
                <button
                    type="button"
                    className={`self-start ${SMALL_BTN} border-dashed`}
                    onClick={() => commit([...checks, { kind: 'allowedFrom', field: '' }])}
                    disabled={disabled}
                >
                    {t('studio_apps_aichecks.add', 'Add a check')}
                </button>
            </div>
        </FormField>
    );
}

interface KindInputsProps { kind: CheckKind; check: AiCheck; n: number; onChange: (next: AiCheck) => void; disabled: boolean }

/** The inputs one kind of check takes besides its field. */
function KindInputs({ kind, check, n, onChange, disabled }: KindInputsProps) {
    const { t } = useTranslation();
    const set = (key: string, v: unknown) => onChange(withKey(check, key, v));
    const refInput = (key: 'ref' | 'sameCountAs', placeholder: string) => (
        <TextInput
            value={check[key]}
            onChange={(v) => set(key, v)}
            placeholder={placeholder}
            ariaLabel={t('studio_apps_aichecks.ref_aria', 'Data to compare with, check {n}', { n })}
            disabled={disabled}
        />
    );
    if (kind === 'allowedFrom') {
        return (
            <>
                {refInput('ref', t('studio_apps_aichecks.ref_list_placeholder', 'The list: vars.categories, item.options, form.choices'))}
                <TextInput
                    value={check.value}
                    onChange={(v) => set('value', v)}
                    placeholder={t('studio_apps_aichecks.value_placeholder', 'Part of each item that holds the value (optional): name')}
                    ariaLabel={t('studio_apps_aichecks.value_aria', 'Part of each list item, check {n}', { n })}
                    disabled={disabled}
                />
            </>
        );
    }
    if (kind === 'numbersFrom') {
        return (
            <>
                {refInput('ref', t('studio_apps_aichecks.ref_source_placeholder', 'The source data: vars.order, item.lines'))}
                <NumberInput value={check.tolerance} onChange={(v) => set('tolerance', v)} min={0} step={0.01} placeholder={t('studio_apps_aichecks.tolerance_placeholder', 'Allowed difference (0)')} ariaLabel={t('studio_apps_aichecks.tolerance_aria', 'Allowed difference, check {n}', { n })} disabled={disabled} />
            </>
        );
    }
    if (kind === 'script') {
        return (
            <div className="flex items-center gap-1.5">
                <select
                    className={INPUT_CLS}
                    value={typeof check.script === 'string' ? check.script : 'latin'}
                    onChange={(e) => set('script', e.target.value)}
                    disabled={disabled}
                    aria-label={t('studio_apps_aichecks.script_aria', 'Script of check {n}', { n })}
                >
                    {AI_CHECK_SCRIPTS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
                <NumberInput value={check.minRatio} onChange={(v) => set('minRatio', v)} min={0} max={1} step={0.05} placeholder={t('studio_apps_aichecks.min_ratio_placeholder', 'Share of letters (1)')} ariaLabel={t('studio_apps_aichecks.min_ratio_aria', 'Share of letters in the script, check {n}', { n })} disabled={disabled} />
            </div>
        );
    }
    return (
        <>
            <div className="flex items-center gap-1.5">
                <NumberInput value={check.minItems} onChange={(v) => set('minItems', v)} min={0} step={1} placeholder={t('studio_apps_aichecks.min_items_placeholder', 'At least')} ariaLabel={t('studio_apps_aichecks.min_items_aria', 'At least this many items, check {n}', { n })} disabled={disabled} />
                <NumberInput value={check.maxItems} onChange={(v) => set('maxItems', v)} min={0} step={1} placeholder={t('studio_apps_aichecks.max_items_placeholder', 'At most')} ariaLabel={t('studio_apps_aichecks.max_items_aria', 'At most this many items, check {n}', { n })} disabled={disabled} />
            </div>
            {refInput('sameCountAs', t('studio_apps_aichecks.same_count_placeholder', 'As many items as (optional): form.files'))}
        </>
    );
}

/** The highest `repairRounds` (server LIMITS.MAX_AI_REPAIR_ROUNDS; the catalog's limits carry it). */
const MAX_REPAIR_ROUNDS = 3;

type ReliabilityPatch = { temperature?: number; checks?: AiCheck[]; repairRounds?: number };

interface AiReliabilityFieldsProps {
    action: { temperature?: unknown; checks?: unknown; repairRounds?: unknown };
    set: (patch: ReliabilityPatch) => void;
    disabled: boolean;
}

/**
 * The three reliability fields of a bare ai_generate / ai_extract action (the inspector's own
 * editors). In a sequence the spec-driven step settings render the same fields.
 */
export function AiReliabilityFields({ action, set, disabled }: AiReliabilityFieldsProps) {
    const { t } = useTranslation();
    const hasChecks = asList(action.checks).length > 0;
    const rounds = typeof action.repairRounds === 'number' ? action.repairRounds : '';
    return (
        <>
            <FormField label={t('studio_apps_aichecks.temperature', 'Temperature')} hint={t('studio_apps_aichecks.hint_temperature', 'From 0 to 2. Lower answers vary less between runs. Leave it empty to use the model tier’s setting.')}>
                <NumberInput value={action.temperature} onChange={(v) => set({ temperature: v })} min={0} max={2} step={0.1} placeholder={t('studio_apps_aichecks.temperature_placeholder', 'Model tier setting')} ariaLabel={t('studio_apps_aichecks.temperature', 'Temperature')} disabled={disabled} />
            </FormField>
            <AiChecksField value={action.checks} onChange={(v) => set({ checks: v, ...(v ? {} : { repairRounds: undefined }) })} disabled={disabled} />
            {hasChecks ? (
                <FormField label={t('studio_apps_aichecks.repair_rounds', 'Repair rounds')} hint={t('studio_apps_aichecks.hint_repair_rounds', 'How often an answer that fails its checks goes back to the AI before the step fails (0 to 3, empty = 1). Each round is one more AI call.')}>
                    <select
                        className={INPUT_CLS}
                        value={rounds}
                        onChange={(e) => set({ repairRounds: e.target.value === '' ? undefined : Number(e.target.value) })}
                        disabled={disabled}
                        aria-label={t('studio_apps_aichecks.repair_rounds', 'Repair rounds')}
                    >
                        <option value="">{t('studio_apps_aichecks.repair_rounds_default', 'Default (1 round)')}</option>
                        {Array.from({ length: MAX_REPAIR_ROUNDS + 1 }, (_, n) => (
                            <option key={n} value={n}>
                                {n === 0
                                    ? t('studio_apps_aichecks.repair_rounds_none', 'No repair: fail at once')
                                    : n === 1
                                        ? t('studio_apps_aichecks.repair_rounds_one', '1 round')
                                        : t('studio_apps_aichecks.repair_rounds_n', '{n} rounds', { n })}
                            </option>
                        ))}
                    </select>
                </FormField>
            ) : null}
        </>
    );
}

interface TextInputProps { value: unknown; onChange: (v: string) => void; placeholder: string; ariaLabel: string; disabled: boolean }

function TextInput({ value, onChange, placeholder, ariaLabel, disabled }: TextInputProps) {
    return (
        <input
            type="text"
            className={INPUT_CLS}
            value={typeof value === 'string' ? value : ''}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            spellCheck={false}
            disabled={disabled}
            aria-label={ariaLabel}
        />
    );
}

interface NumberInputProps { value: unknown; onChange: (v: number | undefined) => void; min?: number; max?: number; step: number; placeholder?: string; ariaLabel: string; disabled: boolean }

/** A number, or nothing written when blank. */
export function NumberInput({ value, onChange, min, max, step, placeholder, ariaLabel, disabled }: NumberInputProps) {
    return (
        <input
            type="number"
            className={INPUT_CLS}
            value={typeof value === 'number' ? value : ''}
            min={min}
            max={max}
            step={step}
            onChange={(e) => onChange(numberOrUndefined(e.target.value))}
            placeholder={placeholder}
            disabled={disabled}
            aria-label={ariaLabel}
        />
    );
}
