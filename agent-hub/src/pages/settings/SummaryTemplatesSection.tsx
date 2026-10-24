import React, { useCallback, useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import useTranslation from '../../hooks/useTranslation';
import * as api from '../../api/transcriptionsApi';
import TemplateManager from '../meeting-notes/detail/TemplateManager';
import type { SummaryTemplates } from '../meeting-notes/detail/summaryTemplates.types';

/**
 * Personal "My summary templates" settings. Lets any user author and save their
 * own Meeting Notes summary styles, and mark one as their default for new
 * meetings. Self-hides when Meeting Notes isn't licensed (the API 403/404s).
 */
export default function SummaryTemplatesSection() {
    const { t } = useTranslation();
    const [data, setData] = useState<SummaryTemplates | null>(null);
    const [available, setAvailable] = useState(true);
    const [loading, setLoading] = useState(true);

    const reload = useCallback(async () => {
        try {
            const res = await api.listSummaryTemplates();
            setData(res);
        } catch (_) {
            setAvailable(false);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { reload(); }, [reload]);

    if (loading) return null;
    if (!available) return null;

    const mine = (data?.custom || []).filter((tpl) => tpl.scope === 'user');

    return (
        <div>
            <div className="flex items-center gap-2 mb-2">
                <FileText className="w-4 h-4 text-[var(--accent-primary)]" />
                <p className="text-[11px] font-semibold uppercase tracking-widest text-[var(--text-muted)]">
                    {t('meeting_notes.template_personal_title', 'My summary templates')}
                </p>
            </div>
            <p className="text-[12px] mb-3 text-[var(--text-muted)]">
                {t('meeting_notes.template_personal_desc', 'Save your own summary styles for Meeting Notes. Pick one from the Regenerate menu, or set a default that new meetings use automatically.')}
            </p>

            <TemplateManager
                templates={mine}
                builtins={data?.builtins || []}
                canManageOrg={false}
                defaultScope="user"
                emptyHint={t('meeting_notes.template_personal_empty', 'You haven\'t saved any templates yet.')}
                onReload={reload}
            />
        </div>
    );
}
