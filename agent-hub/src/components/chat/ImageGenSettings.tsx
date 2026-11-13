import React, { useRef, useEffect } from 'react';
import { X, Check } from 'lucide-react';
import scopedStorage from '../../utils/scopedStorage';
import useTranslation from '../../hooks/useTranslation';
import type { ImageModelOption } from '../../api/queries/composerSettings';
import { limitedWindows, type ImageLimitWindow, type ImageQuota } from '../../utils/imageLimits';
import { imageModelOptions, selectedImageModel } from './imageModelChoice';

const ASPECT_RATIOS = [
    { label: '1:1', value: '1:1', icon: '⬛' },
    { label: '16:9', value: '16:9', icon: '🖥️' },
    { label: '9:16', value: '9:16', icon: '📱' },
    { label: '4:3', value: '4:3', icon: '🖼️' },
    { label: '3:4', value: '3:4', icon: '📋' },
];

const STORAGE_KEY = 'imageGenSettings';

/** One line per limited window; each is a whole sentence so a language can word the window its own way. */
const QUOTA_LINES: Record<ImageLimitWindow, { key: string; en: string }> = {
    hour: { key: 'image_limits.quota_hour', en: '{used} of {limit} images used in the last hour' },
    day: { key: 'image_limits.quota_day', en: '{used} of {limit} images used in the last 24 hours' },
    week: { key: 'image_limits.quota_week', en: '{used} of {limit} images used in the last 7 days' },
    month: { key: 'image_limits.quota_month', en: '{used} of {limit} images used in the last 30 days' },
};

const CHOICE_ON = 'bg-[rgba(66,133,244,0.1)] text-[#4285f4] border-[rgba(66,133,244,0.25)]';
const CHOICE_OFF = 'bg-transparent text-[var(--text-secondary)] border-[var(--border-subtle)]';
const RATIO_ON = 'bg-[rgba(66,133,244,0.15)] text-[#4285f4] border-[rgba(66,133,244,0.3)]';
const RATIO_OFF = 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-subtle)]';

interface ImageGenSettingsValues {
    aspectRatio?: string;
    model?: string;
}

interface Props {
    isOpen: boolean;
    onClose: () => void;
    anchorRef?: React.RefObject<HTMLElement | null>;
    settings: ImageGenSettingsValues;
    onSettingsChange: (settings: ImageGenSettingsValues) => void;
    /** The models the server offers; absent or empty = the two Google models. */
    imageModels?: readonly ImageModelOption[] | null;
    /** The user's image limits and what is used; null = no limit. */
    imageQuota?: ImageQuota | null;
}

function loadSettings() {
    return scopedStorage.getJSON<ImageGenSettingsValues>(STORAGE_KEY, {});
}

function saveSettings(settings: ImageGenSettingsValues) {
    scopedStorage.setJSON(STORAGE_KEY, settings);
}

/** "3 of 5 images used in the last 24 hours", one line per limited window; nothing without a limit. */
function ImageQuotaLines({ quota }: { quota: ImageQuota | null | undefined }) {
    const { t } = useTranslation();
    const rows = limitedWindows(quota);
    if (rows.length === 0) return null;
    return (
        <div className="space-y-0.5" role="status">
            {rows.map(({ window, limit, used }) => (
                <p key={window} className={`text-[11px] ${used >= limit ? 'text-[var(--warning-ink)] font-medium' : 'text-[var(--text-muted)]'}`}>
                    {t(QUOTA_LINES[window].key, QUOTA_LINES[window].en, { used, limit })}
                </p>
            ))}
        </div>
    );
}

const ImageGenSettings = ({ isOpen, onClose, anchorRef, settings, onSettingsChange, imageModels, imageQuota }: Props) => {
    const { t } = useTranslation();
    const panelRef = useRef<HTMLDivElement>(null);

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handler = (e: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(e.target as Node) &&
                anchorRef?.current && !anchorRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [isOpen, onClose, anchorRef]);

    if (!isOpen) return null;

    const currentAspect = settings.aspectRatio || '1:1';
    const models = imageModelOptions(imageModels);
    const currentModel = selectedImageModel(settings.model, models);

    return (
        <div
            ref={panelRef}
            className="absolute bottom-full mb-2 left-0 w-72 rounded-xl border shadow-2xl overflow-hidden z-50 bg-[var(--bg-secondary)] border-[var(--border-subtle)]"
        >
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-subtle)]">
                <div className="flex items-center gap-2">
                    <span className="text-lg">🍌</span>
                    <span className="text-xs font-semibold text-[var(--text-primary)]">{t('chat.composer.media_image', 'Image Generation')}</span>
                </div>
                <button onClick={onClose} aria-label={t('common.close', 'Close')} title={t('common.close', 'Close')} className="p-1 rounded hover:bg-white/10 transition-colors text-[var(--text-tertiary)]">
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>

            {/* Body */}
            <div className="p-4 space-y-4">
                {/* Info */}
                <p className="text-[11px] leading-relaxed text-[var(--text-secondary)]">
                    {t('chat.media.image_gen_intro', 'Just ask the AI to generate an image in your message. It will automatically use these settings.')}
                </p>

                <ImageQuotaLines quota={imageQuota} />

                {/* Aspect Ratio */}
                <div>
                    <label className="block text-[11px] font-medium mb-2 text-[var(--text-secondary)]">
                        {t('chat.media.default_aspect_ratio', 'Default Aspect Ratio')}
                    </label>
                    <div className="flex gap-1">
                        {ASPECT_RATIOS.map(ar => (
                            <button
                                key={ar.value}
                                onClick={() => {
                                    const updated = { ...settings, aspectRatio: ar.value };
                                    onSettingsChange(updated);
                                    saveSettings(updated);
                                }}
                                className={`flex-1 flex flex-col items-center gap-0.5 py-1.5 rounded-lg text-[10px] font-medium transition-all border ${currentAspect === ar.value ? RATIO_ON : RATIO_OFF}`}
                            >
                                <span className="text-xs">{ar.icon}</span>
                                <span>{ar.label}</span>
                            </button>
                        ))}
                    </div>
                </div>

                {/* Model */}
                <div>
                    <label className="block text-[11px] font-medium mb-2 text-[var(--text-secondary)]">
                        {t('chat.media.model', 'Model')}
                    </label>
                    <div className="space-y-1">
                        {models.map(m => (
                            <button
                                key={m.id}
                                onClick={() => {
                                    const updated = { ...settings, model: m.id };
                                    onSettingsChange(updated);
                                    saveSettings(updated);
                                }}
                                aria-pressed={currentModel === m.id}
                                className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all text-left border ${currentModel === m.id ? CHOICE_ON : CHOICE_OFF}`}
                            >
                                {currentModel === m.id ? (
                                    <Check className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                                ) : (
                                    <div className="w-3.5 h-3.5 rounded-full border flex-shrink-0 border-[var(--border-subtle)]" />
                                )}
                                <span className="truncate">{m.label}</span>
                            </button>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    );
};

export { loadSettings };
export default ImageGenSettings;
