import { Lock } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import { useLicenseContext } from '@/components/licensing/LicenseContext';
import { useSetKbQueryLogSettings } from '@/api/queries/kbQueryLog';
import { QueryLogControls, QueryLogDisableChoice, QueryLogEnableText } from './QueryLogCardParts';
import type { KnowledgeBase } from '../knowledgeApi';

/**
 * "Log search queries and answers": Settings tab card for the people who
 * manage a knowledge base. Off by default. Without the `kb_query_log`
 * licence the card is drawn locked with an Enterprise label: the server
 * refuses the routes anyway, the lock only says why.
 *
 * Switching on asks first, with the privacy text; switching off asks
 * whether to keep what is there until the retention term ends (default) or
 * delete it now. The server writes the audit row before it changes anything.
 */
export interface QueryLogCardProps {
    kb: KnowledgeBase | null;
    canManage: boolean;
    onSaved?: () => Promise<void> | void;
}

type Dialog = 'enable' | 'disable' | null;
type T = ReturnType<typeof useTranslation>['t'];

/** After the licence lapsed nothing new is logged, but a manager can still switch off and purge (DELETE route, not licence-gated). */
function UnlicensedPurgeButton({ t, show, busy, onClick }: { t: T; show: boolean; busy: boolean; onClick: () => void }) {
    if (!show) return null;
    return (
        <button
            type="button"
            className="self-start rounded-md border px-3 py-1 text-xs [border-color:var(--border-default)] text-[var(--text-primary)] disabled:opacity-50"
            disabled={busy}
            onClick={onClick}
            data-testid="kb-query-log-purge"
        >
            {t('knowledge.query_log.purge_unlicensed', 'Turn off and delete the log')}
        </button>
    );
}

function readSettings(kb: KnowledgeBase): { enabled: boolean; retention: number } {
    return {
        enabled: !!(kb.queryLogEnabled ?? kb.query_log_enabled),
        retention: Number(kb.queryLogRetentionDays ?? kb.query_log_retention_days) || 90,
    };
}

function DisableDescription({ t, licensed, retention, deleteNow, setDeleteNow }: { t: T; licensed: boolean; retention: number; deleteNow: boolean; setDeleteNow: (v: boolean) => void }) {
    if (licensed) return <QueryLogDisableChoice t={t} retention={retention} deleteNow={deleteNow} setDeleteNow={setDeleteNow} />;
    return <>{t('knowledge.query_log.purge_unlicensed_text', 'Without the Enterprise licence nothing new is logged. This turns the setting off and deletes every logged question and answer of this knowledge base now. This cannot be undone.')}</>;
}

export default function QueryLogCard({ kb, canManage, onSaved }: QueryLogCardProps) {
    const { t } = useTranslation();
    const { hasFeature } = useLicenseContext();
    const save = useSetKbQueryLogSettings(kb?.id ?? '');
    const [dialog, setDialog] = useState<Dialog>(null);
    const [deleteNow, setDeleteNow] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!canManage || !kb?.id) return null;

    const { enabled, retention } = readSettings(kb);
    const licensed = hasFeature('kb_query_log');

    const apply = async (input: Parameters<typeof save.mutateAsync>[0]) => {
        setError(null);
        try {
            await save.mutateAsync(input);
            await onSaved?.();
        } catch (e) {
            setError((e as Error)?.message || t('knowledge.query_log.err_save', 'Could not save the query log settings.'));
        }
        setDialog(null);
        setDeleteNow(false);
    };

    return (
        <section className="flex flex-col gap-2" data-testid="kb-query-log-card" data-locked={licensed ? 'false' : 'true'}>
            <div className="flex items-center gap-2">
                <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {t('knowledge.query_log.title', 'Log search queries and answers')}
                </h3>
                {!licensed && (
                    <span className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium [border-color:var(--border-default)] text-[var(--text-secondary)]" data-testid="kb-query-log-enterprise">
                        <Lock className="w-3 h-3" aria-hidden="true" />
                        {t('knowledge.query_log.enterprise', 'Enterprise')}
                    </span>
                )}
            </div>
            <p className="text-[11px] text-[var(--text-tertiary)]">
                {t('knowledge.query_log.hint', 'Keep the questions asked to this knowledge base, the passages found and the answers given, so its managers can see what is missing. Off by default.')}
            </p>
            {error && <p className="text-xs text-[var(--error)]" role="alert">{error}</p>}
            {licensed && <QueryLogControls t={t} enabled={enabled} retention={retention} busy={save.isPending} onToggle={() => setDialog(enabled ? 'disable' : 'enable')} onRetention={(days) => { if (enabled) void apply({ enabled: true, retentionDays: days }); }} />}
            <UnlicensedPurgeButton t={t} show={!licensed && enabled} busy={save.isPending} onClick={() => { setDeleteNow(true); setDialog('disable'); }} />
            <ConfirmDialog
                open={dialog === 'enable'}
                title={t('knowledge.query_log.enable_title', 'Log questions and answers?')}
                description={<QueryLogEnableText t={t} retention={retention} />}
                confirmLabel={t('knowledge.query_log.enable_confirm', 'Turn logging on')}
                onConfirm={() => apply({ enabled: true, retentionDays: retention })}
                onCancel={() => setDialog(null)}
            />
            <ConfirmDialog
                open={dialog === 'disable'}
                title={t('knowledge.query_log.disable_title', 'Turn logging off?')}
                description={<DisableDescription t={t} licensed={licensed} retention={retention} deleteNow={deleteNow} setDeleteNow={setDeleteNow} />}
                confirmLabel={deleteNow ? t('knowledge.query_log.disable_delete', 'Turn off and delete') : t('knowledge.query_log.disable_keep', 'Turn off')}
                destructive={deleteNow}
                onConfirm={() => apply({ enabled: false, retentionDays: retention, deleteExisting: deleteNow })}
                onCancel={() => { setDialog(null); setDeleteNow(false); }}
            />
        </section>
    );
}
