// Connect a self-hosted runtime: scan the usual local addresses (one click and
// no typing in the common case) or add one by hand, tested before it is saved.

import { useState } from 'react';
import AddRuntimeForm from '../ProviderCards/local/AddRuntimeForm';
import { ProviderStatusPill } from '../ProviderCards/shared/ProviderCardShell';
import type { ProviderPaneProps } from './types';
import Section from '@/components/shared/Section';
import { PRIMARY_BTN, SECONDARY_BTN } from '@/components/mcpLibrary/ui';
import { detectRuntimes, connectRuntime } from '@/api/localRuntimeApi';
import type { ConnectRequest, DetectResult, RuntimeInfo } from '@/api/runtimeTypes';
import { useTranslation } from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';

interface AddRuntimePaneProps extends ProviderPaneProps {
    runtimes: RuntimeInfo[];
    unsupported: string | null;
    /** How many runtimes are connected already. */
    connectedCount: number;
    /** Read the connected runtimes (and the models) again. */
    onChanged: () => void;
}

interface DetectedRuntimesProps {
    detected: DetectResult;
    saving: boolean;
    onConnect: (request: ConnectRequest) => void;
}

/** What the scan found, each with a Connect button. */
function DetectedRuntimes({ detected, saving, onConnect }: DetectedRuntimesProps) {
    const { t } = useTranslation();
    return (
        <div className="space-y-1.5">
            {detected.found.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                    {t('admin_ai_config.local_none_found', 'Nothing found on the {count} usual addresses. Start a runtime (for example ollama serve) and scan again, or add its address manually. If Bee Flow itself runs in Docker, the runtime has to be reachable from inside that container: use host.docker.internal rather than localhost.', { count: detected.probed })}
                </p>
            ) : detected.found.map(f => (
                <div key={f.url} className="flex flex-wrap items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2.5">
                    <span className="text-sm text-[var(--text-primary)]">{f.label}</span>
                    <span className="font-mono text-xs text-[var(--text-muted)]">{f.url}</span>
                    <ProviderStatusPill tone="blue">{f.modelCount === 1 ? t('admin_ai_config.model_count_one', '1 model') : t('admin_ai_config.model_count_other', '{count} models', { count: f.modelCount })}</ProviderStatusPill>
                    <div className="flex-1" />
                    {f.alreadyConfigured ? (
                        <span className="text-xs text-[var(--text-muted)]">{t('admin_ai_config.local_already', 'Already connected')}</span>
                    ) : (
                        <button
                            type="button"
                            className={PRIMARY_BTN}
                            disabled={saving}
                            onClick={() => onConnect({ type: f.type, name: f.label, url: f.url, apiKey: '' })}
                        >
                            {t('admin_ai_config.local_connect', 'Connect')}
                        </button>
                    )}
                </div>
            ))}
        </div>
    );
}

export default function AddRuntimePane({ runtimes, unsupported, connectedCount, onMessage, onChanged }: AddRuntimePaneProps) {
    const { t } = useTranslation();
    const [showAdd, setShowAdd] = useState(false);
    const [saving, setSaving] = useState(false);
    const [detecting, setDetecting] = useState(false);
    const [detected, setDetected] = useState<DetectResult | null>(null);

    const handleConnect = async ({ type, name, url, apiKey }: ConnectRequest) => {
        setSaving(true);
        const result = await connectRuntime({ type, name, url, apiKey });
        if (result.ok) {
            onMessage?.({ type: 'success', text: t('admin_ai_config.local_connected_msg', '{name} connected. Its models are now selectable under Chat Models.', { name }) });
            setShowAdd(false);
            // Reflect it at once in the detect list, so the row does not keep
            // offering Connect for something already connected.
            setDetected(d => d ? { ...d, found: d.found.map(f => (f.url === url ? { ...f, alreadyConfigured: true } : f)) } : d);
            onChanged();
        } else {
            onMessage?.({ type: 'error', text: result.error });
        }
        setSaving(false);
    };

    const handleDetect = async () => {
        setDetecting(true);
        setDetected(null);
        try {
            setDetected(await detectRuntimes());
        } catch (e) {
            onMessage?.({ type: 'error', text: messageOf(e, '') });
            setDetected({ found: [], probed: 0 });
        }
        setDetecting(false);
    };

    return (
        <Section
            title={t('admin_ai_config.local_add_title', 'Connect a local runtime')}
            description={t('admin_ai_config.local_subtitle', 'Ollama, vLLM, llama.cpp, LM Studio and other OpenAI-compatible runtimes: nothing leaves your infrastructure, and there is no per-token cost')}
        >
            <div className="space-y-3">
                {unsupported ? (
                    <p className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] p-2.5 text-xs text-[var(--text-muted)]">
                        {unsupported}
                    </p>
                ) : (
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className={PRIMARY_BTN} disabled={detecting} onClick={handleDetect}>
                            {detecting ? t('admin_ai_config.local_scanning', 'Scanning…') : t('admin_ai_config.local_find', '🔍 Find running runtimes')}
                        </button>
                        <button type="button" className={SECONDARY_BTN} onClick={() => setShowAdd(s => !s)}>
                            {showAdd ? t('admin_ai_config.cancel', 'Cancel') : t('admin_ai_config.local_add_manual', '+ Add manually')}
                        </button>
                    </div>
                )}

                {detected && <DetectedRuntimes detected={detected} saving={saving} onConnect={handleConnect} />}

                {showAdd && <AddRuntimeForm runtimes={runtimes} saving={saving} onConnect={handleConnect} />}

                {!showAdd && !detected && !unsupported && connectedCount === 0 && (
                    <p className="text-xs text-[var(--text-muted)]">
                        {t('admin_ai_config.local_empty', 'Nothing connected yet. Models served this way run on your own hardware and are billed at €0: connect a runtime here, then assign its models to tiers under Chat Models.')}
                    </p>
                )}
            </div>
        </Section>
    );
}
