import { Loader2, ScanSearch } from 'lucide-react';
import React from 'react';
import { useTranslation } from '../../../../../hooks/useTranslation';

/**
 * In the Suggest-outputs preview, where the match count would be: "is about"
 * rules are decided by the topic classifier when the step runs, so they are
 * not counted until the author asks for the sample rows to be scored. What the
 * button sends is said before the click, the same promise the "Ask the AI"
 * row makes about its own request.
 */
export interface TopicCheckState {
    needed: boolean;
    loading: boolean;
    error: string;
    /** Rows the classifier's answer covers, once checked; null before. */
    checkedRows: number | null;
    totalRows: number;
    check: () => void;
}

export default function TopicCheckRow({ unit, topic }: { unit: string; topic?: TopicCheckState | null }) {
    const { t } = useTranslation();
    if (!topic?.needed) return null;
    const { loading, error, checkedRows, totalRows, check: onCheck } = topic;
    if (checkedRows != null) {
        return checkedRows < totalRows ? (
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('routines.builder.topics.checked_first', 'Checked by the topic classifier against the first {n} of {total} sample {unit}.', { n: checkedRows, total: totalRows, unit })}
            </div>
        ) : null;
    }
    return (
        <div className="space-y-1">
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('routines.builder.topics.decided_at_run', '“Is about” is decided by the topic classifier when the step runs, so it is not counted here yet.')}
            </div>
            {loading ? (
                <div className="inline-flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
                    <Loader2 size={11} className="animate-spin" /> {t('routines.builder.topics.checking', 'Checking the sample {unit}…', { unit })}
                </div>
            ) : (
                <button
                    type="button"
                    onClick={onCheck}
                    className="inline-flex items-center gap-1.5 px-2 py-1 text-[11px] rounded border border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] transition"
                >
                    <ScanSearch size={11} /> {t('routines.builder.topics.check', 'Check the sample {unit}', { unit })}
                </button>
            )}
            <div className="text-[10px] text-[var(--text-tertiary)]">
                {t('routines.builder.topics.check_sends', 'This sends the text of up to 25 sample {unit} to the topic classifier on this server. Nothing is stored, and nothing leaves the server.', { unit })}
            </div>
            {error && <div className="text-[10px] text-amber-600 dark:text-amber-400">{error}</div>}
        </div>
    );
}
