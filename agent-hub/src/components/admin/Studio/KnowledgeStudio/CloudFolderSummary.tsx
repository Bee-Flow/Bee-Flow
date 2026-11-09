import { refreshModeKey } from './freshness';
import { providerName } from '../Datatables/datatableDisplay';
import type { KbSource } from './knowledgeApi';
import type { TranslateFn } from '@/hooks/useTranslation';

/** Where a cloud-folder source reads from, and how it stays in step. */
export default function CloudFolderSummary({ t, source }: { t: TranslateFn; source: KbSource }) {
    const cfg = source.config || {};
    return (
        <dl
            data-testid="kb-cloud-summary"
            className="flex flex-wrap gap-x-6 gap-y-1 px-3 py-2 rounded-lg bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
        >
            <div className="flex gap-1.5">
                <dt className="text-[var(--text-tertiary)]">{t('knowledge.cloud.summary_cloud', 'Cloud')}</dt>
                <dd>{providerName(cfg.provider)}</dd>
            </div>
            <div className="flex gap-1.5">
                <dt className="text-[var(--text-tertiary)]">{t('knowledge.cloud.summary_folder', 'Folder')}</dt>
                <dd>{cfg.path || cfg.folderName || ''}</dd>
            </div>
            <div className="flex gap-1.5">
                <dt className="text-[var(--text-tertiary)]">{t('knowledge.cloud.summary_subfolders', 'Subfolders')}</dt>
                <dd>{cfg.recursive ? t('knowledge.cloud.summary_included', 'included') : t('knowledge.cloud.summary_not_included', 'not included')}</dd>
            </div>
            <div className="flex gap-1.5">
                <dt className="text-[var(--text-tertiary)]">{t('knowledge.cloud.summary_refresh', 'Refresh')}</dt>
                <dd>{t(refreshModeKey(source.refreshMode), source.refreshMode || 'manual')}</dd>
            </div>
        </dl>
    );
}
