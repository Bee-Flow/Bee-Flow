import useTranslation from '@/hooks/useTranslation';
import { MAX_PARALLEL_BRANCHES } from '@shared/appDefinition/parallelRules.mjs';
import type { StepFieldControlProps, StepFieldTypeModule } from '../fieldTypes';

interface Branch { steps?: unknown[] }

const BUTTON_CLS = 'px-2 py-1 text-[11px] rounded border border-[var(--border-default)] text-[var(--text-secondary)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-primary-hover)]';

/**
 * `stepBranches`: the branches of a parallel step. The steps INSIDE a branch are edited on the
 * canvas, where each branch is drawn like a case of a switch; this control says how many branches
 * there are. A step keeps at least one branch, and at most the limit the server validates.
 */
function StepBranchesControl({ value, onChange, disabled }: StepFieldControlProps) {
    const { t } = useTranslation();
    const branches: Branch[] = Array.isArray(value) ? value : [];
    const count = (b: Branch | null) => (b && Array.isArray(b.steps) ? b.steps.length : 0);
    return (
        <div className="flex flex-col gap-2" data-step-control="stepBranches">
            <span className="text-[11px] font-medium text-[var(--text-secondary)]">{t('studio_apps_flow_parallel.settings.branches', 'Branches')}</span>
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('studio_apps_flow_parallel.settings.help', 'The branches run at the same time. Each one starts with the variables as they are before this step and does not see what another branch writes, so give every branch its own variable for its result.')}
            </p>
            {branches.map((b, i) => (
                <div key={i} className="flex items-center justify-between gap-1.5">
                    <span className="text-xs text-[var(--text-primary)]">
                        {t('studio_apps_flow_parallel.settings.branch_row', 'Branch {n} ({count} steps)', { n: i + 1, count: count(b) })}
                    </span>
                    <button
                        type="button"
                        onClick={() => onChange(branches.filter((_, j) => j !== i))}
                        disabled={disabled || branches.length <= 1}
                        aria-label={t('studio_apps_flow_parallel.settings.remove_branch', 'Remove branch {n}', { n: i + 1 })}
                        className={`${BUTTON_CLS} shrink-0 hover:text-[var(--error)] disabled:opacity-50`}
                    >
                        {t('studio_apps_flow_parallel.settings.remove', 'Remove')}
                    </button>
                </div>
            ))}
            <button
                type="button"
                onClick={() => onChange([...branches, { steps: [] }])}
                disabled={disabled || branches.length >= MAX_PARALLEL_BRANCHES}
                className={`${BUTTON_CLS} self-start border-dashed font-medium hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50`}
            >
                {t('studio_apps_flow_parallel.settings.add_branch', 'Add a branch')}
            </button>
            {branches.length >= MAX_PARALLEL_BRANCHES ? (
                <p className="text-[11px] text-[var(--text-secondary)]">{t('studio_apps_flow_parallel.settings.limit', 'A step holds at most {max} branches.', { max: MAX_PARALLEL_BRANCHES })}</p>
            ) : null}
        </div>
    );
}

const entry: StepFieldTypeModule = { type: 'stepBranches', Control: StepBranchesControl };
export default entry;
