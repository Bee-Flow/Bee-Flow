import type { RepeatingSuggestion } from '../../../../../api/queries/automation/repeating';
import { useTranslation } from '../../../../../hooks/useTranslation';
import CanvasPill from '../../../../automation/Builder/flow/CanvasPill';
import { evidencePills } from './patternView';

/**
 * What the server measured behind a pattern, as canvas pills: "14× in 90
 * days", "3 of 4 weeks", "≈1–2 h/month (estimated)", "Gmail → Google Sheets",
 * and an "Early signal" tag when the history is still thin. Nothing here is
 * the model's: the pills come from `suggestion.pattern` alone.
 */
export default function EvidencePills({ suggestion, labelFor }: { suggestion: RepeatingSuggestion; labelFor: (id: string) => string }) {
    const { t } = useTranslation();
    const pills = evidencePills(suggestion, t, labelFor);
    if (!pills.length) return null;
    return (
        <ul className="m-0 p-0 list-none flex flex-wrap items-center gap-1.5" data-testid="evidence-pills">
            {pills.map(p => (
                <li key={p.id} data-pill={p.id}>
                    <CanvasPill tone={p.tone} title={p.title}>{p.text}</CanvasPill>
                </li>
            ))}
        </ul>
    );
}
