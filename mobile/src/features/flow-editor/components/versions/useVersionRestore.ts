/**
 * Restore a saved version, after asking — the web panel's onRestore: the
 * confirmation says the current definition is replaced, the restore runs
 * through useRestoreVersion (save first, then one undo step), and which
 * version is restoring is known so its row and the sheet can say so.
 */

import { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import type { FlowVersionSummary } from '@/features/flow-editor/api';
import { useRestoreVersion } from '@/features/flow-editor/hooks';
import { useConfirm } from '@/shared/patterns';
import { useToast } from '@/shared/ui';

export function useVersionRestore(flowKey: string, onRestored: () => void) {
    const t = useTranslation();
    const confirm = useConfirm();
    const { toast } = useToast();
    const [restoringId, setRestoringId] = useState<string | null>(null);
    const restore = useRestoreVersion(flowKey, {
        onSuccess: (result) => {
            setRestoringId(null);
            onRestored();
            toast(t('mobile.flow.versions.restored', 'Restored v{n}', { n: result.restoredFromVersion ?? '—' }), 'success');
        },
        onError: (err) => {
            setRestoringId(null);
            toast(describeError(err).message, 'error');
        },
    });
    const request = async (v: FlowVersionSummary) => {
        if (restoringId) return;
        const ok = await confirm({
            title: t('mobile.flow.versions.restore_title', 'Restore version {n}?', { n: v.version }),
            message: t('mobile.flow.versions.restore_message', 'The automation goes back to how it looked then; the current definition is replaced.'),
            confirmLabel: t('automation_editor.version_restore', 'Restore'),
        });
        if (!ok) return;
        setRestoringId(v.id);
        restore.mutate(v.id);
    };
    return { restoringId, restore: (v: FlowVersionSummary) => void request(v) };
}
