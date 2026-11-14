import React, { useState } from 'react';
import { useSupportCannedResponsesQuery } from '@/api/queries/supportPanels';
import { Plus, Trash2, Save } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import type { CannedResponse } from '../SupportInboxPanel.types';
import { errorMessage } from '@/utils/caughtError';
import { ApiError, RefusedError, errorBody } from '@/api/mutate';
import SectionHeader from '@/components/shared/SectionHeader';
import { FIELD_INPUT, SettingsList } from '@/components/shared/SettingsList';
import { ALERT_ERROR, CARD, CHIP, PRIMARY_BTN, QUIET_BTN } from '@/components/mcpLibrary/ui';
import { apiRequest } from '@/api/typedRequest';

const VARS = ['{{requester_name}}', '{{requester_email}}', '{{org_name}}', '{{thread_subject}}', '{{staff_first_name}}'];

const EMPTY_CANNED: CannedResponse[] = [];

export default function SupportCannedResponsesTab() {
    const { t } = useTranslation();
    const [actionError, setError] = useState<string | null | undefined>(null);
    const [draft, setDraft] = useState({ title: '', shortcut: '', body: '' });
    const [busy, setBusy] = useState(false);

    const cannedQuery = useSupportCannedResponsesQuery<CannedResponse>();
    const items = cannedQuery.data ?? EMPTY_CANNED;
    const load = async () => { await cannedQuery.refetch(); };
    const error = actionError ?? (cannedQuery.isError ? errorMessage(cannedQuery.error) : null);

    const create = async () => {
        if (!draft.title.trim() || !draft.body.trim()) return;
        setBusy(true); setError(null);
        try {
            try {
                await apiRequest('POST /api/support/canned', { body: draft });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const e = errorBody(err) ?? {};
                throw new Error(e.error || 'Create failed');
            }
            setDraft({ title: '', shortcut: '', body: '' });
            await load();
        } catch (e) { setError(errorMessage(e)); }
        finally { setBusy(false); }
    };

    const remove = async (id: string) => {
        const res = await apiRequest('DELETE /api/support/canned/{id}', { params: { id } }).catch((err: unknown) => {
            if (err instanceof ApiError) return null;
            throw err;
        });
        if (res) await load();
    };

    return (
        <div className="flex max-w-4xl flex-col gap-6 p-6">
            <SectionHeader
                title={t('support.support_canned_responses_canned_responses', 'Canned responses')}
                description={<>{t('support.support_canned_responses_reusable_reply_templates_staff_insert', 'Reusable reply templates. Staff insert them with the')} <code>/</code> {t('support.support_canned_responses_picker_in_the_composer_variables_are', 'picker in the composer. Variables are substituted on send: {value}.', { value: VARS.join(' ') })}</>}
            />
            {error && <div className={ALERT_ERROR}>{error}</div>}

            <div className={CARD}>
                <div className="flex gap-2">
                    <input value={draft.title} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, title: e.target.value })} placeholder={t('support.support_canned_responses_title', 'Title')}
                        className={`${FIELD_INPUT} flex-1`} />
                    <input value={draft.shortcut} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDraft({ ...draft, shortcut: e.target.value })} placeholder="/shortcut"
                        className={`${FIELD_INPUT.replace('w-full ', '')} w-32 font-mono`} />
                </div>
                <textarea value={draft.body} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setDraft({ ...draft, body: e.target.value })} rows={3} placeholder={t('support.support_canned_responses_template_body_use_variables_like', 'Template body — use variables like {{requester_name}}')}
                    className={`${FIELD_INPUT} resize-y`} />
                <div className="flex justify-end">
                    <button type="button" onClick={create} disabled={busy || !draft.title.trim() || !draft.body.trim()} className={PRIMARY_BTN}>
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {t('support.support_canned_responses_add_template', 'Add template')}
                    </button>
                </div>
            </div>

            <TemplateList items={items} onRemove={remove} />
        </div>
    );
}

/** The saved templates, one row each. */
function TemplateList({ items, onRemove }: { items: CannedResponse[]; onRemove: (id: string) => void }) {
    const { t } = useTranslation();
    if (items.length === 0) {
        return <p className="m-0 text-xs text-[var(--text-tertiary)]">{t('support.support_canned_responses_no_templates_yet', 'No templates yet.')}</p>;
    }
    return (
        <SettingsList>
            {items.map((c: CannedResponse) => (
                <div key={c.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--text-primary)]">
                            <span className="truncate">{c.title}</span>
                            {c.shortcut && <span className={`${CHIP} font-mono`}>{c.shortcut}</span>}
                            {c.organization_id == null && <span className="text-xs font-normal text-[var(--text-tertiary)]">{t('support.support_canned_responses_system', 'system')}</span>}
                        </div>
                        <button type="button" onClick={() => onRemove(c.id)} className={`${QUIET_BTN} hover:text-[var(--error-ink)]`} aria-label={t('support.tabs_delete', 'Delete')}>
                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </div>
                    <div className="mt-1 whitespace-pre-wrap text-xs text-[var(--text-secondary)]">{c.body}</div>
                </div>
            ))}
        </SettingsList>
    );
}
