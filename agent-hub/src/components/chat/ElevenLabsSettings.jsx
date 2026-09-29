import React from 'react';
import MediaSettingsPopover from './settings/MediaSettingsPopover';
import SettingsDropdown from './settings/SettingsDropdown';
import { Slider, Toggle } from './settings/mediaControls';
import { TTS_MODELS, TTS_VOICES, DEFAULT_TTS_MODEL, DEFAULT_TTS_VOICE } from '../../constants/elevenLabsOptions';
import useMediaGenSection from '../../hooks/useMediaGenSection';
import useTranslation from '../../hooks/useTranslation';

const ACCENT = '#EC4899';

const ElevenLabsSettings = ({ isOpen, onClose }) => {
    const { t } = useTranslation();
    const [elSettings, updateEl] = useMediaGenSection('elevenlabs', isOpen);
    const [sfxSettings, updateSfx] = useMediaGenSection('sfx', isOpen);

    return (
        <MediaSettingsPopover isOpen={isOpen} onClose={onClose} icon="🎵" title="ElevenLabs">
            {/* Music */}
            <div className="flex items-center gap-1.5 pt-0.5">
                <span className="text-[10px]">🎤</span>
                <span className="text-[10px] font-semibold tracking-wide" style={{ color: 'var(--text-muted)' }}>{t('chat.media.el_music_heading', 'MUSIC (WITH VOCALS)')}</span>
            </div>
            <Slider label={t('chat.media.el_song_duration', 'Song Duration')} value={elSettings.musicDuration} min={3} max={120} step={1} defaultVal={30} unit="s" onChange={v => updateEl('musicDuration', v)} accent={ACCENT} />
            <Toggle label={t('chat.media.el_force_instrumental', 'Force Instrumental')} desc={t('chat.media.el_force_instrumental_hint', 'Guarantee no vocals')} value={!!elSettings.instrumental} onChange={v => updateEl('instrumental', v)} accent={ACCENT} />

            {/* TTS */}
            <div className="flex items-center gap-1.5 pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="text-[10px]">🗣️</span>
                <span className="text-[10px] font-semibold tracking-wide" style={{ color: 'var(--text-muted)' }}>{t('chat.media.el_tts_heading', 'TEXT-TO-SPEECH')}</span>
            </div>
            <SettingsDropdown label={t('chat.media.el_voice', 'Voice')} options={TTS_VOICES} value={elSettings.ttsVoice || DEFAULT_TTS_VOICE} onChange={v => updateEl('ttsVoice', v)} accentColor={ACCENT} />
            <SettingsDropdown label={t('chat.media.model', 'Model')} options={TTS_MODELS} value={elSettings.ttsModel || DEFAULT_TTS_MODEL} onChange={v => updateEl('ttsModel', v)} accentColor={ACCENT} />

            {/* SFX */}
            <div className="flex items-center gap-1.5 pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                <span className="text-[10px]">🔊</span>
                <span className="text-[10px] font-semibold tracking-wide" style={{ color: 'var(--text-muted)' }}>{t('chat.media.el_sfx_heading', 'SOUND EFFECTS')}</span>
            </div>
            <Slider label={t('chat.media.duration', 'Duration')} value={sfxSettings.duration} min={0.5} max={30} step={0.5} defaultVal={5} unit="s" onChange={v => updateSfx('duration', v)} accent={ACCENT} />
            <Slider label={t('chat.media.el_prompt_influence', 'Prompt Influence')} value={sfxSettings.promptInfluence} min={0} max={1} step={0.05} defaultVal={0.5} onChange={v => updateSfx('promptInfluence', v)} accent={ACCENT} />
        </MediaSettingsPopover>
    );
};

export default ElevenLabsSettings;
