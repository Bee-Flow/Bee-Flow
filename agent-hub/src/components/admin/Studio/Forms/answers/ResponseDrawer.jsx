import { ExternalLink, Loader2, Table2, Workflow } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import useRelativeTime from '../../../../../hooks/useRelativeTime';
import { useTranslation } from '../../../../../hooks/useTranslation';
import Modal from '../../../../shared/Modal';
import { cellText } from '../../Datatables/datatableDisplay';
import { datatablesApi } from '../../Datatables/datatablesApi';

const BTN = 'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border transition-colors hover:bg-[var(--bg-tertiary)]';

/**
 * One response, every question → answer, in the form's order (retired
 * last, flagged). Reads the row itself (the summary carries a preview only).
 */
export default function ResponseDrawer({ datatableId, response, questions, mine, automationId, onNavigate, onClose }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const [row, setRow] = useState(null);
    const [error, setError] = useState(null);
    useEffect(() => {
        let alive = true;
        setRow(null);
        setError(null);
        if (!response?.rowId) return undefined;
        datatablesApi.getRow(datatableId, response.rowId)
            .then((body) => { if (alive) setRow(body?.row || body || null); })
            .catch((e) => { if (alive) setError(e); });
        return () => { alive = false; };
    }, [datatableId, response?.rowId]);

    const when = response?.submittedAt ? rel(response.submittedAt) : '';
    const by = response?.by?.name || (response?.by ? response.by.id : null);
    return (
        <Modal
            open={!!response}
            onClose={onClose}
            placement="right"
            size="md"
            title={t('forms.answers.drawer_title', 'Response')}
            description={[
                when ? t('forms.answers.drawer_submitted', 'Submitted {when}', { when }) : null,
                by ? t('forms.answers.drawer_by', 'by {name}', { name: by }) : t('forms.answers.anonymous', 'Anonymous'),
            ].filter(Boolean).join(' · ')}
            footer={(
                <>
                    <button type="button" onClick={() => onNavigate && onNavigate(`studio/datatables/${datatableId}/rows`)} className={BTN} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}>
                        <Table2 className="w-3 h-3" aria-hidden="true" />{t('forms.answers.drawer_open_row', 'Open in the table')}
                    </button>
                    {mine && response?.runId && automationId && (
                        <button type="button" onClick={() => onNavigate && onNavigate(`studio/automations/${automationId}?run=${encodeURIComponent(response.runId)}`)} className={BTN} style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }} data-testid="drawer-open-run">
                            <Workflow className="w-3 h-3" aria-hidden="true" />{t('forms.answers.drawer_open_run', 'Open the run')}
                        </button>
                    )}
                </>
            )}
        >
            {error && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{error.message}</p>}
            {!row && !error && <div className="flex items-center gap-2 text-xs py-4" style={{ color: 'var(--text-tertiary)' }}><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('datatables.loading', 'Loading…')}</div>}
            {row && (
                <dl className="space-y-3" data-testid="response-answers">
                    {questions.map((q) => {
                        const v = row[q.key];
                        const empty = v === null || v === undefined || v === '';
                        return (
                            <div key={q.key}>
                                <dt className="text-[11px] font-medium" style={{ color: 'var(--text-tertiary)' }}>
                                    {q.label}{q.retired ? ` · ${t('forms.answers.retired_title', 'No longer on the form')}` : ''}
                                </dt>
                                <dd className="text-sm whitespace-pre-wrap break-words" style={{ color: empty ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                                    {empty ? t('forms.answers.drawer_unanswered', 'Not answered') : (q.columnType === 'bool' ? (v ? t('forms.answers.q_yes', 'Yes') : t('forms.answers.q_no', 'No')) : cellText(v, q.columnType))}
                                </dd>
                            </div>
                        );
                    })}
                </dl>
            )}
            {response?.runId && <p className="mt-4 text-[11px]" style={{ color: 'var(--text-tertiary)' }}><ExternalLink className="inline w-3 h-3 mr-1" aria-hidden="true" />{t('forms.answers.drawer_run_id', 'Run {id}', { id: response.runId })}</p>}
        </Modal>
    );
}
