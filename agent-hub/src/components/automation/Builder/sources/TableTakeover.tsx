import { ArrowLeft } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { walkPath } from '../../../../utils/bindingHelpers';
import type { PickOpts } from '../output/mapAttrs';
import OutputView from '../OutputView';
import type { TreeGroup } from './useSourceTree';

/**
 * The source panel's Table view of ONE step: its whole output as a table, so
 * a whole column or a single cell can be mapped (BFSF-329).
 *
 * Every header and cell hands over its legacy path, written by the one
 * quoting rule (`rows[*]["Order date"]`, never `rows[*].Order date`), and its
 * Source (output/mapAttrs.ts), so what the preview shows is what the run gets.
 */
export interface TableTakeoverProps {
    group: TreeGroup;
    previewSample: unknown;
    onPick: (path: string, opts?: PickOpts) => void;
    onBack: () => void;
}

export default function TableTakeover({ group, previewSample, onPick, onBack }: TableTakeoverProps) {
    const { t } = useTranslation();
    const value = walkPath(group.basePath, previewSample);
    return (
        <div className="flex-1 min-h-0 flex flex-col" data-testid="table-takeover">
            <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-[var(--border-default)] shrink-0">
                <button
                    type="button"
                    onClick={onBack}
                    className="inline-flex items-center gap-1 text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                >
                    <ArrowLeft size={12} /> {t('routines.mapping.fields', 'Fields')}
                </button>
                <span className="ml-auto text-[11px] text-[var(--text-primary)] font-medium truncate">{group.label}</span>
            </div>
            <div className="flex-1 min-h-0 flex flex-col p-2">
                <OutputView
                    value={value === undefined ? group.sample : value}
                    basePath={group.basePath}
                    fill
                    enableDrag
                    onPickPath={onPick}
                    emptyMessage={t('routines.mapping.no_data_yet', 'No data yet — run the upstream step to capture it.')}
                />
            </div>
        </div>
    );
}
