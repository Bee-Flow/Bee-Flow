import React, { useState } from 'react';
import { useSupportTagTaxonomyQuery } from '@/api/queries/supportPanels';
import { Plus, Trash2 } from 'lucide-react';
import { API_BASE } from '@/utils/helpers';
import { useTranslation } from '@/hooks/useTranslation';
import { errorMessage } from '@/utils/caughtError';
import { mutate, ApiError, RefusedError, errorBody } from '@/api/mutate';
import SectionHeader from '@/components/shared/SectionHeader';
import { FIELD_INPUT } from '@/components/shared/SettingsList';
import { ALERT_ERROR, CHIP, PRIMARY_BTN } from '@/components/mcpLibrary/ui';

interface SupportTag {
    id: string;
    name: string;
    color?: string | null;
    organization_id?: string | null;
}

const EMPTY_TAGS: SupportTag[] = [];

export default function SupportTagsTab() {
    const { t } = useTranslation();
    const [name, setName] = useState('');
    const [color, setColor] = useState('#64748b');
    const [actionError, setError] = useState<string | null | undefined>(null);
    const [busy, setBusy] = useState(false);

    const tagsQuery = useSupportTagTaxonomyQuery<SupportTag>();
    const tags = tagsQuery.data ?? EMPTY_TAGS;
    const load = async () => { await tagsQuery.refetch(); };
    const error = actionError ?? (tagsQuery.isError ? errorMessage(tagsQuery.error) : null);

    const create = async () => {
        if (!name.trim()) return;
        setBusy(true); setError(null);
        try {
            try {
                await mutate(`${API_BASE}/api/support/tags`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: name.trim(), color }),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const e = errorBody(err) ?? {};
                throw new Error(e.error || 'Create failed');
            }
            setName('');
            await load();
        } catch (e) { setError(errorMessage(e)); }
        finally { setBusy(false); }
    };

    const remove = async (id: string) => {
        const res = await mutate(`${API_BASE}/api/support/tags/${id}`, { method: 'DELETE' }).catch((err: unknown) => {
            if (err instanceof ApiError) return null;
            throw err;
        });
        if (res) await load();
    };

    return (
        <div className="flex max-w-4xl flex-col gap-6 p-6">
            <SectionHeader
                title={t('support.support_tags_tag_taxonomy', 'Tag taxonomy')}
                description={t('support.support_tags_the_catalogue_of_tags_the_ai_may_auto', 'The catalogue of tags the AI may auto-assign and staff can apply to threads.')}
            />
            {error && <div className={ALERT_ERROR}>{error}</div>}

            <div className="flex items-center gap-2">
                <input value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && create()} placeholder={t('support.support_tags_new_tag_name', 'New tag name')}
                    className={`${FIELD_INPUT} flex-1`} />
                {/* The tag's own colour: data the admin picks. */}
                <input type="color" value={color} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setColor(e.target.value)} aria-label={t('support.tabs_tag_colour', 'Tag colour')} className="h-8 w-9 shrink-0 cursor-pointer rounded-md border border-[var(--border-default)] bg-transparent p-0.5" />
                <button type="button" onClick={create} disabled={busy || !name.trim()} className={PRIMARY_BTN}>
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {t('support.support_tags_add', 'Add')}
                </button>
            </div>

            <div className="flex flex-wrap gap-2">
                {tags.length === 0 && <p className="m-0 text-xs text-[var(--text-tertiary)]">{t('support.support_tags_no_tags_yet', 'No tags yet.')}</p>}
                {tags.map((tag: SupportTag) => (
                    <span key={tag.id} className={`${CHIP} gap-1.5 py-1 text-xs`}>
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: tag.color || '#64748b' }} />
                        #{tag.name}
                        {tag.organization_id == null && <span className="text-[var(--text-tertiary)]">{t('support.support_tags_system', '(system)')}</span>}
                        <button type="button" onClick={() => remove(tag.id)} className="rounded text-[var(--text-tertiary)] hover:text-[var(--error-ink)]" aria-label={t('support.tabs_delete', 'Delete')}><Trash2 className="h-3 w-3" aria-hidden="true" /></button>
                    </span>
                ))}
            </div>
        </div>
    );
}
