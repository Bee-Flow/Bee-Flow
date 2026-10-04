import { Info } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import type { FieldDiff, VersionRow } from '../../../../api/queries/automation/versions';
import FieldDiffTable from './FieldDiffTable';

interface Props {
    selected: VersionRow;
    compare: VersionRow | null;
    diff: { data?: FieldDiff; isError: boolean; isLoading: boolean };
}

function ChangesBody({ selected, compare, diff }: Props) {
    const { t } = useTranslation();
    const changes = diff.data?.changes ?? [];
    if (!compare) {
        return <div className="text-[var(--text-secondary)]">{t('automations.versions.firstVersion', 'This is the first version; there is nothing to compare with yet.')}</div>;
    }
    if (diff.isError) {
        return <div role="alert" className="text-[var(--error)]">{t('automations.versions.diffFailed', 'The changes could not be loaded.')}</div>;
    }
    if (diff.isLoading) return <div className="text-[var(--text-tertiary)]">{t('common.loading', 'Loading…')}</div>;
    if (changes.length === 0) {
        return <div className="text-[var(--text-secondary)]">{t('automations.versions.noChanges', 'No changes that affect how it runs.')}</div>;
    }
    return (
        <>
            <div className="font-semibold text-[var(--text-primary)]">
                {compare.isLive
                    ? t('automations.versions.changesSinceLive', '{count} changes since the live version', { count: changes.length })
                    : t('automations.versions.changesSince', '{count} changes compared with v{version}', { count: changes.length, version: compare.version })}
            </div>
            <FieldDiffTable changes={changes} from={compare.version} to={selected.version} />
        </>
    );
}

/** The per-setting change list under the mini canvas, plus the layout note. */
export default function VersionChanges(props: Props) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-col gap-2">
            <ChangesBody {...props} />
            <div className="flex items-center gap-1.5 text-[var(--text-tertiary)]">
                <Info size={12} className="shrink-0" />
                {t('automations.versions.layoutNote', "Layout and position changes don't count as a version; they are merged into the next real change.")}
            </div>
        </div>
    );
}
