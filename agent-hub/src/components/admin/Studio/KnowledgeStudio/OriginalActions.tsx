import { Download, ExternalLink, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { cloudErrorOr } from './cloudErrors';
import { providerName } from '../Datatables/datatableDisplay';
import { downloadKbOriginal } from '@/api/kbOriginal';
import toast from '@/components/shared/Toast';
import useTranslation from '@/hooks/useTranslation';

interface DownloadOriginalProps {
    kbId: string;
    docId: string;
    /** The name offered when the server sends none. */
    name: string;
    /** `icon` = a bare icon button (table rows); `text` = icon and words. */
    variant?: 'icon' | 'text';
    className?: string;
}

/**
 * Download the ORIGINAL file of a document, where the base kept it.
 *
 * Rendered only when the caller knows `has_original` (or a citation's
 * `hasOriginal`): a button that can only answer `no_original` would teach that
 * the product is broken. When it does answer `no_original` anyway (the base's
 * switch was turned off and the file purged in between), the reason is said in a
 * toast rather than swallowed.
 */
export function DownloadOriginalButton({ kbId, docId, name, variant = 'icon', className = '' }: DownloadOriginalProps) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const label = t('knowledge.originals.download', 'Download original');
    const run = async () => {
        setBusy(true);
        try {
            await downloadKbOriginal(kbId, docId, name);
        } catch (e) {
            toast.error(cloudErrorOr(t, e, t('knowledge.originals.err_download', 'Could not download the original.')));
        } finally {
            setBusy(false);
        }
    };
    return (
        <button
            type="button"
            onClick={run}
            disabled={busy}
            data-testid="kb-download-original"
            aria-label={variant === 'icon' ? t('knowledge.originals.download_named', 'Download original of {name}', { name }) : undefined}
            title={label}
            className={`inline-flex items-center gap-1.5 rounded disabled:opacity-50 focus-visible:outline focus-visible:outline-2 [outline-color:var(--accent-primary)]! ${variant === 'icon' ? 'p-1 text-[var(--text-tertiary)]' : 'px-3 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'} ${className}`}
        >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Download className="w-3.5 h-3.5" aria-hidden="true" />}
            {variant === 'text' && label}
        </button>
    );
}

/** "Open in Nextcloud / OneDrive / Google Drive": the file where it lives. */
export function OpenInCloudLink({ url, provider, name }: { url: string; provider?: string; name: string }) {
    const { t } = useTranslation();
    const cloud = providerName(provider) || t('knowledge.originals.cloud', 'the cloud');
    return (
        <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="kb-open-in-cloud"
            aria-label={t('knowledge.originals.open_in_named', 'Open {name} in {cloud}', { name, cloud })}
            title={t('knowledge.originals.open_in', 'Open in {cloud}', { cloud })}
            className="inline-flex p-1 rounded text-[var(--text-tertiary)] focus-visible:outline focus-visible:outline-2 [outline-color:var(--accent-primary)]!"
        >
            <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
        </a>
    );
}
