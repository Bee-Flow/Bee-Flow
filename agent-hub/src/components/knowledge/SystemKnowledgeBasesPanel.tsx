import { useCallback, useState } from 'react';
import { BookOpen, CheckCircle2, Circle, Loader2, RefreshCw, ShieldCheck } from 'lucide-react';
import { useSystemKnowledgeBases } from '../../api/queries/systemKnowledgeBases';
import { TranslateParams, useTranslation } from '../../hooks/useTranslation';
import { ApiError, RefusedError } from '../../api/mutate';
import { apiRequest } from '@/api/typedRequest';

interface SystemKb {
    id: string;
    name?: string;
    description?: string;
    icon?: string;
    system_slug?: string;
    betaFeatureId?: string;
    enabledForOrg?: boolean;
    allowedForOrg?: boolean;
    superAdminBypass?: boolean;
    documentCount?: number;
    totalChunks?: number;
    updatedAt?: string;
}

const NO_ITEMS: SystemKb[] = [];

const SystemKnowledgeBasesPanel = () => {
    const { t } = useTranslation();
    const listQuery = useSystemKnowledgeBases<SystemKb>();
    const items = listQuery.data?.items ?? NO_ITEMS;
    const orgId = listQuery.data?.orgId ?? null;
    const isSuperAdmin = listQuery.data?.isSuperAdmin ?? false;
    const loading = listQuery.isFetching;
    const [toggling, setToggling] = useState<string | null>(null);
    const [actionError, setError] = useState<string | null>(null);
    const error = actionError ?? (listQuery.isError ? (listQuery.error.message || 'Load failed') : null);

    const { refetch } = listQuery;
    const load = useCallback(async () => {
        setError(null);
        await refetch();
    }, [refetch]);

    const toggle = async (item: SystemKb) => {
        if (!item.betaFeatureId || toggling) return;
        if (!orgId) {
            setError('No organisation to toggle on. Create an organisation first.');
            return;
        }
        setToggling(item.betaFeatureId);
        try {
            const goingOn = !item.enabledForOrg;

            // Super-admins can write the allow-list too. When enabling, make
            // sure the slug is in the org's super-admin allow-list before we
            // try to write the active subset — /auth/me/active-features
            // silently drops anything not in the allow-list.
            if (isSuperAdmin && goingOn && !item.allowedForOrg) {
                let cur: Response;
                try {
                    cur = await apiRequest('GET /auth/beta-features');
                } catch (apiErr) {
                    if (!(apiErr instanceof RefusedError)) throw apiErr;
                    throw new Error('Could not read allow-list');
                }
                const curJ = await cur.json();
                const current = (curJ.assignments && curJ.assignments[orgId]) || [];
                const nextAllow = current.includes(item.betaFeatureId)
                    ? current
                    : [...current, item.betaFeatureId];
                try {
                    await apiRequest('PUT /auth/organizations/{orgId}/beta-features', { params: { orgId }, body: { features: nextAllow } });
                } catch (err) {
                    if (!(err instanceof ApiError)) throw err;
                    throw new Error('Could not grant feature to organisation');
                }
            }

            // Flip the org-admin active subset (the toggle every user sees).
            let cur: Response;
            try {
                cur = await apiRequest('GET /auth/me/active-features');
            } catch (apiErr) {
                if (!(apiErr instanceof RefusedError)) throw apiErr;
                throw new Error('Could not read current features');
            }
            const curJ = await cur.json();
            const active = new Set(Array.isArray(curJ.enabledBetaFeatures) ? curJ.enabledBetaFeatures : []);
            if (goingOn) active.add(item.betaFeatureId);
            else active.delete(item.betaFeatureId);
            try {
                await apiRequest('PUT /auth/me/active-features', { body: { betaEnabled: Array.from(active) as string[] } });
            } catch (err) {
                if (!(err instanceof ApiError)) throw err;
                throw new Error('Save failed');
            }
            await load();
        } catch (e) {
            setError((e as Error).message || 'Toggle failed');
        } finally {
            setToggling(null);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2 p-6 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="text-sm">{t('knowledge.system_knowledge_bases_loading_system_knowledge_bases', 'Loading system knowledge bases…')}</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="p-4 rounded-lg border [border-color:rgba(239,68,68,0.3)] [background:rgba(239,68,68,0.05)] [color:rgb(239,68,68)]">
                <div className="flex items-center justify-between">
                    <span className="text-sm">{error}</span>
                    <button onClick={load} className="text-xs underline">{t('knowledge.system_knowledge_bases_retry', 'Retry')}</button>
                </div>
            </div>
        );
    }

    if (items.length === 0) {
        return (
            <div className="p-6 rounded-lg border text-center border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-muted)]">
                <BookOpen className="w-6 h-6 mx-auto mb-2 opacity-50" />
                <div className="text-sm">{t('knowledge.system_knowledge_bases_no_system_knowledge_bases_have_been', 'No system knowledge bases have been provisioned yet.')}</div>
            </div>
        );
    }

    return (
        <div className="space-y-3">
            <SystemKnowledgeBasesPanelSection2 t={t} load={load} />

            <SystemKnowledgeBasesPanelSection items={items} toggling={toggling} t={t} toggle={toggle} orgId={orgId} />
        </div>
    );
};

export default SystemKnowledgeBasesPanel;

function SystemKnowledgeBasesPanelSection2({ t, load }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; load: () => Promise<void>; }) {
    return <div className="flex items-center justify-between">
        <div>
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
                {t('knowledge.system_knowledge_bases_system_knowledge_bases', 'System knowledge bases')}
            </h3>
            <p className="text-xs mt-0.5 text-[var(--text-muted)]">
                {t('knowledge.system_knowledge_bases_read_only_collections_maintained_by', 'Read-only collections maintained by Bee Flow. Toggle a collection on to make it available to your agents and chat — same picker as your own KBs.')}
            </p>
        </div>
        <button
            onClick={load}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors text-[var(--text-muted)] bg-[var(--bg-tertiary)]"
            title={t('knowledge.system_knowledge_bases_refresh_status', 'Refresh status')}
        >
            <RefreshCw className="w-3.5 h-3.5" />
            {t('knowledge.system_knowledge_bases_refresh', 'Refresh')}
        </button>
    </div>;
}

function SystemKnowledgeBasesPanelSection({ items, toggling, t, toggle, orgId }: { items: SystemKb[]; toggling: string | null; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; toggle: (item: SystemKb) => Promise<void>; orgId: string | null; }) {
    return <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {items.map(item => {
            const isOn = !!item.enabledForOrg;
            const isBusy = toggling === item.betaFeatureId;
            return (
                <div
                    key={item.id}
                    className="rounded-lg border p-4 flex flex-col gap-3"
                    style={{
                        borderColor: isOn ? 'var(--accent-primary)' : 'var(--border-subtle)',
                        background: 'var(--bg-secondary)',
                    }}
                >
                    <div className="flex items-start gap-3">
                        <div className="text-2xl shrink-0">{item.icon || '📚'}</div>
                        <div className="flex-1 min-w-0">
                            <div className="font-medium text-[var(--text-primary)]">{item.name}</div>
                            {item.description && (
                                <div className="text-xs mt-1 text-[var(--text-muted)]">
                                    {item.description}
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="flex items-center gap-3 text-xs flex-wrap text-[var(--text-muted)]">
                        <span>{item.documentCount === 1 ? t('knowledge.system_knowledge_bases_document_one', '{count} document', { count: 1 }) : t('knowledge.system_knowledge_bases_document_other', '{count} documents', { count: item.documentCount })}</span>
                        <span>·</span>
                        <span>{item.totalChunks === 1 ? t('knowledge.system_knowledge_bases_chunk_one', '{count} chunk', { count: 1 }) : t('knowledge.system_knowledge_bases_chunk_other', '{count} chunks', { count: item.totalChunks })}</span>
                        {item.updatedAt && (
                            <>
                                <span>·</span>
                                <span title={item.updatedAt}>{t('knowledge.system_knowledge_bases_updated', 'Updated {date}', { date: new Date(item.updatedAt).toLocaleDateString() })}</span>
                            </>
                        )}
                    </div>

                    <div className="flex items-center justify-between pt-1 gap-2 flex-wrap">
                        <button
                            onClick={() => toggle(item)}
                            disabled={isBusy || !item.betaFeatureId || !orgId}
                            className="flex items-center gap-2 text-sm font-medium"
                            style={{ color: isOn ? 'var(--accent-primary)' : 'var(--text-secondary)', cursor: (!item.betaFeatureId || !orgId) ? 'not-allowed' : 'pointer' }}
                            title={!orgId ? 'No organisation to toggle on' : (isOn ? 'Click to disable for this organisation' : 'Click to enable for this organisation')}
                        >
                            {isBusy ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                            ) : isOn ? (
                                <CheckCircle2 className="w-4 h-4" />
                            ) : (
                                <Circle className="w-4 h-4" />
                            )}
                            {isOn ? 'Enabled for organisation' : 'Disabled for organisation'}
                        </button>
                        {/* Super-admin always has access via their bypass; surface that
                        explicitly so they aren't confused by a "Disabled" label. */}
                        {item.superAdminBypass && !isOn && (
                            <span
                                className="flex items-center gap-1 text-xs text-[var(--accent-primary)]"
                                title={t('knowledge.system_knowledge_bases_as_a_global_admin_you_can_use_this', 'As a global admin, you can use this knowledge base in your own chats regardless of organisation toggle.')}
                            >
                                <ShieldCheck className="w-3.5 h-3.5" />
                                {t('knowledge.system_knowledge_bases_available_to_you_super_admin', 'Available to you (super-admin)')}
                            </span>
                        )}
                    </div>
                </div>
            );
        })}
    </div>;
}
