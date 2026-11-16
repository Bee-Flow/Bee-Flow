import EmojiPicker from 'emoji-picker-react';
import { Upload, X, Loader2, Image as ImageIcon, Smile, Sparkles } from 'lucide-react';
import React, { useId, useState, useRef } from 'react';
import Modal from '../shared/Modal';
import { toast } from '../shared/Toast';
import { useTranslation } from '../../hooks/useTranslation';
import type { EmojiClickData } from 'emoji-picker-react';
import type { CustomIcon } from '../../hooks/useIconPack';
import { errorMessage } from '../../utils/caughtError';
import { ApiError, errorBody, RefusedError } from '../../api/mutate';
import { apiRequest } from '@/api/typedRequest';
import type { ImageModelOption } from '@/api/queries/composerSettings';

interface IconPickerModalProps {
    isOpen: boolean;
    onClose: () => void;
    iconKey: string;
    iconLabel?: string;
    defaultEmoji?: string;
    currentCustom?: CustomIcon | null;
    onApply: (icon: CustomIcon | null) => void;
    /** At least one image model is configured; without it there is no AI tab. */
    canGenerate?: boolean;
    /** The configured image models (composerSettings `imageModels`); null when the server sent no list. */
    imageModels?: ImageModelOption[] | null;
}

const tabClass = (active: boolean) => `flex-1 py-3 text-sm font-medium transition-colors border-b-2 ${active
    ? 'border-[var(--accent-primary)] text-[var(--accent-primary)]'
    : 'border-transparent text-[var(--text-secondary)]'}`;

function IconPickerModal({ isOpen, onClose, iconKey, iconLabel, defaultEmoji, currentCustom, onApply, canGenerate = false, imageModels = null }: IconPickerModalProps) {
    const { t } = useTranslation();
    const [tab, setTab] = useState<'emoji' | 'image' | 'ai'>('emoji');
    const [prompt, setPrompt] = useState('');
    const [model, setModel] = useState('');
    const [generating, setGenerating] = useState(false);
    const [uploading, setUploading] = useState(false);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const titleId = useId();
    const modelId = useId();
    const models = imageModels ?? [];
    // The chosen model, or the first configured one; none (no list) lets the server pick its default.
    const chosenModel = models.some((m) => m.id === model) ? model : models[0]?.id;

    if (!isOpen) return null;

    const handleEmojiClick = (emojiData: EmojiClickData) => {
        onApply({ type: 'emoji', value: emojiData.emoji });
    };

    const handleUploadClick = () => fileInputRef.current?.click();

    const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (file.size > 2 * 1024 * 1024) {
            toast.error('File too large. Max 2MB.');
            return;
        }

        setUploading(true);
        const formData = new FormData();
        formData.append('icon', file);

        try {
            const res = await apiRequest('POST /api/icons/upload', { init: { body: formData } }).catch((err: unknown) => {
                if (err instanceof ApiError) return null;
                throw err;
            });
            if (res) {
                const data = await res.json();
                onApply({ type: 'image', value: data.url });
            } else {
                toast.error('Upload failed');
            }
        } catch (err) {
            console.error('Upload Error:', err);
        }
        setUploading(false);
    };

    const handleGenerate = async () => {
        if (!prompt.trim()) return;
        setGenerating(true);
        try {
            let res: Response | undefined;
            try {
                res = await apiRequest('POST /api/icons/generate', {
                    body: {
                    prompt,
                    model: chosenModel,
                    aspectRatio: '1:1',
                },
                });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const data = errorBody(err) ?? {};
                toast.error(data.error || t('icon_gen.failed', 'Generating the icon failed.'));
            }
            if (res) {
                const data = await res.json();
                if (data.url) onApply({ type: 'image', value: data.url });
                else toast.error(t('icon_gen.no_image', 'No image came back. Try a different description.'));
            }
        } catch (err) {
            console.error('Generate Error:', err);
            toast.error(t('icon_gen.failed_reason', 'Generating the icon failed: {reason}', { reason: errorMessage(err) }));
        }
        setGenerating(false);
    };

    const handleClear = () => onApply(null);

    // Through the shared Modal: Escape closes it, Tab stays inside, focus
    // returns to the icon tile. The backdrop never closed it and still does
    // not.
    return (
        <Modal open onClose={onClose} disableBackdropClose variant="bare" size="md" zIndex={100} labelledBy={titleId}>
            <div className="w-full rounded-xl shadow-2xl border overflow-hidden flex flex-col bg-[var(--bg-secondary)] border-[var(--border-default)]">
                <div className="p-4 border-b flex items-center justify-between border-[var(--border-subtle)]">
                    <div>
                        <h2 id={titleId} className="text-lg font-semibold flex items-center gap-2 text-[var(--text-primary)]">
                            <span>{t('common.icon_picker.title', 'Change emoji:')}</span>
                            {defaultEmoji && <span className="text-xl leading-none" aria-hidden>{defaultEmoji}</span>}
                            <span>{iconLabel || iconKey}</span>
                        </h2>
                        <p className="text-xs mt-1 text-[var(--text-muted)]">
                            {canGenerate
                                ? t('common.icon_picker.subtitle', 'Pick an emoji, upload an image, or generate one with AI. Default: {default}', { default: defaultEmoji || iconKey })
                                : t('icon_gen.picker_subtitle_no_ai', 'Pick an emoji or upload an image. Default: {default}', { default: defaultEmoji || iconKey })}
                        </p>
                    </div>
                    <button onClick={onClose} className="p-2 rounded-lg transition-colors hover:bg-black/5 dark:hover:bg-white/5">
                        <X className="w-5 h-5 text-[var(--text-secondary)]" />
                    </button>
                </div>

                <div className="flex border-b border-[var(--border-subtle)]">
                    <button onClick={() => setTab('emoji')} className={tabClass(tab === 'emoji')}>
                        <span className="flex items-center justify-center gap-2"><Smile className="w-4 h-4"/> {t('common.icon_picker.tab_emoji', 'Emoji')}</span>
                    </button>
                    <button onClick={() => setTab('image')} className={tabClass(tab === 'image')}>
                        <span className="flex items-center justify-center gap-2"><Upload className="w-4 h-4"/> {t('common.icon_picker.tab_upload', 'Upload')}</span>
                    </button>
                    {canGenerate && (
                        <button onClick={() => setTab('ai')} className={tabClass(tab === 'ai')}>
                            <span className="flex items-center justify-center gap-2"><Sparkles className="w-4 h-4"/> {t('icon_gen.generate_with_ai', 'Generate with AI')}</span>
                        </button>
                    )}
                </div>

                <div className="flex-1 p-4 min-h-[350px] flex">
                    {tab === 'emoji' && (
                        <div className="w-full h-full flex items-center justify-center">
                            <EmojiPicker onEmojiClick={handleEmojiClick} width="100%" />
                        </div>
                    )}

                    {tab === 'image' && (
                        <div className="flex-1 flex flex-col items-center justify-center gap-4">
                            <input type="file" ref={fileInputRef} className="hidden" accept="image/*" onChange={handleFileChange} />
                            <div 
                                onClick={handleUploadClick}
                                className="w-full max-w-xs aspect-square border-2 border-dashed rounded-2xl flex flex-col items-center justify-center p-6 text-center cursor-pointer transition-colors hover:bg-black/5 dark:hover:bg-white/5 border-[var(--border-subtle)]"
                            >
                                {uploading ? <Loader2 className="w-8 h-8 animate-spin mb-3 text-[var(--accent-primary)]" /> : <ImageIcon className="w-8 h-8 mb-3 text-[var(--text-muted)]" />}
                                <h3 className="font-semibold text-[var(--text-primary)]">{t('common.icon_picker.click_upload', 'Click to upload')}</h3>
                                <p className="text-xs mt-1 text-[var(--text-muted)]">{t('common.icon_picker.upload_hint', 'PNG, JPG, WEBP (Max 2MB)')}</p>
                            </div>
                        </div>
                    )}

                    {tab === 'ai' && canGenerate && (
                        <div className="flex-1 flex flex-col">
                            <p className="text-sm mb-4 p-3 rounded-lg border bg-[var(--bg-tertiary)] border-[var(--border-subtle)] text-[var(--text-primary)]">
                                {t('icon_gen.picker_hint', 'Describe the icon you want. It is made with the image model chosen below.')}
                            </p>
                            <textarea
                                value={prompt}
                                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPrompt(e.target.value)}
                                placeholder={t('common.icon_picker.prompt_placeholder', 'A minimalist 3D icon of a glowing orb...')}
                                className="w-full p-3 rounded-xl border resize-none h-32 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--accent-primary)] bg-[var(--bg-primary)] border-[var(--border-subtle)] text-[var(--text-primary)]"
                            />
                            {models.length > 0 && (
                                <div className="mt-3">
                                    <label htmlFor={modelId} className="block text-xs font-medium mb-1 text-[var(--text-secondary)]">{t('icon_gen.image_model', 'Image model')}</label>
                                    <select
                                        id={modelId}
                                        value={chosenModel}
                                        onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setModel(e.target.value)}
                                        className="w-full rounded-lg border px-2 py-1.5 text-sm bg-[var(--bg-primary)] border-[var(--border-subtle)] text-[var(--text-primary)] outline-none focus:border-[var(--accent-primary)]"
                                    >
                                        {models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                                    </select>
                                </div>
                            )}
                            <div className="mt-auto pt-4 flex justify-end">
                                <button
                                    onClick={handleGenerate}
                                    disabled={generating || !prompt.trim()}
                                    className="px-6 py-2.5 rounded-lg font-medium bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2 transition-opacity"
                                >
                                    {generating && <Loader2 className="w-4 h-4 animate-spin" />}
                                    {t('icon_gen.picker_generate', 'Generate icon')}
                                </button>
                            </div>
                        </div>
                    )}
                </div>

                <div className="p-4 border-t flex justify-between items-center border-[var(--border-subtle)] bg-[var(--bg-primary)]">
                    <button 
                        onClick={handleClear}
                        disabled={!currentCustom}
                        className="text-sm text-red-500 px-4 py-2 rounded-lg font-medium transition-colors hover:bg-red-500 hover:bg-opacity-10 disabled:opacity-50 disabled:hover:bg-transparent"
                    >
                        {t('common.icon_picker.reset', 'Reset to Default')}
                    </button>
                    {currentCustom && (
                        <div className="flex items-center gap-3 text-sm font-medium px-4 py-2 rounded-lg shadow-sm border bg-[var(--bg-secondary)] border-[var(--border-subtle)] text-[var(--text-primary)]">
                            <span className="text-[var(--text-muted)]">Current:</span>
                            {currentCustom.type === 'emoji' ? (
                                <span className="text-xl">{currentCustom.value}</span>
                            ) : (
                                <img src={currentCustom.value} alt="" className="w-6 h-6 object-contain" />
                            )}
                        </div>
                    )}
                </div>
            </div>
        </Modal>
    );
}

export default IconPickerModal;
