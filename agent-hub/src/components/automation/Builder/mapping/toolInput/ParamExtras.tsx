import { QueryClientContext } from '@tanstack/react-query';
import { AlertTriangle, Sparkles } from 'lucide-react';
import { useContext } from 'react';
import { useUsageValuesQuery } from '../../../../../api/queries/automation/ndv';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { humanizeFieldKey } from '../../flow/displayHelpers';

/**
 * The round-4 extras around one setting in "What this step does" (artboards
 * 4a/4b): short choices as buttons with "recommended" on the schema default,
 * a one-click suggestion for an empty required setting, the values this
 * organisation uses most, and the problem the last run had with it.
 */

const humanize = humanizeFieldKey as (k: string) => string;

/** A short enum as a row of buttons (a radio group), "recommended" on the default. */
export function EnumChoice({ options, value, recommended, onPick, label }: {
    options: string[];
    value: string | null;
    recommended: string | null;
    onPick: (v: string) => void;
    label: string;
}) {
    const { t } = useTranslation();
    return (
        <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2" data-testid="param-enum">
            {options.map(opt => {
                const on = value === opt;
                return (
                    <button
                        key={opt}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        onClick={() => onPick(opt)}
                        className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium transition ${on
                            ? 'border-2 border-[var(--accent-primary)] text-[var(--text-primary)]'
                            : 'border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'}`}
                    >
                        {/* Codes (EUR, GET, PDF) stay as written; only names get prettified. */}
                        {/^[A-Z0-9_]+$/.test(opt) ? opt : (humanize(opt) || opt)}
                        {recommended === opt && (
                            <span className="font-medium text-[var(--type-ai)]">· {t('automations.ndv.recommended', 'recommended')}</span>
                        )}
                    </button>
                );
            })}
        </div>
    );
}

export interface ParamSuggestion {
    binding: unknown;
    label: string;
    source: 'field' | 'default';
}

/** "Root folder /  suggestion": one click fills the empty required setting. */
export function SuggestionChip({ suggestion, onUse }: { suggestion: ParamSuggestion; onUse: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-2 text-[11px]" data-testid="param-suggestion">
            <button
                type="button"
                onClick={onUse}
                title={t('automations.ndv.use_suggestion', 'Use this suggestion')}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border border-dashed border-[var(--border-default)] text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            >
                <Sparkles size={11} className="text-[var(--type-ai)]" />
                {suggestion.label}
            </button>
            <span className="px-1.5 rounded-full leading-4 text-[10px] font-semibold bg-[color-mix(in_srgb,var(--type-ai)_12%,transparent)] text-[var(--type-ai)]">
                {t('automations.ndv.suggestion', 'suggestion')}
            </span>
        </div>
    );
}

/**
 * "Frequently used: Documents · Invoices · Photos". Rendered only inside a
 * QueryClientProvider: the chips are a convenience, and a surface without
 * one (a stand-alone form, a test) simply goes without them.
 */
export function FrequentValues(props: { tool: string; input: string; onPick: (v: string) => void }) {
    const client = useContext(QueryClientContext);
    if (!client || !props.tool || !props.input) return null;
    return <FrequentValuesInner {...props} />;
}

function FrequentValuesInner({ tool, input, onPick }: { tool: string; input: string; onPick: (v: string) => void }) {
    const { t } = useTranslation();
    const { data } = useUsageValuesQuery(tool, input);
    if (!data || !data.length) return null;
    return (
        <div className="flex items-center flex-wrap gap-1.5 text-[11px] text-[var(--text-tertiary)]" data-testid="param-frequent">
            <span>{t('automations.ndv.frequently_used', 'Frequently used:')}</span>
            {data.map(v => (
                <button
                    key={v.value}
                    type="button"
                    onClick={() => onPick(v.value)}
                    className="px-2 py-0.5 rounded-full border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] max-w-[180px] truncate"
                    title={v.value}
                >
                    {v.value}
                </button>
            ))}
        </div>
    );
}

/** The last run's problem with THIS setting, under its red ring. */
export function ProblemNote({ text }: { text: string }) {
    return (
        <div className="flex items-start gap-1.5 text-[11px] font-semibold text-[var(--error)]" data-testid="param-problem" role="note">
            <AlertTriangle size={12} className="shrink-0 mt-px" />
            <span>{text}</span>
        </div>
    );
}
