/**
 * The builder chat's composer, in the compact box of the chat composers:
 * staged screenshots (Ctrl+V is the primary path, the attach button the
 * discoverable one), the textarea, and a toolbar with the work mode and the
 * model tier on the left, attach and Send/Stop on the right. Alt+M cycles
 * the work mode.
 */
import { ArrowUp, ImagePlus, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, ChangeEvent, KeyboardEvent, RefObject } from 'react';
import { IMAGE_ACCEPT_ATTR, MAX_IMAGES_PER_TURN, imageFilesFrom, prepareComposerImages } from './composerImages';
import { StagedImages } from './TranscriptItems';
import type { StagedImage } from './TranscriptItems';
import type { ModelTierMap } from '@/api/queries/modelTiers';
import useTranslation from '@/hooks/useTranslation';
import ModelTierSelector from '@/components/licensing/ModelTierSelector';
import WorkModePicker from '@/components/automation/Builder/chat/WorkModePicker';
import { isWorkModeShortcut, nextWorkMode } from '@/components/automation/Builder/chat/workModeShortcut';
import { ComposerShell } from '@/components/shared/ComposerBox';
import toast from '@/components/shared/Toast';
import { APP_MODE_KEY_PREFIX, APP_WORK_MODES } from './appWorkModes';

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
    workMode: string;
    /** Null: the host decides how the builder works (a pinned-tier mount), so no picker and no Alt+M. */
    onWorkModeChange: ((mode: string) => void) | null;
    alwaysPlanLarge: boolean;
    onAlwaysPlanLargeChange: (value: boolean) => void;
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

type ModeAndTierProps = Pick<BuilderComposerProps, 'busy' | 'modelTiers' | 'tier' | 'onTierChange' | 'forcedTier' | 'workMode' | 'onWorkModeChange' | 'alwaysPlanLarge' | 'onAlwaysPlanLargeChange'>;

/** The toolbar's left half: the work mode (absent on a pinned-tier mount) and the model tier. */
function ModeAndTier({ busy, modelTiers, tier, onTierChange, forcedTier, workMode, onWorkModeChange, alwaysPlanLarge, onAlwaysPlanLargeChange }: ModeAndTierProps) {
    const { t } = useTranslation();
    const hasTiers = Object.keys(modelTiers || {}).length > 0;
    return (
        <div className="flex min-w-0 items-center gap-1">
            {onWorkModeChange && <WorkModePicker
                anchor="composer"
                modes={APP_WORK_MODES}
                keyPrefix={APP_MODE_KEY_PREFIX}
                value={workMode}
                onChange={onWorkModeChange}
                alwaysPlanLarge={alwaysPlanLarge}
                onAlwaysPlanLargeChange={onAlwaysPlanLargeChange}
                disabled={busy}
            />}
            {hasTiers && (
                // portal: the composer sits at the pane's left edge, so an
                // absolute right-aligned panel would run off-screen.
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
            )}
        </div>
    );
}

/** Focus back in the textarea when a turn ends: it is disabled while busy, so it lost focus on send. */
function useRefocusAfterTurn(busy: boolean, composerRef: RefObject<HTMLTextAreaElement | null>) {
    const wasBusy = useRef(busy);
    useEffect(() => {
        if (wasBusy.current && !busy) composerRef.current?.focus?.();
        wasBusy.current = busy;
    }, [busy, composerRef]);
}

export default function BuilderComposer({
    initialPrompt, busy, composerRef, onSend, onStop, modelTiers, tier, onTierChange, forcedTier,
    workMode, onWorkModeChange, alwaysPlanLarge, onAlwaysPlanLargeChange,
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

    // Alt+M cycles the work mode from anywhere in the composer, never mid-build.
    const onShortcut = useCallback((e: KeyboardEvent<HTMLElement>) => {
        if (!onWorkModeChange || !isWorkModeShortcut(e.nativeEvent) || busy) return;
        e.preventDefault();
        onWorkModeChange(nextWorkMode(APP_WORK_MODES, workMode));
    }, [busy, onWorkModeChange, workMode]);

    useRefocusAfterTurn(busy, composerRef);
    const nothingToSend = !input.trim() && !images.length;

    return (
        <form
            className="shrink-0 p-3"
            onSubmit={(e) => { e.preventDefault(); handleSend(); }}
            onKeyDownCapture={onShortcut}
        >
            <ComposerShell compact label={t('app_studio.builder.chat.composer_form', 'Assistant message box')} testId="app-builder-composer">
                {/* Staged screenshots, each with its own remove button. */}
                {images.length ? (
                    <div className="px-3 pt-2">
                        <StagedImages images={images} onRemove={removeImage} disabled={busy} />
                    </div>
                ) : null}

                <div className="px-3 pb-0.5 pt-2">
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
                        className="max-h-[180px] w-full resize-none border-none bg-transparent py-1 text-[13.5px] leading-snug outline-none placeholder:text-[var(--text-muted)] disabled:opacity-60 [color:var(--text-primary)]!"
                    />
                </div>

                {/* Mode and model tier on the left, attach and Send/Stop opposite. */}
                <div className="flex items-center justify-between gap-2 px-2 pb-2">
                    <ModeAndTier
                        busy={busy} modelTiers={modelTiers} tier={tier} onTierChange={onTierChange} forcedTier={forcedTier}
                        workMode={workMode} onWorkModeChange={onWorkModeChange}
                        alwaysPlanLarge={alwaysPlanLarge} onAlwaysPlanLargeChange={onAlwaysPlanLargeChange}
                    />
                    <div className="flex shrink-0 items-center gap-1">
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
                                className="rounded-full bg-red-500 p-1.5 text-white shadow-sm transition-colors hover:bg-red-600 active:scale-95"
                            >
                                <Square size={16} fill="currentColor" aria-hidden="true" />
                            </button>
                        ) : (
                            <button
                                type="submit"
                                disabled={nothingToSend}
                                aria-label={t('app_studio.builder.chat.send', 'Send')}
                                title={t('app_studio.builder.chat.send_title', 'Send (Enter)')}
                                className={`rounded-full p-1.5 text-[var(--bg-primary)] shadow-sm transition-all active:scale-95 ${nothingToSend ? 'composer-send-quiet cursor-not-allowed' : 'bg-[var(--text-primary)] hover:opacity-90'}`}
                            >
                                <ArrowUp size={16} aria-hidden="true" />
                            </button>
                        )}
                    </div>
                </div>
            </ComposerShell>
        </form>
    );
}
