import React from 'react';
import MediaSettingsPopover from './settings/MediaSettingsPopover';
import SettingsDropdown from './settings/SettingsDropdown';
import useMediaGenSection from '../../hooks/useMediaGenSection';
import useTranslation from '../../hooks/useTranslation';

const ACCENT = '#3B82F6';

// ─── Constants ──────────────────────────────────────────────────

// Model names from Google; those are not translated. Only the word in brackets is
// copy, and that deliberately stays with the name so that the two lines in the
// list read as one name.
const VIDEO_MODELS = [
    { label: 'Veo 3.1 (Quality)', value: 'veo-3.1-generate-preview' },
    { label: 'Veo 3.0 Fast (Speed)', value: 'veo-3.0-fast-generate-001' },
];

const ASPECT_RATIOS = [
    { label: '16:9', value: '16:9', icon: '🖥️' },
    { label: '9:16', value: '9:16', icon: '📱' },
];

const DURATIONS = [
    { label: '4s', value: 4 },
    { label: '6s', value: 6 },
    { label: '8s', value: 8 },
];

// ─── Reusable UI ────────────────────────────────────────────────
// Segmented, icon-above-label pill — distinct from the compact
// mediaControls Pill, so it stays local to this panel.

const Pill = ({ label, icon, selected, onClick }: { label: string; icon?: string; selected: boolean; onClick: () => void }) => (
    <button onClick={onClick}
        className="flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-[10px] font-medium transition-all"
        style={{
            background: selected ? 'rgba(59, 130, 246, 0.15)' : 'var(--bg-tertiary)',
            color: selected ? ACCENT : 'var(--text-tertiary)',
            border: `1px solid ${selected ? 'rgba(59, 130, 246, 0.3)' : 'var(--border-subtle)'}`,
        }}>
        {icon && <span className="text-xs">{icon}</span>}
        {label}
    </button>
);

// ─── Component ──────────────────────────────────────────────────

const VideoGenSettings = ({ isOpen, onClose }: { isOpen: boolean; onClose: () => void; anchorRef?: React.RefObject<HTMLElement | null> }) => {
    const { t } = useTranslation();
    const [settings, update] = useMediaGenSection('video', isOpen);

    return (
        <MediaSettingsPopover isOpen={isOpen} onClose={onClose} icon="🎬" title={t('chat.media.veo_panel_title', 'Video Generation (Veo)')} bodyClassName="p-4 space-y-3">
            <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
                {t('chat.media.veo_intro', 'Google Veo — AI video generation. Takes 1-3 minutes per clip.')}
            </p>

            <SettingsDropdown label={t('chat.media.model', 'Model')} options={VIDEO_MODELS} value={settings.model || 'veo-3.1-generate-preview'} onChange={(v: string) => update('model', v)} accentColor={ACCENT} />

            <div>
                <label className="block text-[11px] font-medium mb-1.5 text-[var(--text-secondary)]">{t('chat.media.aspect_ratio', 'Aspect Ratio')}</label>
                <div className="flex gap-1">
                    {ASPECT_RATIOS.map((ar: { label: string; value: string; icon: string }) => (
                        <Pill key={ar.value} label={ar.label} icon={ar.icon}
                            selected={(settings.aspectRatio || '16:9') === ar.value}
                            onClick={() => update('aspectRatio', ar.value)} />
                    ))}
                </div>
            </div>

            <div>
                <label className="block text-[11px] font-medium mb-1.5 text-[var(--text-secondary)]">{t('chat.media.duration', 'Duration')}</label>
                <div className="flex gap-1">
                    {DURATIONS.map((d: { label: string; value: number }) => (
                        <Pill key={d.value} label={d.label}
                            selected={(settings.duration || 8) === d.value}
                            onClick={() => update('duration', d.value)} />
                    ))}
                </div>
            </div>
        </MediaSettingsPopover>
    );
};

export default VideoGenSettings;
