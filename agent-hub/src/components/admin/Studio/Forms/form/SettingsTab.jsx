import { Table2, Timer } from 'lucide-react';
import React, { useState } from 'react';
import useAutomationApi from '../../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DangerZone from '../../../../shared/DangerZone';
import DashCard from '../../../../shared/dashboard/DashCard';
import Toggle from '../../../../shared/Toggle';
import useConfirm from '../../../../shared/useConfirm';

const LINK_BTN = 'inline-flex items-center gap-1.5 text-xs underline-offset-2 hover:underline';

/**
 * Settings: live or not, collect the answers in a table or not, where the
 * answers' retention lives, and the danger zone (the automation goes, the
 * answers table stays as an ordinary table).
 */
export default function SettingsTab({ detail, save, reload, onNavigate, onBack }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const { confirm, confirmDialog } = useConfirm();
    const [liveBusy, setLiveBusy] = useState(false);
    const [liveError, setLiveError] = useState(null);
    const [collectBusy, setCollectBusy] = useState(false);
    const [collectError, setCollectError] = useState(null);
    const answers = detail?.answers || null;
    const collecting = !!detail?.questions?.collect;

    const setLive = async (next) => {
        setLiveBusy(true);
        setLiveError(null);
        try {
            if (next) await api.activate(detail.automationId); else await api.deactivate(detail.automationId);
            await reload();
        } catch (e) {
            setLiveError(e?.message || t('forms.settings.live_failed', 'Could not switch the form on.'));
        } finally {
            setLiveBusy(false);
        }
    };

    const setCollect = async (next) => {
        if (!next) {
            const ok = await confirm({
                title: t('forms.settings.stop_title', 'Stop collecting?'),
                description: t('forms.settings.stop_body', 'New submissions no longer land in the table. The table, its rows and its sharing stay as they are.'),
                confirmLabel: t('forms.settings.stop_confirm', 'Stop collecting'),
                cancelLabel: t('forms.new.cancel', 'Cancel'),
                destructive: true,
            });
            if (!ok) return;
        }
        setCollectBusy(true);
        setCollectError(null);
        try {
            await save({ collect: next });
        } catch (e) {
            setCollectError(e?.message || t('forms.page.save_failed', 'Could not save the form.'));
        } finally {
            setCollectBusy(false);
        }
    };

    return (
        <div className="space-y-4" data-testid="form-settings">
            <DashCard title={t('forms.settings.live_title', 'Live')} testId="form-live-card">
                <Toggle
                    checked={!!detail?.isActive}
                    onChange={setLive}
                    disabled={liveBusy}
                    label={t('forms.settings.live_toggle', 'Form is live')}
                    description={detail?.isActive
                        ? t('forms.status.live_hint', 'Colleagues in your organisation can fill this in after signing in.')
                        : t('forms.settings.live_off_blurb', 'Switched off: the link answers “not available” and nothing is collected.')}
                    id="form-live"
                />
                {liveError && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--error)' }}>{liveError}</p>}
            </DashCard>

            <DashCard
                title={t('forms.settings.collect_title', 'Collect answers in a table')}
                action={answers?.datatableId ? (
                    <button type="button" onClick={() => onNavigate && onNavigate(`studio/datatables/${answers.datatableId}`)} className={LINK_BTN} style={{ color: 'var(--text-secondary)' }} data-testid="form-settings-open-table">
                        <Table2 className="w-3 h-3" aria-hidden="true" />{t('forms.share.open_table', 'Open the table')}
                    </button>
                ) : null}
                testId="form-collect-card"
            >
                <Toggle
                    checked={collecting}
                    onChange={setCollect}
                    disabled={collectBusy}
                    label={t('forms.settings.collect_toggle', 'Collect answers in a table')}
                    description={collecting
                        ? t('forms.settings.collect_on', 'On — every submission becomes a row in the answers table.')
                        : t('forms.settings.collect_off_blurb', 'Switch on to create a table with one column per question. Earlier submissions are not imported; collecting starts with the next one.')}
                    id="form-collect"
                />
                {collecting && answers && !answers.datatableId && (
                    <p className="text-xs mt-2" style={{ color: 'var(--warning-ink)' }} data-testid="form-collect-pending">
                        {answers.error?.message || t('forms.settings.collect_pending', 'The table is not there yet — save the form once more, or try again.')}{' '}
                        <button type="button" className="underline" onClick={async () => { try { await api.provisionAnswersTable(detail.automationId); await reload(); } catch (e) { setCollectError(e?.message || ''); } }}>
                            {t('forms.answers.retry', 'Try again')}
                        </button>
                    </p>
                )}
                {answers?.lastWriteError && (
                    <p role="alert" className="text-xs mt-2" style={{ color: 'var(--error)' }} data-testid="form-write-error">
                        {t('forms.settings.write_error', 'The last submission could not be written to the table: {message}', { message: answers.lastWriteError.message || answers.lastWriteError.code })}
                    </p>
                )}
                {collectError && <p role="alert" className="text-xs mt-2" style={{ color: 'var(--error)' }}>{collectError}</p>}
            </DashCard>

            {answers?.datatableId && (
                <DashCard title={t('forms.settings.retention_title', 'How long answers are kept')} testId="form-retention-card">
                    <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                        {t('forms.settings.retention_blurb', 'Answers stay in the table until a retention window is set on it.')}
                    </p>
                    <button type="button" onClick={() => onNavigate && onNavigate(`studio/datatables/${answers.datatableId}/retention`)} className={LINK_BTN} style={{ color: 'var(--text-secondary)' }}>
                        <Timer className="w-3 h-3" aria-hidden="true" />{t('forms.settings.retention_open', 'Open the table’s retention settings')}
                    </button>
                </DashCard>
            )}

            <DangerZone
                entityName={detail?.title || ''}
                kindLabel={t('forms.settings.kind_word', 'form')}
                openLabel={t('forms.settings.delete_open', 'Delete this form')}
                requireName
                notice={t('forms.settings.delete_notice', 'Deleting the form deletes the automation behind it. The answers table is not deleted — remove it under Datatables if the answers are no longer needed.')}
                onDelete={async () => { await api.deleteAutomation(detail.automationId); if (onBack) onBack(); }}
            />
            {confirmDialog}
        </div>
    );
}
