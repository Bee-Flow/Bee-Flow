/**
 * "Fixed automatically: step 'Get summaries' was reading the wrong field. · Undo", or for the order of the steps
 * "Fixed automatically: 'A week ago' now reads from 'Now'. · Undo" (server core/cowork/repairs/autoResolve.mts, decision
 * 0050). Shown on the item while the fixed version is still its plan; Undo approves the version before it again
 * (POST /api/cowork/:id/plan/restore). Nothing when there is nothing to say.
 */
import { Wrench } from 'lucide-react';
import { autoFixLine, autoFixed } from './coworkProposalModel';
import { useCoworkProposalActions, useCoworkProposals } from '@/api/coworkProposals';
import { useTranslation } from '@/hooks/useTranslation';

export default function CoworkAutoFixNote({ coworkId }: { coworkId: string }) {
    const { t } = useTranslation();
    const fix = autoFixed(useCoworkProposals(coworkId).data);
    const { restore } = useCoworkProposalActions(coworkId);
    if (!fix || fix.undoVersion === null) return null;
    const version = fix.undoVersion;
    return (
        <div className="rounded-[10px] border px-3.5 py-2.5 flex flex-wrap items-center gap-x-2 gap-y-1.5 [border-color:var(--border-default)]" data-testid="cowork-auto-fix">
            <span className="flex-1 min-w-[200px] inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-primary)]">
                <Wrench aria-hidden="true" className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                {autoFixLine(fix, t)}
            </span>
            <button
                type="button"
                className="text-[12px] font-medium text-[var(--accent)] disabled:opacity-50"
                disabled={restore.isPending}
                onClick={() => restore.mutate(version)}
            >
                {restore.isPending ? t('cowork_resolver.note.undoing', 'Undoing…') : t('cowork_resolver.note.undo', 'Undo')}
            </button>
            {restore.error && <p role="alert" className="w-full text-[12px] text-[var(--error-ink)]">{t('cowork_resolver.note.failed', 'That did not work. Try again.')}</p>}
        </div>
    );
}
