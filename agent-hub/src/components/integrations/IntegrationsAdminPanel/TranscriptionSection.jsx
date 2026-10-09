// "Transcription" section of the IntegrationsAdminPanel (Meeting Transcription
// provider picker + per-provider configuration). Subtree moved verbatim from
// IntegrationsAdminPanel.jsx; all bindings are threaded in as props.
import { Check, Cloud, ExternalLink, Loader2 } from 'lucide-react';
import React from 'react';
import { API_BASE, authFetch } from '../../../utils/helpers';
import AppEmoji from '../../icons/AppEmoji';
import { useTranslation } from '../../../hooks/useTranslation';

export default function TranscriptionSection({
    transcriptionProvider, setTranscriptionProvider,
    savingTranscriptionProvider, setSavingTranscriptionProvider,
    hasAzureSpeechKey, setHasAzureSpeechKey,
    azureSpeechKey, setAzureSpeechKey, azureSpeechRegion, setAzureSpeechRegion,
    savingAzureSpeech, setSavingAzureSpeech,
    whisperxUrl, setWhisperxUrl, whisperxToken, setWhisperxToken,
    hasWhisperxUrl, setHasWhisperxUrl, hasWhisperxToken, setHasWhisperxToken,
    savingWhisperx, setSavingWhisperx,
    scalewayApiKey, setScalewayApiKey, hasScalewayKey, setHasScalewayKey,
    savingScaleway, setSavingScaleway,
    pyannoteApiKey, setPyannoteApiKey, hasPyannoteKey, setHasPyannoteKey,
    savingPyannote, setSavingPyannote,
    pyannoteTranscriptionModel, saveTranscriptionModel, savingPyannoteModel,
    voiceprintMatchingEnabled, saveVoiceprintSettings, savingVoiceprint,
    pyannoteIdentifyThreshold, setPyannoteIdentifyThreshold,
    setMessage,
}) {
    const { t } = useTranslation();
    return (
            <div className="p-6">
            <div className="max-w-4xl mx-auto space-y-6">

                {/* Header */}
                <div>
                    <h2 className="text-lg font-bold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                        <Cloud className="w-5 h-5" style={{ color: '#0ea5e9' }} />
                        {t('integ.transcription_meeting_transcription', 'Meeting Transcription')}
                    </h2>
                    <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
                        {t('integ.transcription_configure_which_ai_provider', 'Configure which AI provider transcribes your meeting recordings. All providers support')} <strong>{t('integ.transcription_speaker_diarization', 'speaker diarization')}</strong> {t('integ.transcription_who_said_what_and_automatic_speaker', '(who said what) and automatic speaker name identification. Switch providers at any time without losing settings.')}
                    </p>
                </div>

                {/* Active provider picker */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_active_provider', 'Active Provider')}</h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_choose_which_engine_will_be_used_when', 'Choose which engine will be used when you transcribe audio in Meeting Notes.')}</p>
                    </div>
                    <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-3">
                        {[
                            {
                                id: 'voxtral',
                                name: 'Voxtral',
                                badge: 'Mistral Cloud',
                                emoji: '⚡',
                                catalogId: 'integration.fast',
                                badgeColor: '#f59e0b',
                                desc: 'Fast, high-quality cloud transcription with built-in diarization. Requires a Mistral API key.',
                                requires: 'Mistral API key (AI Config)',
                                ready: true, // always potentially ready via API key
                            },
                            {
                                id: 'azure',
                                name: 'Azure Speech',
                                badge: 'Microsoft Cloud',
                                emoji: '☁️',
                                catalogId: 'integration.cloud',
                                badgeColor: '#0078D4',
                                desc: 'Enterprise-grade Whisper model on Azure. Great for compliance-conscious organisations.',
                                requires: 'Azure Speech key + region',
                                ready: hasAzureSpeechKey,
                            },
                            {
                                id: 'whisper_azure',
                                name: 'Azure Whisper',
                                badge: 'Batch API',
                                emoji: '🎙️',
                                catalogId: 'integration.recording',
                                badgeColor: '#0078D4',
                                desc: 'Higher accuracy via Azure Batch Transcription (Whisper model). Async — large files, up to 35 speakers. Uses RustFS for temp audio storage.',
                                requires: 'Azure Speech key + RustFS',
                                ready: hasAzureSpeechKey,
                            },
                            {
                                id: 'whisperx',
                                name: 'WhisperX',
                                badge: 'Self-hosted',
                                emoji: '🏠',
                                catalogId: 'integration.local',
                                badgeColor: '#10B981',
                                desc: 'Fully private. Run Whisper on your own server — audio never leaves your infrastructure. For CPU-only voice capture (chat input, no GPU required), the in-process whisper.cpp path is used automatically.',
                                requires: 'Self-hosted server URL (optional — CPU whisper.cpp runs without it)',
                                ready: hasWhisperxUrl,
                            },
                            {
                                id: 'scaleway',
                                name: 'Scaleway (hybrid)',
                                badge: 'Cloud + local',
                                emoji: '🇪🇺',
                                catalogId: 'integration.fast',
                                badgeColor: '#7c3aed',
                                desc: 'Fast GDPR-EU cloud transcription (Whisper large-v3) with speaker labels from your local WhisperX diarizer. Audio is sent to your Scaleway EU project.',
                                requires: 'Scaleway API key' + (hasWhisperxUrl ? '' : ' + WhisperX URL (for speakers)'),
                                ready: hasScalewayKey,
                            },
                            {
                                id: 'pyannote',
                                name: 'pyannoteAI',
                                badge: 'Diarization + STT',
                                emoji: '🎯',
                                catalogId: 'integration.cloud',
                                badgeColor: '#6d28d9',
                                desc: 'Premium speaker diarization + speaker-attributed transcription (precision-3) in one call. Best-in-class multi-speaker separation. Audio is uploaded to pyannoteAI temporary storage (24h) — no self-hosted diarizer or RustFS/public URL needed.',
                                requires: 'pyannoteAI API key',
                                ready: hasPyannoteKey,
                            },
                        ].map((p) => (
                            <button
                                key={p.id}
                                onClick={async () => {
                                    if (transcriptionProvider === p.id) return;
                                    setSavingTranscriptionProvider(true);
                                    try {
                                        const res = await authFetch(`${API_BASE}/ai/config`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ transcriptionProvider: p.id }),
                                        });
                                        if (res.ok) {
                                            setTranscriptionProvider(p.id);
                                            setMessage({ type: 'success', text: `Active provider set to ${p.name}` });
                                        }
                                    } catch (e) {
                                        setMessage({ type: 'error', text: 'Failed to save provider' });
                                    }
                                    setSavingTranscriptionProvider(false);
                                    setTimeout(() => setMessage(null), 3000);
                                }}
                                disabled={savingTranscriptionProvider}
                                className="relative rounded-xl border-2 p-4 text-left transition-all cursor-pointer disabled:opacity-50"
                                style={{
                                    background: transcriptionProvider === p.id ? 'color-mix(in srgb, var(--accent-primary) 8%, var(--bg-primary))' : 'var(--bg-primary)',
                                    borderColor: transcriptionProvider === p.id ? 'var(--accent-primary)' : 'var(--border-default)',
                                }}
                            >
                                {transcriptionProvider === p.id && (
                                    <span className="absolute top-3 right-3 w-2 h-2 rounded-full bg-green-400" />
                                )}
                                <div className="text-2xl mb-2"><AppEmoji id={p.catalogId} default={p.emoji} /></div>
                                <div className="font-semibold text-sm mb-1" style={{ color: 'var(--text-primary)' }}>{p.name}</div>
                                <span className="text-xs px-1.5 py-0.5 rounded-full font-medium" style={{ background: p.badgeColor + '18', color: p.badgeColor }}>
                                    {p.badge}
                                </span>
                                <p className="text-xs mt-2" style={{ color: 'var(--text-muted)' }}>{p.desc}</p>
                                <p className="text-xs mt-2 font-medium" style={{ color: p.ready ? '#10b981' : 'var(--text-muted)' }}>
                                    {p.ready ? '✓ Configured' : `⚠ Needs: ${p.requires}`}
                                </p>
                            </button>
                        ))}
                    </div>
                </div>

                {/* ── Provider 1: Voxtral ─────────────────────────────────────────── */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b flex items-center justify-between" style={{ borderColor: 'var(--border-subtle)' }}>
                        <div>
                            <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                                {t('integ.transcription_voxtral', '⚡ Voxtral')} <span className="text-xs px-2 py-0.5 rounded-full font-normal" style={{ background: '#f59e0b18', color: '#f59e0b' }}>{t('integ.transcription_mistral_cloud', 'Mistral Cloud')}</span>
                                {transcriptionProvider === 'voxtral' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                            </h3>
                            <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_uses_mistral_s', 'Uses Mistral\'s')} <code>voxtral-mini-latest</code> {t('integ.transcription_model_fast_and_accurate_with_speaker', 'model. Fast and accurate with speaker diarization.')}</p>
                        </div>
                    </div>
                    <div className="p-6 space-y-3">
                        <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                            {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                            <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_mistral_api_key', 'Mistral API Key')}</p>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {t('integ.transcription_voxtral_uses_your_existing_mistral_api', 'Voxtral uses your existing Mistral API key configured in')}{' '}
                                {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                                <strong>{t('integ.transcription_admin_ai_config_api_keys_mistral', 'Admin → AI Config → API Keys → Mistral')}</strong>{t('integ.transcription_no_additional_setup_needed_here', '. No additional setup needed here.')}
                            </p>
                        </div>
                        <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                            <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_capabilities', 'Capabilities')}</p>
                            <ul className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
                                <li>{t('integ.transcription_speaker_diarization_who_said_what', '✅ Speaker diarization (who said what)')}</li>
                                <li>{t('integ.transcription_word_and_segment_timestamps', '✅ Word and segment timestamps')}</li>
                                <li>{t('integ.transcription_30_languages', '✅ 30+ languages')}</li>
                                <li>{t('integ.transcription_context_terms_to_boost_accuracy', '✅ Context terms to boost accuracy')}</li>
                                <li>{t('integ.transcription_audio_sent_to_mistral_cloud_servers', 'ℹ️ Audio sent to Mistral cloud servers')}</li>
                            </ul>
                        </div>
                        <a
                            href="https://console.mistral.ai"
                            target="_blank" rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-sm underline"
                            style={{ color: 'var(--accent-primary)' }}
                        >
                            <ExternalLink className="w-3.5 h-3.5" /> {t('integ.transcription_open_mistral_console', 'Open Mistral Console')}
                        </a>
                    </div>
                </div>

                {/* ── Provider 2: Azure AI Speech ─────────────────────────────────── */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            {t('integ.transcription_azure_ai_speech', '☁️ Azure AI Speech')}
                            <span className="text-xs px-2 py-0.5 rounded-full font-normal" style={{ background: '#0078D418', color: '#0078D4' }}>{t('integ.transcription_microsoft_cloud', 'Microsoft Cloud')}</span>
                            {transcriptionProvider === 'azure' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                            {hasAzureSpeechKey && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>{t('integ.transcription_key_saved', 'Key saved 🔒')}</span>}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_azure_cognitive_services_speech_with', 'Azure Cognitive Services Speech with optional Whisper model. Enterprise SLAs, GDPR-compliant regions available.')}</p>
                    </div>
                    <div className="p-6 space-y-4">
                        {/* Credentials */}
                        <div>
                            <label className="text-sm font-medium block mb-2" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_credentials', 'Credentials')}</label>
                            <div className="flex gap-2 mb-2">
                                <div className="flex-1">
                                    <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_region_e_g', 'Region (e.g.')} <code>westeurope</code>, <code>eastus</code>)</p>
                                    <input
                                        type="text"
                                        value={azureSpeechRegion}
                                        onChange={e => setAzureSpeechRegion(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                                        placeholder={t('integ.transcription_westeurope', 'westeurope')}
                                        className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                    />
                                </div>
                                <div className="flex-1">
                                    {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                                    <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_api_key_key_1', 'API Key (Key 1)')}</p>
                                    <input
                                        type="password"
                                        value={azureSpeechKey}
                                        onChange={e => setAzureSpeechKey(e.target.value)}
                                        placeholder={hasAzureSpeechKey ? '••••••••••••••••' : 'Paste your subscription key'}
                                        autoComplete="new-password"
                                        className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                    />
                                </div>
                            </div>
                            <button
                                onClick={async () => {
                                    if (!azureSpeechRegion.trim() && !azureSpeechKey.trim()) return;
                                    setSavingAzureSpeech(true);
                                    try {
                                        const body = {};
                                        if (azureSpeechRegion.trim()) body.azureSpeechRegion = azureSpeechRegion.trim();
                                        if (azureSpeechKey.trim()) body.azureSpeechKey = azureSpeechKey.trim();
                                        const res = await authFetch(`${API_BASE}/ai/config`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify(body),
                                        });
                                        if (res.ok) {
                                            if (azureSpeechKey.trim()) setHasAzureSpeechKey(true);
                                            setAzureSpeechKey('');
                                            setMessage({ type: 'success', text: 'Azure Speech credentials saved securely' });
                                        } else {
                                            const err = await res.json().catch(() => ({}));
                                            setMessage({ type: 'error', text: err.error || 'Failed to save credentials' });
                                        }
                                    } catch (e) {
                                        setMessage({ type: 'error', text: 'Failed to save credentials' });
                                    }
                                    setSavingAzureSpeech(false);
                                    setTimeout(() => setMessage(null), 3000);
                                }}
                                disabled={savingAzureSpeech || (!azureSpeechRegion.trim() && !azureSpeechKey.trim())}
                                className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                style={{ background: 'var(--accent-primary)', color: '#fff' }}
                            >
                                {savingAzureSpeech ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                {t('integ.transcription_save_credentials', 'Save credentials')}
                            </button>
                        </div>
                        {/* Info */}
                        <div className="rounded-xl p-4 space-y-1.5" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_capabilities', 'Capabilities')}</p>
                            <ul className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
                                <li>{t('integ.transcription_speaker_diarization_2', '✅ Speaker diarization')}</li>
                                <li>{t('integ.transcription_whisper_model_available', '✅ Whisper model available')}</li>
                                <li>{t('integ.transcription_gdpr_compliant_regions_e_g', '✅ GDPR-compliant regions (e.g.')} <code>westeurope</code>)</li>
                                <li>{t('integ.transcription_enterprise_sla', '✅ Enterprise SLA')}</li>
                                <li>{t('integ.transcription_key_encrypted_at_rest_aes_256_gcm', '🔒 Key encrypted at rest (AES-256-GCM) — never exposed in API responses')}</li>
                            </ul>
                        </div>
                        <div className="flex items-start gap-2 rounded-xl p-3" style={{ background: 'var(--accent-primary)10', border: '1px solid var(--accent-primary)30' }}>
                            <ExternalLink className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--accent-primary)' }} />
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {t('integ.transcription_create_a_resource_in_the', 'Create a resource in the')}{' '}
                                <a href="https://portal.azure.com/#create/Microsoft.CognitiveServicesSpeechServices" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>{t('integ.transcription_azure_portal_ai_speech', 'Azure Portal → AI Speech')}</a>{t('integ.transcription_copy', '. Copy')} <strong>{t('integ.transcription_key_1', 'Key 1')}</strong> {t('integ.transcription_and_the', 'and the')} <strong>{t('integ.transcription_location_region', 'Location / Region')}</strong>.
                            </p>
                        </div>
                    </div>
                </div>

                {/* ── Provider 3: WhisperX self-hosted ────────────────────────────── */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            {t('integ.transcription_whisperx', '🏠 WhisperX')}
                            <span className="text-xs px-2 py-0.5 rounded-full font-normal" style={{ background: '#0ea5e918', color: '#0ea5e9' }}>{t('integ.transcription_self_hosted', 'Self-hosted')}</span>
                            {transcriptionProvider === 'whisperx' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                            {hasWhisperxUrl && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>{t('integ.transcription_url_saved', 'URL saved 🔒')}</span>}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_point_beeflow_at_your_own_whisperx_or', 'Point BeeFlow at your own WhisperX or Faster-Whisper server. Audio never leaves your network.')}</p>
                    </div>
                    <div className="p-6 space-y-4">
                        {/* Server URL */}
                        <div>
                            <label className="text-sm font-medium block mb-2" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_server_configuration', 'Server Configuration')}</label>
                            <div className="space-y-2">
                                <div>
                                    <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_server_url_base_url_of_your_whisperx', 'Server URL — base URL of your WhisperX HTTP API')}</p>
                                    <input
                                        type="url"
                                        value={whisperxUrl}
                                        onChange={e => setWhisperxUrl(e.target.value)}
                                        placeholder={hasWhisperxUrl ? '••••••••••••••••' : 'http://whisperx:9000'}
                                        className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                    />
                                </div>
                                <div>
                                    <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_bearer_token', 'Bearer Token')} <em>{t('integ.transcription_optional_only_if_your_server_requires', '(optional — only if your server requires authentication)')}</em></p>
                                    <input
                                        type="password"
                                        value={whisperxToken}
                                        onChange={e => setWhisperxToken(e.target.value)}
                                        placeholder={hasWhisperxToken ? '••••••••••••••••' : 'Leave empty if your server is internal-only'}
                                        autoComplete="new-password"
                                        className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                        style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                                    />
                                </div>
                            </div>
                            <button
                                onClick={async () => {
                                    if (!whisperxUrl.trim() && !whisperxToken.trim()) return;
                                    setSavingWhisperx(true);
                                    try {
                                        const body = {};
                                        if (whisperxUrl.trim()) body.whisperxUrl = whisperxUrl.trim();
                                        if (whisperxToken !== '') body.whisperxToken = whisperxToken;
                                        const res = await authFetch(`${API_BASE}/ai/config`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify(body),
                                        });
                                        if (res.ok) {
                                            if (whisperxUrl.trim()) setHasWhisperxUrl(true);
                                            if (whisperxToken.trim()) setHasWhisperxToken(true);
                                            setWhisperxUrl('');
                                            setWhisperxToken('');
                                            setMessage({ type: 'success', text: 'WhisperX server URL saved securely' });
                                        } else {
                                            const err = await res.json().catch(() => ({}));
                                            setMessage({ type: 'error', text: err.error || 'Failed to save WhisperX settings' });
                                        }
                                    } catch (e) {
                                        setMessage({ type: 'error', text: 'Failed to save WhisperX settings' });
                                    }
                                    setSavingWhisperx(false);
                                    setTimeout(() => setMessage(null), 3000);
                                }}
                                disabled={savingWhisperx || (!whisperxUrl.trim() && !whisperxToken.trim())}
                                className="mt-3 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                style={{ background: 'var(--accent-primary)', color: '#fff' }}
                            >
                                {savingWhisperx ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                {t('integ.transcription_save_server_config', 'Save server config')}
                            </button>
                        </div>
                        {/* Capabilities */}
                        <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                            <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_capabilities', 'Capabilities')}</p>
                            <ul className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
                                <li>{t('integ.transcription_speaker_diarization_2', '✅ Speaker diarization')}</li>
                                <li>{t('integ.transcription_fully_private_audio_stays_on_your', '✅ Fully private — audio stays on your server')}</li>
                                <li>{t('integ.transcription_gpu_accelerated_faster_than_real_time', '✅ GPU-accelerated (faster than real-time)')}</li>
                                <li>{t('integ.transcription_no_per_minute_cost', '✅ No per-minute cost')}</li>
                                <li>{t('integ.transcription_compatible_with', '✅ Compatible with')} <code>whisperx-server</code> {t('integ.transcription_and', 'and')} <code>faster-whisper-server</code></li>
                                <li>{t('integ.transcription_url_stored_encrypted_aes_256_gcm', '🔒 URL stored encrypted (AES-256-GCM)')}</li>
                            </ul>
                        </div>
                        {/* Setup guide */}
                        <div className="rounded-xl p-4 space-y-3" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                            <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_quick_setup_with_docker', 'Quick setup with Docker')}</p>
                            <pre className="text-xs rounded-lg p-3 overflow-x-auto" style={{ background: 'var(--bg-secondary)', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>{`docker run -d \\
  --name whisperx \\
  --gpus all \\
  -p 9000:9000 \\
  fedirz/faster-whisper-server:latest-cuda

# Then set Server URL to: http://your-host:9000`}</pre>
                            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                {t('integ.transcription_cpu_only_replace', 'CPU-only: replace')} <code>latest-cuda</code> {t('integ.transcription_with', 'with')} <code>latest-cpu</code>{t('integ.transcription_diarization_requires_a_hugging_face', '. Diarization requires a Hugging Face token — see the')}{' '}
                                <a href="https://github.com/fedirz/faster-whisper-server" target="_blank" rel="noopener noreferrer" className="underline" style={{ color: 'var(--accent-primary)' }}>{t('integ.transcription_faster_whisper_server_docs', 'faster-whisper-server docs')}</a>.
                            </p>
                        </div>
                    </div>
                </div>

                {/* ── Provider 4: Scaleway Whisper (hybrid) ────────────────────────── */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            {t('integ.transcription_scaleway_whisper', '🇪🇺 Scaleway Whisper')}
                            <span className="text-xs px-2 py-0.5 rounded-full font-normal" style={{ background: '#7c3aed18', color: '#7c3aed' }}>{t('integ.transcription_hybrid_eu', 'Hybrid · EU')}</span>
                            {transcriptionProvider === 'scaleway' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                            {hasScalewayKey && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>{t('integ.transcription_key_saved', 'Key saved 🔒')}</span>}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_fast_gdpr_eu_cloud_transcription', 'Fast GDPR-EU cloud transcription (Whisper large-v3) with speaker labels from your local WhisperX diarizer.')}</p>
                    </div>
                    <div className="p-6 space-y-4">
                        <div>
                            {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                            <label className="text-sm font-medium block mb-2" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_scaleway_api_key', 'Scaleway API Key')}</label>
                            {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a translated field label or i18n key, not a credential */}
                            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_secret_key_from_the_scaleway_console', 'Secret key from the Scaleway console → Generative APIs → Generate API key')}</p>
                            <input
                                type="password"
                                value={scalewayApiKey}
                                onChange={e => setScalewayApiKey(e.target.value)}
                                placeholder={hasScalewayKey ? '••••••••••••••••' : 'Paste your Scaleway secret key'}
                                autoComplete="new-password"
                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                            />
                            <button
                                onClick={async () => {
                                    if (!scalewayApiKey.trim()) return;
                                    setSavingScaleway(true);
                                    try {
                                        const res = await authFetch(`${API_BASE}/ai/config`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ scalewayApiKey: scalewayApiKey.trim() }),
                                        });
                                        if (res.ok) {
                                            setHasScalewayKey(true);
                                            setScalewayApiKey('');
                                            setMessage({ type: 'success', text: 'Scaleway API key saved securely' });
                                        } else {
                                            const err = await res.json().catch(() => ({}));
                                            setMessage({ type: 'error', text: err.error || 'Failed to save Scaleway key' });
                                        }
                                    } catch (e) {
                                        setMessage({ type: 'error', text: 'Failed to save Scaleway key' });
                                    }
                                    setSavingScaleway(false);
                                    setTimeout(() => setMessage(null), 3000);
                                }}
                                disabled={savingScaleway || !scalewayApiKey.trim()}
                                className="mt-3 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                style={{ background: 'var(--accent-primary)', color: '#fff' }}
                            >
                                {savingScaleway ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                                {t('integ.transcription_save_api_key', 'Save API key')}
                            </button>
                        </div>
                        {/* Capabilities */}
                        <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                            <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_capabilities', 'Capabilities')}</p>
                            <ul className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
                                <li>{t('integ.transcription_fast_cloud_transcription_gpu_whisper', '✅ Fast cloud transcription — GPU Whisper large-v3, far quicker than local CPU')}</li>
                                <li>{t('integ.transcription_speaker_diarization_2', '✅ Speaker diarization')} <em>{t('integ.transcription_via_your_local_whisperx_diarizer', 'via your local WhisperX diarizer')}</em> {t('integ.transcription_needs_the_whisperx_url_above_set', '(needs the WhisperX URL above set)')}</li>
                                <li>{t('integ.transcription_runs_in_an_eu_region_gdpr_your_own', '✅ Runs in an EU region (GDPR) — your own Scaleway project')}</li>
                                <li>{t('integ.transcription_audio_is_sent_to_your_scaleway_eu', '⚠️ Audio is sent to your Scaleway EU project for transcription — not zero-egress like pure WhisperX')}</li>
                                <li>{t('integ.transcription_key_stored_encrypted_aes_256_gcm', '🔒 Key stored encrypted (AES-256-GCM)')}</li>
                            </ul>
                        </div>
                        {!hasWhisperxUrl && (
                            <div className="rounded-xl p-4 text-xs" style={{ background: 'var(--bg-primary)', border: '1px solid #f59e0b44', color: 'var(--text-muted)' }}>
                                {t('integ.transcription_no_whisperx_url_configured_scaleway', '⚠️ No WhisperX URL configured. Scaleway will transcribe but every segment will be one speaker until you set the WhisperX/diarizer URL above.')}
                            </div>
                        )}
                    </div>
                </div>

                {/* ── Provider 5: pyannoteAI (all-in-one diarization + transcription) ── */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
                            {t('integ.transcription_pyannoteai', '🎯 pyannoteAI')}
                            <span className="text-xs px-2 py-0.5 rounded-full font-normal" style={{ background: '#6d28d918', color: '#6d28d9' }}>{t('integ.transcription_diarization_stt', 'Diarization + STT')}</span>
                            {transcriptionProvider === 'pyannote' && <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/10 text-green-500">{t('integ.transcription_active', 'Active')}</span>}
                            {hasPyannoteKey && <span className="text-xs px-2 py-0.5 rounded-full" style={{ background: 'var(--bg-primary)', color: 'var(--text-muted)', border: '1px solid var(--border-subtle)' }}>{t('integ.transcription_key_saved', 'Key saved 🔒')}</span>}
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_best_in_class_speaker_diarization_with', 'Best-in-class speaker diarization with speaker-attributed transcription, in a single call.')}</p>
                    </div>
                    <div className="p-6 space-y-4">
                        <div>
                            {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                            <label className="text-sm font-medium block mb-2" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_pyannoteai_api_key', 'pyannoteAI API Key')}</label>
                            <p className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>{t('integ.transcription_create_a_key_at_dashboard_pyannote_ai', 'Create a key at dashboard.pyannote.ai → API keys')}</p>
                            <input
                                type="password"
                                value={pyannoteApiKey}
                                onChange={e => setPyannoteApiKey(e.target.value)}
                                placeholder={hasPyannoteKey ? '••••••••••••••••' : 'Paste your pyannoteAI API key'}
                                autoComplete="new-password"
                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none focus:ring-2 transition-all"
                                style={{ background: 'var(--bg-primary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)', '--tw-ring-color': 'var(--accent-primary)' }}
                            />
                            <button
                                onClick={async () => {
                                    if (!pyannoteApiKey.trim()) return;
                                    setSavingPyannote(true);
                                    try {
                                        const res = await authFetch(`${API_BASE}/ai/config`, {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ pyannoteApiKey: pyannoteApiKey.trim() }),
                                        });
                                        if (res.ok) {
                                            setHasPyannoteKey(true);
                                            setPyannoteApiKey('');
                                            setMessage({ type: 'success', text: 'pyannoteAI API key saved securely' });
                                        } else {
                                            const err = await res.json().catch(() => ({}));
                                            setMessage({ type: 'error', text: err.error || 'Failed to save pyannoteAI key' });
                                        }
                                    } catch (e) {
                                        setMessage({ type: 'error', text: 'Failed to save pyannoteAI key' });
                                    }
                                    setSavingPyannote(false);
                                    setTimeout(() => setMessage(null), 3000);
                                }}
                                disabled={savingPyannote || !pyannoteApiKey.trim()}
                                className="mt-3 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-50 flex items-center gap-1.5"
                                style={{ background: 'var(--accent-primary)', color: '#fff' }}
                            >
                                {savingPyannote ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                {/* nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_api_key -- a translated field label or i18n key, not a credential */}
                                {t('integ.transcription_save_api_key', 'Save API key')}
                            </button>
                        </div>
                        {/* Speech model */}
                        <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                            <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_speech_to_text_model', 'Speech-to-text model')}</p>
                            <p className="text-xs mb-3" style={{ color: 'var(--text-muted)' }}>
                                {t('integ.transcription_speaker_separation_always_uses', 'Speaker separation always uses')} <strong>{t('integ.transcription_precision_3', 'precision-3')}</strong>{t('integ.transcription_pyannoteai_s_most_accurate_model_for', ', pyannoteAI’s most accurate model. For the words themselves, neither available model wins everywhere:')}
                                <strong> {t('integ.transcription_parakeet_v3', 'Parakeet v3')}</strong> {t('integ.transcription_is_the_more_accurate_of_the_two_6_34', 'is the more accurate of the two (6.34% vs 7.83% average word error rate on English) and covers 25 European languages including Dutch;')}
                                <strong> {t('integ.transcription_whisper_large_v3_turbo', 'Whisper large-v3-turbo')}</strong> {t('integ.transcription_is_a_little_weaker_but_covers_99_so_it', 'is a little weaker but covers 99, so it is the only option for Japanese, Chinese, Korean, Arabic and Turkish. Automatic picks the best one per meeting language.')}
                            </p>
                            <select
                                value={pyannoteTranscriptionModel}
                                onChange={e => saveTranscriptionModel(e.target.value)}
                                disabled={savingPyannoteModel}
                                className="w-full px-3 py-2 rounded-lg text-sm border outline-none"
                                style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                            >
                                <option value="">{t('integ.transcription_automatic_best_model_per_meeting', 'Automatic — best model per meeting language (recommended)')}</option>
                                <option value="parakeet-tdt-0.6b-v3">{t('integ.transcription_always_parakeet_v3_most_accurate', 'Always Parakeet v3 — most accurate, European languages only')}</option>
                                <option value="faster-whisper-large-v3-turbo">{t('integ.transcription_always_whisper_large_v3_turbo_widest', 'Always Whisper large-v3-turbo — widest language coverage')}</option>
                            </select>
                        </div>
                        {/* Voiceprint speaker identification */}
                        <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                            <div className="flex items-start justify-between gap-4">
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_recognise_speakers_by_voice', 'Recognise speakers by voice')}</p>
                                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                                        {t('integ.transcription_colleagues_record_a_personal_voice', 'Colleagues record a personal voice profile in Settings → Preferences (only they can record their own), after which their real name is put on their turns automatically. pyannoteAI cannot transcribe and identify in one job, so a')} <strong>{t('integ.transcription_second_job_per_meeting', 'second job per meeting')}</strong> {t('integ.transcription_is_submitted_but_only_when_someone_in', 'is submitted — but only when someone in that organisation actually has a voice profile. Turn this off to stop identification everywhere without anyone deleting theirs.')}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    role="switch"
                                    aria-checked={voiceprintMatchingEnabled}
                                    onClick={() => saveVoiceprintSettings({ voiceprintMatchingEnabled: !voiceprintMatchingEnabled })}
                                    disabled={savingVoiceprint}
                                    className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-1"
                                    style={{ background: voiceprintMatchingEnabled ? 'var(--accent-primary)' : 'var(--border-default)', opacity: savingVoiceprint ? 0.6 : 1 }}
                                >
                                    <div className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform"
                                        style={{ transform: voiceprintMatchingEnabled ? 'translateX(20px)' : 'translateX(0)' }} />
                                </button>
                            </div>
                            {voiceprintMatchingEnabled && (
                                <div className="mt-3 pt-3 flex items-center gap-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                                    <label className="text-xs flex-1" style={{ color: 'var(--text-muted)' }}>
                                        {t('integ.transcription_match_confidence_threshold_how_sure', 'Match confidence threshold — how sure pyannoteAI must be before a voice counts as a match. Higher means fewer names, but never the wrong one. Default 50.')}
                                    </label>
                                    <input
                                        type="number" min={0} max={100}
                                        value={pyannoteIdentifyThreshold}
                                        onChange={e => setPyannoteIdentifyThreshold(e.target.value)}
                                        onBlur={() => saveVoiceprintSettings({ pyannoteIdentifyThreshold: Number(pyannoteIdentifyThreshold) })}
                                        disabled={savingVoiceprint}
                                        className="w-20 px-3 py-1.5 rounded-lg border outline-none text-sm"
                                        style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)', color: 'var(--text-primary)' }}
                                    />
                                </div>
                            )}
                        </div>
                        {/* Capabilities */}
                        <div className="rounded-xl p-4" style={{ background: 'var(--bg-primary)', border: '1px solid var(--border-subtle)' }}>
                            <p className="text-sm font-medium mb-2" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_capabilities', 'Capabilities')}</p>
                            <ul className="text-xs space-y-1" style={{ color: 'var(--text-muted)' }}>
                                <li>{t('integ.transcription_premium_speaker_diarization_precision', '✅ Premium speaker diarization (precision-3) — strong multi-speaker separation')}</li>
                                <li>{t('integ.transcription_speaker_attributed_transcription_in', '✅ Speaker-attributed transcription in the same call — no separate diarizer')}</li>
                                <li>{t('integ.transcription_per_meeting_speaker_count_honoured_set', '✅ Per-meeting speaker count honoured (set “Number of speakers” at upload)')}</li>
                                <li>{t('integ.transcription_optional_per_person_voiceprints_real', '✅ Optional per-person voiceprints — real names without an attendee list')}</li>
                                <li>{t('integ.transcription_audio_uploaded_to_pyannoteai_temporary', '✅ Audio uploaded to pyannoteAI temporary storage (24h) — no RustFS/public URL needed')}</li>
                                <li>{t('integ.transcription_key_voice_profiles_stored_encrypted', '🔒 Key + voice profiles stored encrypted (AES-256-GCM)')}</li>
                            </ul>
                        </div>
                    </div>
                </div>

                {/* How transcription works */}
                <div className="rounded-2xl border overflow-hidden" style={{ background: 'var(--bg-secondary)', borderColor: 'var(--border-default)' }}>
                    <div className="px-6 py-4 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                        <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>{t('integ.transcription_how_transcription_works', 'How Transcription Works')}</h3>
                    </div>
                    <div className="p-6">
                        <ol className="space-y-3">
                            {[
                                { step: '1', title: 'Upload audio', desc: 'In Meeting Notes, attach an audio file (MP3, WAV, M4A, WEBM, OGG, FLAC) to a message and say "Transcribe this".' },
                                { step: '2', title: 'Provider transcribes', desc: 'The active provider converts speech to text and returns timed segments with a generic speaker ID per segment (e.g. SPEAKER_00, Guest).' },
                                { step: '3', title: 'Speaker names identified', desc: 'The AI analyses the transcript context and maps generic speaker IDs to real names if they are mentioned in the conversation.' },
                                { step: '4', title: 'Result returned', desc: 'A formatted transcript with timestamps and speaker names is returned in the chat and can be exported or summarised.' },
                            ].map(item => (
                                <li key={item.step} className="flex gap-3">
                                    <span className="flex-shrink-0 w-6 h-6 rounded-full text-xs font-bold flex items-center justify-center" style={{ background: 'var(--accent-primary)', color: '#fff' }}>{item.step}</span>
                                    <div>
                                        <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{item.title}</p>
                                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{item.desc}</p>
                                    </div>
                                </li>
                            ))}
                        </ol>
                    </div>
                </div>

            </div>
            </div>
    );
}
