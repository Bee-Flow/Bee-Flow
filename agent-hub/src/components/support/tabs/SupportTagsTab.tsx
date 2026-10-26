import React, { useState } from 'react';
import { useSupportTagTaxonomyQuery } from '../../../api/queries/supportPanels';
import { Plus, Trash2 } from 'lucide-react';
import { API_BASE } from '../../../utils/helpers';
import { useTranslation } from '../../../hooks/useTranslation';
import { errorMessage } from '../../../utils/caughtError';
import { mutate, ApiError, RefusedError, errorBody } from '../../../api/mutate';

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
        <div className="max-w-2xl mx-auto p-4">
            <h3 className="text-sm font-semibold mb-1 text-[var(--text-primary)]">{t('support.support_tags_tag_taxonomy', 'Tag taxonomy')}</h3>
            <p className="text-xs mb-4 text-[var(--text-muted)]">
                {t('support.support_tags_the_catalogue_of_tags_the_ai_may_auto', 'The catalogue of tags the AI may auto-assign and staff can apply to threads.')}
            </p>
            {error && <div className="text-xs mb-3 px-3 py-2 rounded [background:rgba(220,38,38,0.08)] [color:#dc2626]!">{error}</div>}

            <div className="flex items-center gap-2 mb-4">
                <input value={name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setName(e.target.value)} onKeyDown={(e: React.KeyboardEvent) => e.key === 'Enter' && create()} placeholder={t('support.support_tags_new_tag_name', 'New tag name')}
                    className="flex-1 px-2 py-1.5 rounded border text-sm [background:var(--bg-secondary)] [border-color:var(--border-default)] [color:var(--text-primary)]!" />
                <input type="color" value={color} onChange={(e: React.ChangeEvent<HTMLInputElement>) => setColor(e.target.value)} className="w-9 h-9 rounded border [border-color:var(--border-default)]" />
                <button onClick={create} disabled={busy || !name.trim()} className="px-3 py-1.5 rounded-md text-sm flex items-center gap-1.5 disabled:opacity-50 [background:var(--accent-primary)] [color:white]!">
                    <Plus className="w-3.5 h-3.5" /> {t('support.support_tags_add', 'Add')}
                </button>
            </div>

            <div className="flex flex-wrap gap-2">
                {tags.length === 0 && <div className="text-xs text-[var(--text-muted)]">{t('support.support_tags_no_tags_yet', 'No tags yet.')}</div>}
                {tags.map((tag: SupportTag) => (
                    <span key={tag.id} className="text-sm px-2 py-1 rounded inline-flex items-center gap-1.5 border border-[var(--border-default)] text-[var(--text-secondary)]">
                        <span className="w-2.5 h-2.5 rounded-full" style={{ background: tag.color || '#64748b' }} />
                        #{tag.name}
                        {tag.organization_id == null && <span className="text-xs text-[var(--text-muted)]">{t('support.support_tags_system', '(system)')}</span>}
                        <button onClick={() => remove(tag.id)} className="opacity-60 hover:opacity-100 [color:#dc2626]"><Trash2 className="w-3 h-3" /></button>
                    </span>
                ))}
            </div>
        </div>
    );
}
