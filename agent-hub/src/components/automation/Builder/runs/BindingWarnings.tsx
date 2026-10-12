import { useState } from 'react';
import { SearchX } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { allRuleMisses, bindingWarningLine, type BindingWarning, type StepTypeLookup } from './bindingMisses';

// Most steps miss one or two; a loop body with a bad mapping can list many.
const SHOWN = 5;

function WarningLine({ warning, labelById, typeById }: {
    warning: BindingWarning; labelById: Map<string, string> | null; typeById: StepTypeLookup;
}) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const line = bindingWarningLine(t, warning, labelById, typeById);
    return (
        <li className="flex flex-col min-w-0">
            <button
                type="button"
                aria-expanded={open}
                title={line.detail}
                onClick={() => setOpen(v => !v)}
                className="w-full text-left flex items-baseline gap-1.5 min-w-0 rounded px-1 -mx-1 hover:bg-[var(--bg-secondary)]"
            >
                <span className="shrink-0 max-w-[40%] truncate font-medium text-[var(--text-primary)]">{line.input}</span>
                <span className="min-w-0 truncate text-[var(--text-secondary)]">{line.source}</span>
                <span className="shrink-0 text-[var(--text-tertiary)]">· {line.why}</span>
                {line.count > 1 && <span className="shrink-0 text-[var(--text-tertiary)]">· {line.count}×</span>}
            </button>
            {open && (
                <div className="mt-1 mb-1 ml-1 pl-2 border-l border-[var(--border-default)] flex flex-col gap-1 text-[var(--text-secondary)]">
                    <span className="leading-4 break-words">{line.detail}</span>
                    {line.raw !== line.detail && (
                        <code className="font-mono text-[10px] text-[var(--text-tertiary)] break-all">{line.raw}</code>
                    )}
                </div>
            )}
        </li>
    );
}

/**
 * "Mappings that found nothing": every input of this step whose mapping
 * resolved to nothing while it ran (the run-step row's `bindingWarnings`).
 * Said after the fact and calmly, because an empty input with a green run is
 * otherwise all anyone sees: one line per input, which field it read, why it
 * came back empty, the server's sentence on hover and on open.
 */
export default function BindingWarnings({ warnings, labelById = null, typeById = null }: {
    warnings: BindingWarning[];
    labelById?: Map<string, string> | null;
    /** Step id → type: a path into a Condition's outputs then reads as the output's name. */
    typeById?: StepTypeLookup;
}) {
    const { t } = useTranslation();
    const [all, setAll] = useState(false);
    if (warnings.length === 0) return null;
    const shown = all ? warnings : warnings.slice(0, SHOWN);
    const hidden = warnings.length - shown.length;
    return (
        <div className="shrink-0 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 flex flex-col gap-1.5 text-[11px]" data-testid="output-binding-warnings">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                <SearchX size={12} aria-hidden className="text-[var(--warning)]" />
                {t('automations.output.binding_misses_title', 'Mappings that found nothing')}
            </div>
            <ul className="flex flex-col gap-0.5 min-w-0">
                {shown.map((w, i) => (
                    <WarningLine key={`${w.field ?? ''}|${w.path}|${w.reason}|${i}`} warning={w} labelById={labelById} typeById={typeById} />
                ))}
            </ul>
            {hidden > 0 && (
                <button type="button" onClick={() => setAll(true)} className="self-start text-[var(--text-tertiary)] underline hover:text-[var(--text-primary)]">
                    {t('automations.output.binding_misses_more', 'Show {n} more', { n: hidden })}
                </button>
            )}
            <div className="text-[var(--text-tertiary)] leading-4">
                {allRuleMisses(warnings)
                    ? t('condition_node.miss.hint', 'A rule read a field that none of the items have, so it matched nothing. Pick the field again in the Condition.')
                    : t('automations.output.binding_misses_hint', 'These inputs were left empty. Pick the field again in the step’s settings, or check that the earlier step returned it.')}
            </div>
        </div>
    );
}
