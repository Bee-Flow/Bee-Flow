// Two text documents (or a page and a deck outline) compared block by block:
// the server's answer is the editor's own diff, so it is drawn with the very
// renderer Version history uses (components/versions/DiffBody).

import { useMemo, useRef } from 'react';
import type { TextCompare } from '../../../../../../../api/queries/studioAppDocuments';
import useTranslation from '../../../../../../../hooks/useTranslation';
import { DiffBody } from '../../../../../../versions/DiffBody';
import { normalizeDiff } from '../../../../../../versions/versionDiff';
import type { CompareMode } from './CompareToolbar';
import { useDomStepper, type RegisterStep } from './useStepper';

export default function TextDiffView({ result, mode, onlyChanges, leftLabel, rightLabel, registerStep }: {
    result: TextCompare; mode: CompareMode; onlyChanges: boolean; leftLabel: string; rightLabel: string; registerStep: RegisterStep;
}) {
    const { t } = useTranslation();
    const diff = useMemo(() => normalizeDiff(result), [result]);
    const ref = useRef<HTMLDivElement | null>(null);
    useDomStepper(ref, '[data-diff]:not([data-diff="equal"])', registerStep, `${mode}:${onlyChanges}`);
    if (result.truncated) {
        return <p className="m-0 p-6 text-center text-sm text-[var(--text-secondary)]" role="status">{t('studio_app_documents.text_too_large', 'These documents are too long to compare paragraph by paragraph. The summary above says how much changed.')}</p>;
    }
    if (!diff.blocks.some((b) => b.op !== 'equal')) {
        return <p className="m-0 p-6 text-center text-sm text-[var(--text-muted)]" data-compare-same="true">{t('studio_app_documents.text_same', 'The text is the same.')}</p>;
    }
    return (
        <div ref={ref} className="min-h-0 flex-1 overflow-auto p-3 [&_[data-current-change]]:outline [&_[data-current-change]]:outline-2 [&_[data-current-change]]:outline-[var(--app-accent,#2563eb)]">
            {mode === 'side' ? (
                <div className="mb-1 grid grid-cols-2 gap-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]" aria-hidden="true">
                    <span className="truncate">{leftLabel}</span>
                    <span className="truncate">{rightLabel}</span>
                </div>
            ) : null}
            <DiffBody diff={diff} view={mode} onlyChanges={onlyChanges} />
        </div>
    );
}
