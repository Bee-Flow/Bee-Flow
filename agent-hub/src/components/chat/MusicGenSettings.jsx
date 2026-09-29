import React from 'react';
import MediaSettingsPopover from './settings/MediaSettingsPopover';
import { Slider, Toggle, PillSelect } from './settings/mediaControls';
import useMediaGenSection from '../../hooks/useMediaGenSection';
import useTranslation from '../../hooks/useTranslation';

const ACCENT = '#8B5CF6';

const MusicGenSettings = ({ isOpen, onClose }) => {
    const { t } = useTranslation();
    const [settings, update] = useMediaGenSection('lyria', isOpen);

    return (
        <MediaSettingsPopover
            isOpen={isOpen}
            onClose={onClose}
            icon="🎹"
            title={t('chat.media.lyria_panel_title', 'Google Music (Lyria)')}
            bodyClassName="p-4 space-y-3 max-h-[360px] overflow-y-auto"
        >
            <p className="text-[10px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
                {t('chat.media.lyria_intro', 'Instrumental music via Google Lyria. These defaults apply when generating music.')}
            </p>
            <Slider label="BPM" value={settings.bpm} min={60} max={200} step={1} defaultVal={90} onChange={v => update('bpm', v)} accent={ACCENT} />
            <Slider label={t('chat.media.duration', 'Duration')} value={settings.durationSeconds} min={5} max={30} step={1} defaultVal={10} unit="s" onChange={v => update('durationSeconds', v)} accent={ACCENT} />
            <Slider label={t('chat.media.lyria_density', 'Density')} value={settings.density} min={0} max={1} step={0.05} defaultVal={0.5} onChange={v => update('density', v)} accent={ACCENT} />
            <Slider label={t('chat.media.lyria_brightness', 'Brightness')} value={settings.brightness} min={0} max={1} step={0.05} defaultVal={0.5} onChange={v => update('brightness', v)} accent={ACCENT} />
            <Slider label={t('chat.media.lyria_guidance', 'Guidance')} value={settings.guidance} min={0} max={6} step={0.1} defaultVal={4} onChange={v => update('guidance', v)} accent={ACCENT} />

            <PillSelect
                label={t('chat.media.lyria_mode', 'Mode')}
                options={[
                    { value: 'QUALITY', label: t('chat.media.lyria_mode_quality', 'Quality') },
                    { value: 'DIVERSITY', label: t('chat.media.lyria_mode_diversity', 'Diversity') },
                ]}
                value={settings.mode || 'QUALITY'}
                onChange={v => update('mode', v)}
                accent={ACCENT}
            />

            <Toggle label={t('chat.media.lyria_mute_bass', 'Mute Bass')} value={!!settings.muteBass} onChange={v => update('muteBass', v)} accent={ACCENT} />
            <Toggle label={t('chat.media.lyria_mute_drums', 'Mute Drums')} value={!!settings.muteDrums} onChange={v => update('muteDrums', v)} accent={ACCENT} />
        </MediaSettingsPopover>
    );
};

export default MusicGenSettings;
