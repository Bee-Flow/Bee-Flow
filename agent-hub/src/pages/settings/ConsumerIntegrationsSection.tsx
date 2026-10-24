import { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, Check } from 'lucide-react';
import { API_BASE, authFetch } from '../../utils/helpers';
import { useTranslation } from '../../hooks/useTranslation';
import { INTEGRATION_CATALOG, NEXTCLOUD_INTEGRATION_IDS, CATEGORY_ORDER, type IntegrationEntry } from '../../config/integrationCatalog';
import { getIntegrationIcon, hasIntegrationIcon } from '../../config/integrationIcons';
import { mutate, ApiError } from '../../api/mutate';

const SAVE_DEBOUNCE_MS = 400;
const SAVED_FLASH_MS = 1500;

// Section order mirrors the org Integrations panel via the shared
// CATEGORY_ORDER, with Nextcloud filtered out (consumer accounts don't bind
// to NC instances) — its group ends up empty and is dropped below.

// Categories not relevant for consumer accounts.
const HIDDEN_CATEGORIES = new Set(['Nextcloud']);
// Some org-admin-only IDs we shouldn't expose to consumers even if they're
// in the catalog (n8n requires org config, kb-search needs an org KB).
const ORG_ONLY_IDS = new Set(['n8n', 'kb-search']);

interface IntegrationTileProps {
    entry: IntegrationEntry;
    enabled?: boolean;
    onToggle: (id: string) => void;
}

const IntegrationTile = ({ entry, enabled, onToggle }: IntegrationTileProps) => {
    const icon = hasIntegrationIcon(entry.id)
        ? getIntegrationIcon(entry.id, { size: 22 })
        : <span className="[font-size:18px]">🔌</span>;
    return (
        <button
            type="button"
            aria-pressed={!!enabled}
            onClick={() => onToggle(entry.id)}
            className="flex items-center gap-3 px-4 py-3 rounded-xl text-left transition-all"
            style={{
                background: enabled ? 'rgba(16,185,129,0.08)' : 'var(--bg-secondary)',
                border: `1px solid ${enabled ? 'rgba(16,185,129,0.35)' : 'var(--border-subtle)'}`,
            }}
        >
            <div className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 overflow-hidden">
                {icon}
            </div>
            <div className="flex-1 min-w-0">
                <p className="text-[13px] font-medium truncate text-[var(--text-primary)]">{entry.label}</p>
                <p className="text-[11px] truncate text-[var(--text-muted)]">{entry.description}</p>
            </div>
            {/* The switch is a picture of the tile's state, not a control of
                its own: a label + checkbox inside the button re-dispatched the
                click, so the tile toggled twice and the switch looked dead. */}
            <span aria-hidden="true" className={`relative inline-flex shrink-0 w-9 h-5 rounded-full transition-colors ${enabled ? 'bg-emerald-500' : 'bg-[var(--border-default)]'}`}>
                <span className={`absolute top-[2px] left-[2px] h-4 w-4 rounded-full bg-white border transition-transform ${enabled ? 'translate-x-4 border-white' : 'border-gray-300'}`} />
            </span>
        </button>
    );
};

const ConsumerIntegrationsSection = () => {
    const { t } = useTranslation();
    const [loading, setLoading] = useState(true);
    const [enabledApps, setEnabledApps] = useState<string[] | null>(null);
    const [saveState, setSaveState] = useState('idle');
    const timerRef = useRef<NodeJS.Timeout>(null);
    const serverRef = useRef<string[]>(null);

    const usableIntegrations = useMemo(() => {
        return INTEGRATION_CATALOG.filter(i =>
            !HIDDEN_CATEGORIES.has(i.category)
            && !NEXTCLOUD_INTEGRATION_IDS.has(i.id)
            && !ORG_ONLY_IDS.has(i.id)
        );
    }, []);

    useEffect(() => {
        (async () => {
            try {
                const res = await authFetch(`${API_BASE}/ai/user-settings`);
                if (res.ok) {
                    const data = await res.json();
                    // Server may return null (= all enabled). Materialise that into
                    // the full catalogue so toggle UI starts in a sensible state.
                    const explicit = Array.isArray(data.enabledApps)
                        ? data.enabledApps
                        : usableIntegrations.map(i => i.id);
                    setEnabledApps(explicit);
                    serverRef.current = explicit;
                }
            } catch (e) {
                console.error('[ConsumerIntegrations] load error:', e);
            } finally {
                setLoading(false);
            }
        })();
    }, [usableIntegrations]);

    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

    const queueSave = (nextList: string[]) => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(async () => {
            setSaveState('saving');
            try {
                try {
                    await mutate(`${API_BASE}/ai/user-settings`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabledApps: nextList }),
                });
                } catch (err) {
                    if (!(err instanceof ApiError)) throw err;
                    throw new Error('Save failed');
                }
                serverRef.current = nextList;
                setSaveState('saved');
                setTimeout(() => setSaveState(prev => prev === 'saved' ? 'idle' : prev), SAVED_FLASH_MS);
            } catch (e) {
                console.error('[ConsumerIntegrations] save error:', e);
                setEnabledApps(serverRef.current);
                setSaveState('idle');
            }
        }, SAVE_DEBOUNCE_MS);
    };

    const toggle = (id: string) => {
        if (!enabledApps) return;
        const next = enabledApps.includes(id)
            ? enabledApps.filter(x => x !== id)
            : [...enabledApps, id];
        setEnabledApps(next);
        queueSave(next);
    };

    const grouped = useMemo(() => {
        const map = new Map<string, IntegrationEntry[]>();
        for (const cat of CATEGORY_ORDER) map.set(cat, []);
        for (const entry of usableIntegrations) {
            if (!map.has(entry.category)) map.set(entry.category, []);
            map.get(entry.category)?.push(entry);
        }
        return map;
    }, [usableIntegrations]);

    if (loading) {
        return (
            <div className="space-y-4 animate-pulse">
                <div className="h-6 w-48 bg-[var(--bg-tertiary)] rounded-lg" />
                <div className="h-40 bg-[var(--bg-tertiary)] rounded-2xl" />
            </div>
        );
    }

    return (
        <div className="space-y-5 animate-fadeIn">
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-lg font-semibold text-[var(--text-primary)]">
                        {t('settings.integrations', 'Integrations')}
                    </h2>
                    <p className="text-sm text-[var(--text-muted)] mt-1">
                        {t('settings.consumer_integrations.subtitle', 'Choose which third-party tools your AI assistants can use')}
                    </p>
                </div>
                <div className="text-xs flex items-center gap-1.5 text-[var(--text-muted)]">
                    {saveState === 'saving' && (<><Loader2 className="w-3 h-3 animate-spin" /> {t('settings.consumer_integrations.saving', 'Saving…')}</>)}
                    {saveState === 'saved' && (<><Check className="w-3 h-3 text-emerald-500" /> {t('settings.consumer_integrations.saved', 'Saved')}</>)}
                </div>
            </div>

            {Array.from(grouped.entries()).filter(([, list]) => list.length > 0).map(([cat, list]) => (
                <div key={cat}>
                    <p className="text-[11px] font-semibold uppercase tracking-widest mb-2 px-1 text-[var(--text-muted)]">
                        {cat}
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        {list.map(entry => (
                            <IntegrationTile
                                key={entry.id}
                                entry={entry}
                                enabled={enabledApps?.includes(entry.id)}
                                onToggle={toggle}
                            />
                        ))}
                    </div>
                </div>
            ))}

            <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-5">
                <div className="flex gap-3">
                    <span className="text-lg">💡</span>
                    <p className="text-xs text-[var(--text-muted)] leading-relaxed flex-1">
                        {t('settings.consumer_integrations.footer_prefix', 'These toggles control which tools your AI assistants can call on your behalf. Disabling an integration here prevents it from being used in any conversation — you can still connect credentials under')} <strong>{t('settings.consumer_integrations.footer_connections', 'Connections')}</strong> {t('settings.consumer_integrations.footer_suffix', 'without making the tool active.')}
                    </p>
                </div>
            </div>
        </div>
    );
};

export default ConsumerIntegrationsSection;
