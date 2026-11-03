import { Loader2, Rocket } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { FormDetail } from './useFormDetail';
import { publishAutomation } from '@/api/queries/automation/meta';
import { useTranslation } from '@/hooks/useTranslation';
import { toast } from '@/components/shared/Toast';

/**
 * Studio F11: on a form that has a live version, saved question edits land in
 * the WORKING copy and visitors keep getting the live one. Say how many
 * changes are not live, and offer the publish that makes them live
 * (POST /:id/publish with the version the editor saw). Nothing for a form
 * that was never live (it runs its working copy) or with nothing pending.
 */
interface PendingChangesProps {
    detail: FormDetail | null;
    disabled?: boolean;
    onPublished: () => Promise<unknown> | void;
}

export default function PendingChanges({ detail, disabled = false, onPublished }: PendingChangesProps) {
    const { t } = useTranslation();
    const [publishing, setPublishing] = useState(false);
    const pending = detail?.liveVersion != null ? Number(detail?.pendingChanges) || 0 : 0;

    const publish = useCallback(async () => {
        if (!detail) return;
        setPublishing(true);
        try {
            await publishAutomation(detail.automationId, detail.version ?? null);
            toast.success(t('forms.page.published', 'The changes are live.'));
            await onPublished();
        } catch (e) {
            toast.error((e as Error)?.message || t('forms.page.publish_failed', 'Could not publish the changes.'));
        } finally {
            setPublishing(false);
        }
    }, [detail, onPublished, t]);

    if (pending <= 0) return null;
    return (
        <>
            <span className="text-[11px] px-2 py-0.5 rounded-full border border-[var(--warning)] text-[var(--warning)]" data-testid="form-page-pending">
                {pending === 1 ? t('forms.page.one_change_not_live', '1 change not live') : t('forms.page.changes_not_live', '{count} changes not live', { count: pending })}
            </span>
            <button type="button" onClick={publish} disabled={publishing || disabled} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border disabled:opacity-50 hover:bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-secondary)]" data-testid="form-page-publish">
                {publishing ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Rocket className="w-3.5 h-3.5" aria-hidden="true" />}{t('forms.page.publish', 'Publish')}
            </button>
        </>
    );
}
