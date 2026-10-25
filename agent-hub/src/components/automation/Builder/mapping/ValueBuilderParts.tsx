import { Eye, List, Repeat, Tag, Workflow, X, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import React from 'react';
import { pillTint, PILL_TINT_CLASS } from './refEditorDom.helpers';
import { classifyRef, scanExprPaths } from './refTokens';
import { describeDataPath } from './valueParts';
import { useTranslation } from '../../../../hooks/useTranslation';
import { canonicalRefPath, isCleanPath, refPathTokens } from '../../../../utils/bindingHelpers';
import { denseInputClass, FOCUS_RING } from '../flow/settings/formStyles';
import type { LabelLookup } from './refTokens';
import type { ValuePart } from './valueParts';

type TypeLookup = { get?(id: string | undefined): string | undefined } | null;


/**
 * The path a value that is ONLY text spells out (`steps.jira.output.fields["Story
 * Points"]` typed or left behind as plain text), canonical — or null. The run
 * sends those characters, not the value they name; the editor offers the fix.
 */
export function pathTextOf(parts: ValuePart[]): string | null {
    if (parts.length !== 1 || parts[0].type !== 'text') return null;
    const text = (parts[0].text ?? '').trim();
    const tokens = isCleanPath(text) ? refPathTokens(text) : null;
    return tokens && tokens.length > 1 && PATH_TEXT_ROOTS.has(String(tokens[0].key)) ? canonicalRefPath(text) : null;
}

const PATH_TEXT_ROOTS = new Set(['steps', 'trigger', 'loop', 'vars', 'item']);

// How much of a value the example line holds; it wraps to two lines.
export const EXAMPLE_MAX = 240;

export function ExampleLine({ value }: { value: string }) {
    const { t } = useTranslation();
    return (
        <div className="text-[10px] text-[var(--text-tertiary)] flex items-start gap-1.5 min-w-0" data-testid="value-example">
            <Eye size={11} className="shrink-0 mt-px" />
            <span className="shrink-0">{t('automations.builder.how_it_looks', "Here's how it looks:")}</span>
            <span className="text-[var(--text-secondary)] min-w-0 break-words line-clamp-2" title={value}>{value}</span>
        </div>
    );
}

interface TextPartProps {
    text: string;
    placeholder: string;
    onChange: (text: string) => void;
    onFocus?: React.FocusEventHandler<HTMLInputElement>;
    onRemove?: (() => void) | null;
}

export function TextPart({ text, placeholder, onChange, onFocus, onRemove = null }: TextPartProps) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-1">
            <input
                type="text"
                value={text}
                onChange={(e) => onChange(e.target.value)}
                onFocus={onFocus}
                placeholder={placeholder}
                className={denseInputClass('flex-1 min-w-0')}
            />
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={t('automations.builder.remove_text', 'Remove this text')}
                    className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-secondary)]"
                >
                    <X size={12} />
                </button>
            )}
        </div>
    );
}

const SOURCE_ICON: Record<string, LucideIcon> = { steps: Workflow, trigger: Zap, loop: Repeat, item: List, vars: Tag };

// What a transformed chip says after its name — the chip itself is the only
// place the eye lands, so the transform must be visible ON it, not only in
// the dropdown below.
const TRANSFORM_SUFFIX: Record<string, string> = {
    join: '· joined',
    first: '· first of the list',
    last: '· last of the list',
    count: '· how many',
    // 2b draws these ON the chip, e.g. "· as € 1,500,000" or "· as a table".
    formatDate: '· as a written date',
    yesNoText: '· in your own words',
    groupSummary: '· as a summary',
    asTable: '· as a table',
};

/** formatNumber says WHICH format on the chip — the three read very differently. */
const NUMBER_STYLE_SUFFIX: Record<string, string> = {
    amount: '· as an amount',
    currency: '· as an amount',
    percent: '· as a percentage',
    plain: '· as a plain number',
};


interface DataPartProps {
    path: string;
    stepLabelById: LabelLookup & Pick<Map<string, string>, 'get' | 'has'>;
    stepTypeById?: TypeLookup;
    onChange: React.MouseEventHandler<HTMLElement> | null;
    onRemove: () => void;
    jsonPath?: string | null;
    transform?: string | null;
    transformArg?: string | null;
}

export function DataPart({ path, stepLabelById, stepTypeById = null, onChange, onRemove, jsonPath = null, transform = null, transformArg = null }: DataPartProps) {
    const { t } = useTranslation();
    const { name, suffix, missing, source } = describeDataPath(path, stepLabelById);
    const Icon = SOURCE_ICON[source] || Workflow;
    const stepId = classifyRef(String(path || ''))?.stepId || null;
    const tint = pillTint({ source: source === 'item' ? 'loop' : source, stepId: stepId || undefined }, stepTypeById);
    // The pill IS the "change" control (a real button, so the keyboard reaches
    // it): a separate "change" link beside it only crowded the row.
    const suffixText = transform === 'formatNumber'
        ? NUMBER_STYLE_SUFFIX[transformArg || 'plain']
        : transform ? TRANSFORM_SUFFIX[transform] : undefined;
    const Pill = onChange ? 'button' : 'span';
    return (
        <div className="flex items-center gap-2">
            <Pill
                {...(onChange ? { type: 'button', onClick: onChange } : {})}
                title={onChange ? t('automations.builder.change_word', 'change') : (jsonPath ? `parseJson(${path}, "${jsonPath}")` : path)}
                style={{ '--pill-tint': tint } as React.CSSProperties}
                className={`inline-flex items-center gap-1 min-w-0 rounded-md px-2.5 py-1.5 text-[11px] border ${onChange ? `cursor-pointer hover:brightness-95 ${FOCUS_RING}` : ''} ${
                    missing
                        ? 'border-dashed border-[var(--border-default)] bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'
                        : PILL_TINT_CLASS
                }`}
            >
                <Icon size={11} className="shrink-0 opacity-70" />
                <span className="font-medium truncate">{name}</span>
                {suffix && <span className="opacity-70 truncate">▸ {suffix}</span>}
                {suffixText && (
                    <span className="opacity-70 truncate">{suffixText}</span>
                )}
                {jsonPath != null && (
                    <span className="opacity-70 truncate">
                        {t('automations.builder.from_the_json', '· from the JSON')}{jsonPath ? `: ${jsonPath}` : ''}
                    </span>
                )}
            </Pill>
            <button
                type="button"
                onClick={onRemove}
                aria-label={t('automations.builder.remove_value', 'Remove this value')}
                className="shrink-0 p-1 rounded text-[var(--text-tertiary)] hover:text-red-500 hover:bg-[var(--bg-secondary)]"
            >
                <X size={12} />
            </button>
        </div>
    );
}

/**
 * Read-only render of a formula with its step references resolved to names.
 * Deliberately NOT RefChips: that component only knows the `steps.`/`trigger.`/
 * `loop.` roots, so a list-mode `item.subject` would come out raw. Here every
 * pickable path goes through describeDataPath. Paths are found the way the
 * expression engine reads them (refTokens.scanExprPaths): a bracket after the
 * root, a quoted key or a match segment belongs to the chip; text inside a
 * string literal never does.
 */
const FORMULA_ROOTS = ['steps', 'trigger', 'loop', 'vars', 'item', '_index'];

export function FormulaChips({ text, stepLabelById, stepTypeById = null }: { text: string; stepLabelById: Pick<Map<string, string>, 'get' | 'has'>; stepTypeById?: TypeLookup }) {
    const nodes = scanExprPaths(String(text || ''), FORMULA_ROOTS);

    return (
        <div className="text-[11px] leading-[1.6] break-words text-[var(--text-primary)]">
            {nodes.map((n, i) => {
                if (n.text != null) return <span key={i} className="font-mono opacity-70">{n.text}</span>;
                const { name, suffix, source: refSource } = describeDataPath(n.path, stepLabelById);
                // The SOURCE STEP's family colour, exactly like every other
                // reference pill (DataPart above, RefTokenInput). `--accent`
                // used to tint these: a grey that reads as "disabled" and, on
                // the canvas, is banned outright (nodeTypeColors.js).
                const stepId = classifyRef(String(n.path || ''))?.stepId || null;
                const tint = pillTint({ source: refSource === 'item' ? 'loop' : refSource, stepId: stepId || undefined }, stepTypeById);
                return (
                    <span
                        key={i}
                        title={n.path}
                        style={{ '--pill-tint': tint } as React.CSSProperties}
                        className={`inline-flex items-center gap-1 align-middle mx-0.5 rounded px-1.5 py-0.5 border ${PILL_TINT_CLASS}`}
                    >
                        <span className="font-medium">{name}</span>
                        {suffix && <span className="opacity-70">▸ {suffix}</span>}
                    </span>
                );
            })}
        </div>
    );
}
