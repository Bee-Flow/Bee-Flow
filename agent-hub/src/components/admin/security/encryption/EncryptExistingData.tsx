/**
 * "Encrypt existing data" — starts the server's backfill for the org and shows
 * its live status. Rendered by OrgEncryptionEditor when the SAVED tier is
 * managed or zk. Existing messages stay readable either way; this only
 * encrypts what was stored before the tier was switched on.
 */
import { DatabaseZap } from 'lucide-react';
import React, { useState } from 'react';

import { useBackfillJobQuery, useStartBackfill, type BackfillSurfaceStats } from '../../../../api/queries/encryptionBackfill';
import { useTranslation } from '../../../../hooks/useTranslation';
import ConfirmDialog from '../../../shared/ConfirmDialog';
import { toast } from '../../../shared/Toast';

interface Props {
    orgId: string;
    /** Unsaved tier selection: the buttons wait until it is saved. */
    dirty: boolean;
}

const BTN = 'rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';

function SurfaceLine({ surface, label, st, dryRun }: { surface: string; label: string; st: BackfillSurfaceStats; dryRun: boolean }) {
    const { t } = useTranslation();
    const legacy = surface === 'legacyBlobs';
    const moved = dryRun ? t('admin.encryption.backfill_would_move', 'would move') : t('admin.encryption.backfill_moved', 'moved');
    const removed = dryRun
        ? t('admin.encryption.backfill_would_remove', 'old copies to remove')
        : t('admin.encryption.backfill_removed', 'old copies removed');
    const encrypted = dryRun ? t('admin.encryption.backfill_would_encrypt', 'would encrypt') : t('admin.encryption.backfill_encrypted', 'encrypted');
    return (
        <li data-testid={`backfill-surface-${surface}`}>
            <span className="font-medium">{label}</span>
            {': '}
            {legacy ? `${moved} ${st.migrated ?? 0}, ${removed} ${st.encrypted}` : `${encrypted} ${st.encrypted}`}
            {', '}{t('admin.encryption.backfill_skipped', 'already done')} {st.skipped}
            {', '}{t('admin.encryption.backfill_no_key', 'no key')} {st.noKey}
            {', '}{t('admin.encryption.backfill_failed', 'failed')} {st.failed}
            {st.blocked && ` (${t('admin.encryption.backfill_blocked', 'not run, earlier step had failures')})`}
        </li>
    );
}

export default function EncryptExistingData({ orgId, dirty }: Props) {
    const { t } = useTranslation();
    const [confirmOpen, setConfirmOpen] = useState(false);
    const jobQuery = useBackfillJobQuery(orgId, true);
    const start = useStartBackfill(orgId);
    const job = jobQuery.data;
    const running = job?.status === 'running' || start.isPending;
    const disabled = running || dirty;

    const surfaceLabels: Record<string, string> = {
        messages: t('admin.encryption.surface_messages', 'Chat messages and attachments'),
        conversationTitle: t('admin.encryption.surface_conversation_title', 'Conversation titles'),
        piiTokenMap: t('admin.encryption.surface_pii_token_map', 'Privacy Shield mappings'),
        conversationMeta: t('admin.encryption.surface_conversation_meta', 'Conversation summaries'),
        notebookMessages: t('admin.encryption.surface_notebook_messages', 'Notebook chats'),
        transcripts: t('admin.encryption.surface_transcripts', 'Transcriptions'),
        memories: t('admin.encryption.surface_memories', 'Memory'),
        piiVault: t('admin.encryption.surface_pii_vault', 'Privacy Shield vault'),
        legacyBlobs: t('admin.encryption.surface_legacy_blobs', 'Old plaintext copies of conversations'),
    };
    const labelFor = (s: string) => surfaceLabels[s]
        || s.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

    const run = async (dryRun: boolean) => {
        try {
            await start.mutateAsync({ dryRun });
        } catch (err) {
            toast.error((err as Error).message || t('admin.encryption.backfill_start_failed', 'Could not start the run'));
        }
    };

    const entries = Object.entries(job?.surfaces || {}) as [string, BackfillSurfaceStats][];

    return (
        <section
            className="space-y-3 rounded-lg border border-[var(--border-color)] p-4"
            aria-label={t('admin.encryption.backfill_title', 'Encrypt existing data')}
        >
            <h3 className="flex items-center gap-2 text-base font-semibold">
                <DatabaseZap className="h-4 w-4" aria-hidden="true" />
                {t('admin.encryption.backfill_title', 'Encrypt existing data')}
            </h3>
            <p className="text-sm opacity-75">
                {t(
                    'admin.encryption.backfill_intro',
                    'New messages are already encrypted. This also encrypts what was stored before. Existing messages stay readable either way. It can take a while, so keep a database backup, and note that searching message text in SQL will not work on encrypted rows.',
                )}
            </p>
            <p className="text-sm opacity-75">
                {t(
                    'admin.encryption.backfill_legacy_note',
                    'Old plaintext copies of conversations are removed once they have been encrypted.',
                )}
            </p>
            {dirty && (
                <p className="text-sm text-amber-700 dark:text-amber-300">
                    {t('admin.encryption.backfill_save_first', 'Save your encryption level first.')}
                </p>
            )}
            <div className="flex flex-wrap gap-3">
                <button
                    type="button"
                    onClick={() => run(true)}
                    disabled={disabled}
                    className={`${BTN} border border-[var(--border-color)] hover:bg-black/5 dark:hover:bg-white/5`}
                >
                    {t('admin.encryption.backfill_preview', 'Preview')}
                </button>
                <button
                    type="button"
                    onClick={() => setConfirmOpen(true)}
                    disabled={disabled}
                    className={`${BTN} bg-[var(--accent-primary)] text-white hover:opacity-90`}
                >
                    {t('admin.encryption.backfill_run', 'Encrypt existing data')}
                </button>
            </div>

            {job && job.status !== 'idle' && (
                <div className="space-y-2 text-sm" role="status" aria-live="polite">
                    <p className="font-medium">
                        {job.status === 'running' && (job.dryRun
                            ? t('admin.encryption.backfill_running_preview', 'Preview is running…')
                            : t('admin.encryption.backfill_running', 'Encrypting existing data…'))}
                        {job.status === 'done' && (job.dryRun
                            ? t('admin.encryption.backfill_done_preview', 'Preview finished. Nothing was changed.')
                            : t('admin.encryption.backfill_done', 'Finished.'))}
                        {job.status === 'error' && (job.error || t('admin.encryption.backfill_error', 'The run failed.'))}
                    </p>
                    {entries.length > 0 && (
                        <ul className="space-y-1">
                            {entries.map(([surface, st]) => (
                                <SurfaceLine key={surface} surface={surface} label={labelFor(surface)} st={st} dryRun={!!job.dryRun} />
                            ))}
                        </ul>
                    )}
                </div>
            )}

            <ConfirmDialog
                open={confirmOpen}
                title={t('admin.encryption.backfill_confirm_title', 'Encrypt existing data?')}
                description={t(
                    'admin.encryption.backfill_confirm_desc',
                    'This encrypts everything stored before encryption was switched on. Make sure you have a database backup. It can take a while.',
                )}
                confirmLabel={t('admin.encryption.backfill_run', 'Encrypt existing data')}
                cancelLabel={t('common.cancel', 'Cancel')}
                onConfirm={async () => { setConfirmOpen(false); await run(false); }}
                onCancel={() => setConfirmOpen(false)}
            />
        </section>
    );
}
