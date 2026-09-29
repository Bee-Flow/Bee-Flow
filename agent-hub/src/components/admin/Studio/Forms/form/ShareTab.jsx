import { Table2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import FormAudienceCard from './FormAudienceCard';
import PublicLinkCard from './PublicLinkCard';
import { useTranslation } from '../../../../../hooks/useTranslation';
import DashCard from '../../../../shared/dashboard/DashCard';
import { datatablesApi } from '../../Datatables/datatablesApi';
import DatatableSharing from '../../Datatables/DatatableSharing';

const LINK_BTN = 'inline-flex items-center gap-1.5 text-xs underline-offset-2 hover:underline';

/**
 * Share: the link, WHO CAN FILL IT IN (the form's audience — people and
 * groups of the organisation, or the whole organisation; never outside it),
 * and WHO SEES THE ANSWERS — which is the answers table's own sharing,
 * reused whole. Sharing the table is what shares the dashboard.
 */
export default function ShareTab({ detail, canEdit, onNavigate, onChanged }) {
    const { t } = useTranslation();
    const answers = detail?.answers || null;
    const [table, setTable] = useState(null);
    const [tableError, setTableError] = useState(null);
    useEffect(() => {
        let alive = true;
        setTable(null);
        setTableError(null);
        if (!answers?.datatableId) return undefined;
        datatablesApi.get(answers.datatableId)
            .then((body) => { if (alive) setTable(body?.datatable || null); })
            .catch((e) => { if (alive) setTableError(e); });
        return () => { alive = false; };
    }, [answers?.datatableId]);

    return (
        <div className="space-y-4" data-testid="form-share">
            <PublicLinkCard form={detail} canEdit={canEdit} onChanged={onChanged} />
            {detail?.audience && <FormAudienceCard form={detail} canEdit={canEdit} onChanged={onChanged} />}
            <DashCard
                title={t('forms.share.answers_title', 'Who can see the answers')}
                action={answers?.datatableId ? (
                    <button type="button" onClick={() => onNavigate && onNavigate(`studio/datatables/${answers.datatableId}`)} className={LINK_BTN} style={{ color: 'var(--text-secondary)' }} data-testid="form-open-table">
                        <Table2 className="w-3 h-3" aria-hidden="true" />{t('forms.share.open_table', 'Open the table')}
                    </button>
                ) : null}
                testId="form-answers-sharing"
            >
                {answers?.datatableId ? (
                    <>
                        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>
                            {t('forms.share.answers_blurb', 'The answers live in a table. Sharing the table is what shares the dashboard: whoever can read the table can open Answers here and the Dashboard tab on the table.')}
                        </p>
                        {table && <DatatableSharing table={table} canEdit={canEdit && table.grade === 'owner'} onChanged={() => datatablesApi.get(answers.datatableId).then(b => setTable(b?.datatable || null)).catch(() => {})} />}
                        {tableError && <p role="alert" className="text-xs" style={{ color: 'var(--error)' }}>{tableError.message}</p>}
                    </>
                ) : (
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {t('forms.share.no_table', 'This form does not collect answers in a table. Switch it on under Settings to share a dashboard.')}
                    </p>
                )}
            </DashCard>
        </div>
    );
}
