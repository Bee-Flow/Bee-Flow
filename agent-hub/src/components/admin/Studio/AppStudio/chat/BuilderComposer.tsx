/**
 * The builder chat's composer: the textarea, staged screenshots (Ctrl+V is
 * the primary path, the attach button the discoverable one), Send/Stop and
 * the model tier picker.
 */
import { ImagePlus, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, ChangeEvent, KeyboardEvent, RefObject } from 'react';
import { IMAGE_ACCEPT_ATTR, MAX_IMAGES_PER_TURN, imageFilesFrom, prepareComposerImages as prepareComposerImagesJs } from './composerImages';
import { StagedImages } from './TranscriptItems';
import type { StagedImage } from './TranscriptItems';
import type { ModelTierMap } from '../../../../../api/queries/modelTiers';
import useTranslation from '../../../../../hooks/useTranslation';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import ModelTierSelector from '../../../../licensing/ModelTierSelector';
import toast from '../../../../shared/Toast';

// composerImages.js defaults `t` to null, which would type it as null-only.
const prepareComposerImages = prepareComposerImagesJs as unknown as (
    files: FileList | File[], alreadyStaged: number, t: TranslateFn,
) => Promise<{ images: StagedImage[]; errors: string[] }>;

interface BuilderComposerProps {
    initialPrompt: string;
    busy: boolean;
    composerRef: RefObject<HTMLTextAreaElement | null>;
    /** Starts a turn with the text and the attached pictures (data URLs). */
    onSend: (text: string, images: string[]) => void;
    onStop: () => void;
    modelTiers: ModelTierMap | null | undefined;
    tier: string;
    onTierChange: (tier: string) => void;
    /** A tier pinned by the host: shown, but the picker cannot change it. */
    forcedTier: string | null;
}

/** Screenshots staged until send, and the three ways they arrive. */
function useStagedImages(busy: boolean) {
    const { t } = useTranslation();
    const [images, setImages] = useState<StagedImage[]>([]);
    // Read by the async staging path (which starts before the next render) so
    // back-to-back pastes count against the same budget.
    const imagesRef = useRef(images);
    useEffect(() => { imagesRef.current = images; }, [images]);

    // Stage image files from a paste, a drop or the file picker. Errors are
    // per-file, so one unusable screenshot never swallows the rest.
    const stageImageFiles = useCallback(async (files: FileList | File[] | null) => {
        if (!files || !files.length) return;
        const staged = imagesRef.current;
        const { images: added, errors } = await prepareComposerImages(files, staged.length, t);
        if (added.length) setImages((prev) => [...prev, ...added].slice(0, MAX_IMAGES_PER_TURN));
        for (const err of errors) toast.error(err);
    }, [t]);

    // Ctrl+V of a screenshot — the primary way a user shows the builder what
    // they want. Only swallow the paste when it actually carries an image, so
    // pasting text keeps working exactly as before.
    const onPaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
        if (busy) return;
        const files = imageFilesFrom(e.clipboardData) as File[];
        if (!files.length) return;
        e.preventDefault();
        stageImageFiles(files);
    }, [busy, stageImageFiles]);

    const onPickFiles = useCallback((e: ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        stageImageFiles(files);
        // Reset so picking the SAME file twice still fires a change event.
        e.target.value = '';
    }, [stageImageFiles]);

    const removeImage = useCallback((id: string) => {
        setImages((prev) => prev.filter((img) => img.id !== id));
    }, []);

    return { images, setImages, onPaste, onPickFiles, removeImage };
}

function AttachButton({ full, onPickFiles }: { full: boolean; onPickFiles: (e: ChangeEvent<HTMLInputElement>) => void }) {
    const { t } = useTranslation();
    const fileInputRef = useRef<HTMLInputElement>(null);
    return (
        <>
            <input
                ref={fileInputRef}
                type="file"
                accept={IMAGE_ACCEPT_ATTR}
                multiple
                onChange={onPickFiles}
                className="hidden"
                data-testid="app-builder-image-input"
                aria-hidden="true"
                tabIndex={-1}
            />
            <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                disabled={full}
                aria-label={t('app_studio.builder.chat.attach', 'Attach an image')}
                title={full
                    ? t('app_studio.builder.chat.attach_limit', 'You can attach up to {n} images', { n: MAX_IMAGES_PER_TURN })
                    : t('app_studio.builder.chat.attach_title', 'Attach an image (or paste a screenshot)')}
                className="rounded-md p-1.5 transition-opacity disabled:opacity-40 text-[var(--text-tertiary)]"
            >
                <ImagePlus size={16} aria-hidden="true" />
            </button>
        </>
    );
}

export default function BuilderComposer({
    initialPrompt, busy, composerRef, onSend, onStop, modelTiers, tier, onTierChange, forcedTier,
}: BuilderComposerProps) {
    const { t } = useTranslation();
    // initialPrompt (e.g. a "Remix with AI" prefill) seeds the composer once so
    // the user can tweak and send, rather than firing a turn unprompted.
    const [input, setInput] = useState(initialPrompt || '');
    const { images, setImages, onPaste, onPickFiles, removeImage } = useStagedImages(busy);

    const handleSend = useCallback(() => {
        const text = input.trim();
        const attached = images.map((img) => img.dataUrl);
        if ((!text && !attached.length) || busy) return;
        setInput('');
        setImages([]);
        onSend(text, attached);
    }, [input, images, busy, onSend, setImages]);

    const onKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    }, [handleSend]);

    return (
        <form
            className="shrink-0 border-t p-2 border-[var(--border-default)]"
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
        >
            <div
                className="flex flex-col gap-1.5 rounded-lg border px-2 py-1.5 border-[var(--border-default)] bg-[var(--bg-secondary)]"
            >
                {/* Staged screenshots, each with its own remove button. */}
                <StagedImages images={images} onRemove={removeImage} disabled={busy} />

                <div className="flex items-end gap-1.5">
                    <textarea
                        ref={composerRef}
                        rows={2}
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        disabled={busy}
                        data-app-ai-composer=""
                        placeholder={busy ? t('app_studio.builder.chat.placeholder_busy', 'The AI is building…') : t('app_studio.builder.chat.placeholder', 'Describe a change, or paste a screenshot…')}
                        aria-label={t('app_studio.builder.chat.composer_aria', 'Message the AI builder')}
                        className="max-h-32 flex-1 resize-none bg-transparent text-sm outline-none disabled:opacity-60"
                        style={{ color: 'var(--text-primary)' }}
                    />
                    {/* Attach: the discoverable twin of Ctrl+V. Hidden while a
                        build runs, like every other composer control. */}
                    {!busy ? <AttachButton full={images.length >= MAX_IMAGES_PER_TURN} onPickFiles={onPickFiles} /> : null}
                    {/* While a build runs every other control is disabled, so
                    Stop takes the Send slot — otherwise there is no way
                    out of a turn that is going the wrong way. */}
                    {busy ? (
                        <button
                            type="button"
                            onClick={onStop}
                            aria-label={t('app_studio.builder.chat.stop', 'Stop')}
                            title={t('app_studio.builder.chat.stop_title', 'Stop building')}
                            className="rounded-md p-1.5 transition-opacity text-[var(--accent-primary)]"
                        >
                            <Square size={14} fill="currentColor" aria-hidden="true" />
                        </button>
                    ) : (
                        <button
                            type="submit"
                            disabled={!input.trim() && !images.length}
                            aria-label={t('app_studio.builder.chat.send', 'Send')}
                            title={t('app_studio.builder.chat.send_title', 'Send (Enter)')}
                            className="rounded-md p-1.5 transition-opacity disabled:opacity-40 text-[var(--accent-primary)]"
                        >
                            <Send size={16} aria-hidden="true" />
                        </button>
                    )}
                </div>
            </div>
            {Object.keys(modelTiers || {}).length > 0 && (
                <div className="mt-1.5 flex items-center">
                    {/* portal: the composer sits at the pane's left edge, so an
                        absolute right-aligned panel would run off-screen. */}
                    <span
                        className={forcedTier ? 'pointer-events-none opacity-60' : undefined}
                        aria-disabled={forcedTier ? 'true' : undefined}
                        title={forcedTier ? t('app_studio.builder.chat.tier_pinned', 'The tier is set by the playbook') : undefined}
                    >
                        <ModelTierSelector
                            tiers={modelTiers || undefined}
                            value={tier}
                            onChange={forcedTier ? () => {} : onTierChange}
                            variant="input"
                            portal
                        />
                    </span>
                </div>
            )}
        </form>
    );
}
