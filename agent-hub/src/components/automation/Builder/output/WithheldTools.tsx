import { ShieldOff } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { withheldReasonText } from '../flow/settings/agentStep/agentStepModel';

/** One tool the run did not offer this AI step (run-step row `toolsWithheld`). */
export interface WithheldRunTool {
    name: string;
    reason?: string | null;
}

/** Keeps well-formed rows; the server sends null when nothing was held back. */
export function withheldRunTools(value: unknown): WithheldRunTool[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((w): WithheldRunTool[] => {
        if (typeof w === 'string' && w) return [{ name: w, reason: null }];
        const o = w && typeof w === 'object' ? w as { name?: unknown; reason?: unknown } : null;
        return o && typeof o.name === 'string' && o.name
            ? [{ name: o.name, reason: typeof o.reason === 'string' ? o.reason : null }]
            : [];
    });
}

/**
 * The tools this AI step's run was NOT given (round 3): the ones a switch in
 * the step keeps off, and the ones that would ask someone to confirm first.
 * Said after the fact, because "why did the agent not send the mail" is
 * answered here and nowhere else.
 */
export default function WithheldTools({ tools }: { tools: WithheldRunTool[] }) {
    const { t } = useTranslation();
    if (tools.length === 0) return null;
    return (
        <div className="shrink-0 rounded-[10px] border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2 flex flex-col gap-1.5 text-[11px]" data-testid="output-tools-withheld">
            <div className="flex items-center gap-1.5 font-semibold text-[var(--text-primary)]">
                <ShieldOff size={12} aria-hidden className="text-[var(--text-secondary)]" />
                {t('routines.output.tools_withheld', 'Tools held back in this run')}
            </div>
            <div className="flex flex-wrap gap-1">
                {tools.map(w => (
                    <span
                        key={w.name}
                        title={withheldReasonText(t, w.reason ?? null)}
                        className="px-1.5 rounded-full border border-dashed border-[var(--border-default)] text-[var(--text-tertiary)] line-through"
                    >
                        {w.name}
                    </span>
                ))}
            </div>
            {tools.some(w => w.reason === 'confirm') && (
                <div className="text-[var(--text-tertiary)] leading-4">
                    {t('routines.output.tools_withheld_confirm', 'Tools that ask someone to confirm are off in an automation. Put an approval step after this one if you need them.')}
                </div>
            )}
        </div>
    );
}
