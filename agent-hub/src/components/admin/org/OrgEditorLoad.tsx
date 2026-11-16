// The load states the organisation AI editors share (long conversations,
// memory, AI that joins, editing together, answer reuse): a loading line while
// the first read is out, and a failed read said in the error colours with a
// retry, never the defaults shown as if they were saved.

import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import Button from '@/components/shared/Button';
import LoadingState from '@/components/shared/LoadingState';
import { ALERT_ERROR } from '@/components/shared/adminUi';

interface OrgEditorLoadProps {
    /** The first read is out (a refetch after a save keeps the form on screen). */
    loading: boolean;
    /** The read failed: the editor's own sentence, plus the server's text where it has one. */
    error: ReactNode | null;
    onRetry: () => void;
    children: ReactNode;
}

export default function OrgEditorLoad({ loading, error, onRetry, children }: OrgEditorLoadProps) {
    const { t } = useTranslation();
    return (
        <LoadingState
            loading={loading}
            error={error || null}
            loadingFallback={(
                <div role="status" className="flex items-center gap-2 py-2 text-sm text-[var(--text-secondary)]">
                    <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                    {t('common.loading', 'Loading...')}
                </div>
            )}
            errorFallback={() => (
                <div role="alert" className={ALERT_ERROR}>
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                    <span className="flex-1 text-sm">{error}</span>
                    <Button variant="secondary" size="sm" onClick={onRetry}>{t('admin_org_ai.retry', 'Try again')}</Button>
                </div>
            )}
        >
            {children}
        </LoadingState>
    );
}
