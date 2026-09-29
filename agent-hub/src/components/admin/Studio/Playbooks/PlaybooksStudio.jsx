import { AlertTriangle, Clapperboard, Loader2, Plus } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import NewPlaybookDialog from './NewPlaybookDialog';
import PlaybookCard from './PlaybookCard';
import PlaybookRun from './PlaybookRun';
import { playbooksApi } from './playbooksApi';
import useTranslation from '../../../../hooks/useTranslation';
import EmptyState from '../../../shared/EmptyState';
import { kindTileStyle } from '../../../shared/kindColors';
import StudioSectionHeader, { PRIMARY_ACTION_STYLE } from '../../../shared/StudioSectionHeader';

/**
 * Studio → Playbooks. A playbook is a phased AI build the person watches as
 * a film and consents to phase by phase (server/routes/playbooks.js owns the
 * entity). This section is the list; an open playbook is `PlaybookRun`,
 * fullscreen like an open app (onEditingChange).
 *
 * Deep links: /app/studio/playbooks/<id> opens one, /app/studio/playbooks/new
 * opens the dialog (the Datatables cue). Adopts changes INCLUDING to null.
 */
export default function PlaybooksStudio({ user = null, hasPermission = () => true, initialPlaybookId = null, onNavigate = null, onEditingChange = () => {} }) {
    const { t } = useTranslation();
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);
    const [openId, setOpenId] = useState(initialPlaybookId && initialPlaybookId !== 'new' ? initialPlaybookId : null);
    const [creating, setCreating] = useState(initialPlaybookId === 'new');

    const canManage = hasPermission('manage_apps');

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const body = await playbooksApi.list();
            setItems(Array.isArray(body?.playbooks) ? body.playbooks : []);
        } catch (e) {
            setError(e.message || t('playbooks.err_list', 'Could not load your playbooks'));
            setItems([]);
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => { load(); }, [load]);

    const lastInitial = useRef(initialPlaybookId);
    useEffect(() => {
        if (initialPlaybookId !== lastInitial.current) {
            lastInitial.current = initialPlaybookId;
            if (initialPlaybookId === 'new') { setCreating(true); setOpenId(null); }
            else { setOpenId(initialPlaybookId || null); setCreating(false); }
        }
    }, [initialPlaybookId]);

    // Fullscreen while a playbook is open (an open app does the same).
    const editingRef = useRef(onEditingChange);
    useEffect(() => { editingRef.current = onEditingChange; });
    useEffect(() => {
        editingRef.current?.(!!openId);
        return () => { editingRef.current?.(false); };
    }, [openId]);

    const open = useCallback((id) => {
        setOpenId(id);
        setCreating(false);
        if (onNavigate) onNavigate(id ? `studio/playbooks/${id}` : 'studio/playbooks');
    }, [onNavigate]);

    const startNew = () => {
        setCreating(true);
        if (onNavigate) onNavigate('studio/playbooks/new');
    };
    const closeNew = () => {
        setCreating(false);
        if (onNavigate) onNavigate('studio/playbooks');
    };

    if (openId) {
        return (
            <PlaybookRun
                playbookId={openId}
                user={user}
                onBack={() => { open(null); load(); }}
                onNavigate={onNavigate}
            />
        );
    }

    return (
        <div className="h-full flex flex-col overflow-hidden">
            <StudioSectionHeader
                kind="playbook"
                title={t('playbooks.title', 'Playbooks')}
                primary={canManage ? (
                    <button
                        type="button"
                        onClick={startNew}
                        className="inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                        style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                    >
                        <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('playbooks.new', 'New playbook')}
                    </button>
                ) : null}
            />

            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto px-6 py-8 space-y-4" style={{ maxWidth: 760 }}>
                    <div>
                        <h2 className="text-[18px] font-semibold" style={{ color: 'var(--text-primary)' }}>
                            {t('playbooks.heading', 'Playbooks')}
                            {!loading && !error && items.length > 0 && (
                                <span className="ml-2 font-medium" style={{ color: 'var(--text-tertiary)' }}>{items.length}</span>
                            )}
                        </h2>
                        <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
                            {t('playbooks.intro', 'Watch the AI build a working set — a table, an automation that fills it, an app on top — and say yes after every phase.')}
                        </p>
                    </div>

                    {loading ? (
                        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-secondary)' }}>
                            <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                            {t('playbooks.loading', 'Loading…')}
                        </div>
                    ) : error ? (
                        <p className="flex items-start gap-2 text-sm" style={{ color: 'var(--warning)' }}>
                            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />{error}
                        </p>
                    ) : items.length === 0 ? (
                        <NoPlaybooksYet t={t} canCreate={canManage} onCreate={startNew} />
                    ) : (
                        <ul className="space-y-2">
                            {items.map((pb) => <PlaybookCard key={pb.id} t={t} playbook={pb} onOpen={() => open(pb.id)} />)}
                        </ul>
                    )}
                </div>
            </div>

            {creating && (
                <NewPlaybookDialog
                    user={user}
                    hasLicenseFeature={(f) => Array.isArray(user?.betaFeatures) && user.betaFeatures.includes(f)}
                    onClose={closeNew}
                    onCreated={(pb) => { setCreating(false); setItems((list) => [pb, ...list]); open(pb.id); }}
                />
            )}
        </div>
    );
}

function NoPlaybooksYet({ t, canCreate, onCreate }) {
    const { tile, glyph } = kindTileStyle('playbook', { size: 44, pct: 14 });
    return (
        <div className="flex flex-col items-center" style={{ border: '1px dashed var(--border-default)', borderRadius: 12, background: 'var(--bg-card)' }}>
            <EmptyState
                icon={<span style={tile}><Clapperboard style={glyph} aria-hidden="true" /></span>}
                title={t('playbooks.empty_title', 'No playbooks yet')}
                description={canCreate
                    ? t('playbooks.empty_body', 'Start one and watch: the table appears, the automation takes shape, the rows arrive, the app builds itself — you say "go on" between the phases.')
                    : t('playbooks.empty_cannot_create', 'Playbooks are started by whoever may build apps and automations here. Ask an administrator.')}
            />
            {canCreate && (
                <button
                    type="button"
                    onClick={onCreate}
                    className="inline-flex items-center gap-1.5 h-8 px-3 mb-10 -mt-4 rounded-[10px] text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                    style={{ ...PRIMARY_ACTION_STYLE, outlineColor: 'var(--accent-primary)' }}
                >
                    <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('playbooks.new', 'New playbook')}
                </button>
            )}
        </div>
    );
}
