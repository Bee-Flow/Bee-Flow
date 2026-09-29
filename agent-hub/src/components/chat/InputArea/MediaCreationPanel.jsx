/**
 * MediaCreationPanel — the "🎨 Create image, music, video" flyout, and the four
 * settings panels behind it.
 *
 * One row in the composer's "+" menu opens this; the row is gated there, and
 * each generator inside is gated again by the flag the composer passes down —
 * an org that has switched off video generation, or an account with no Google
 * key, must not see the entry at all.
 *
 * Which generators are OPEN, what the image generator is set to, and which of
 * them the user has dimmed (right-click on a row, persisted per user through
 * scopedStorage) are all local to this panel: nothing outside it reads them,
 * and the composer is smaller for not carrying them. The one piece of state
 * that stays with the composer is whether the flyout itself is open, because
 * the menu row and this panel must agree about that — hence `open` /
 * `onOpenChange` rather than a second copy of the truth.
 *
 * `enabled` is a prop rather than a conditional mount on the caller's side so
 * that an org flag arriving late does not throw away a panel the user had
 * already opened.
 */
import React, { useEffect, useRef, useState } from 'react';

import useTranslation from '../../../hooks/useTranslation';
import scopedStorage from '../../../utils/scopedStorage';
import ElevenLabsSettings from '../ElevenLabsSettings';
import ImageGenSettings, { loadSettings } from '../ImageGenSettings';
import MusicGenSettings from '../MusicGenSettings';
import VideoGenSettings from '../VideoGenSettings';

const MediaCreationPanel = ({
    enabled,
    open,
    onOpenChange,
    showImageGen,
    showMusicGen,
    showElevenLabs,
    showVideoGen,
}) => {
    const { t } = useTranslation();
    const [imageGenOpen, setImageGenOpen] = useState(false);
    const [imageGenSettings, setImageGenSettings] = useState(loadSettings);
    const [musicGenOpen, setMusicGenOpen] = useState(false);
    const [elevenLabsOpen, setElevenLabsOpen] = useState(false);
    const [videoGenOpen, setVideoGenOpen] = useState(false);
    // Per-integration enable/disable — user-scoped so toggling "disable images"
    // as user A doesn't persist into user B's composer on the same browser.
    const [disabledMedia, setDisabledMedia] = useState(() => scopedStorage.getJSON('disabledMedia', {}));
    const imageGenBtnRef = useRef(null);
    const musicGenBtnRef = useRef(null);
    const elevenLabsBtnRef = useRef(null);
    const videoGenBtnRef = useRef(null);
    const mediaMenuRef = useRef(null);

    // Close media menu on click outside
    useEffect(() => {
        if (!open) return;
        const handler = (e) => {
            if (mediaMenuRef.current?.contains(e.target)) return;
            onOpenChange(false);
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [open, onOpenChange]);

    if (!enabled) return null;

    return (
        <div className="relative">
            {open && (
                <div
                    ref={mediaMenuRef}
                    className="absolute bottom-full left-0 mb-2 bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-xl shadow-xl p-1.5 min-w-[180px] z-50"
                >
                    {showImageGen && (
                        <button
                            ref={imageGenBtnRef}
                            onClick={() => { onOpenChange(false); setImageGenOpen(true); }}
                            onContextMenu={(e) => { e.preventDefault(); const next = { ...disabledMedia, image: !disabledMedia.image }; setDisabledMedia(next); scopedStorage.setJSON('disabledMedia', next); }}
                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-sm text-left"
                            style={{ opacity: disabledMedia.image ? 0.35 : 1 }}
                        >
                            <span className="text-base">🍌</span>
                            <span className="text-[var(--text-primary)]">{t('chat.composer.media_image', 'Image Generation')}</span>
                        </button>
                    )}
                    {showMusicGen && (
                        <button
                            ref={musicGenBtnRef}
                            onClick={() => { onOpenChange(false); setMusicGenOpen(true); }}
                            onContextMenu={(e) => { e.preventDefault(); const next = { ...disabledMedia, music: !disabledMedia.music }; setDisabledMedia(next); scopedStorage.setJSON('disabledMedia', next); }}
                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-sm text-left"
                            style={{ opacity: disabledMedia.music ? 0.35 : 1 }}
                        >
                            <span className="text-base">🎹</span>
                            <span className="text-[var(--text-primary)]">{t('chat.composer.media_music', 'Music Generation')}</span>
                        </button>
                    )}
                    {showElevenLabs && (
                        <button
                            ref={elevenLabsBtnRef}
                            onClick={() => { onOpenChange(false); setElevenLabsOpen(true); }}
                            onContextMenu={(e) => { e.preventDefault(); const next = { ...disabledMedia, elevenlabs: !disabledMedia.elevenlabs }; setDisabledMedia(next); scopedStorage.setJSON('disabledMedia', next); }}
                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-sm text-left"
                            style={{ opacity: disabledMedia.elevenlabs ? 0.35 : 1 }}
                        >
                            <span className="text-base">🎵</span>
                            <span className="text-[var(--text-primary)]">ElevenLabs</span>
                        </button>
                    )}
                    {showVideoGen && (
                        <button
                            ref={videoGenBtnRef}
                            onClick={() => { onOpenChange(false); setVideoGenOpen(true); }}
                            onContextMenu={(e) => { e.preventDefault(); const next = { ...disabledMedia, video: !disabledMedia.video }; setDisabledMedia(next); scopedStorage.setJSON('disabledMedia', next); }}
                            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-[var(--bg-tertiary)] transition-colors text-sm text-left"
                            style={{ opacity: disabledMedia.video ? 0.35 : 1 }}
                        >
                            <span className="text-base">🎬</span>
                            <span className="text-[var(--text-primary)]">{t('chat.composer.media_video', 'Video Generation')}</span>
                        </button>
                    )}
                </div>
            )}
            <ImageGenSettings
                isOpen={imageGenOpen}
                onClose={() => setImageGenOpen(false)}
                anchorRef={imageGenBtnRef}
                settings={imageGenSettings}
                onSettingsChange={setImageGenSettings}
            />
            <MusicGenSettings
                isOpen={musicGenOpen}
                onClose={() => setMusicGenOpen(false)}
                anchorRef={musicGenBtnRef}
            />
            <ElevenLabsSettings
                isOpen={elevenLabsOpen}
                onClose={() => setElevenLabsOpen(false)}
                anchorRef={elevenLabsBtnRef}
            />
            <VideoGenSettings
                isOpen={videoGenOpen}
                onClose={() => setVideoGenOpen(false)}
                anchorRef={videoGenBtnRef}
            />
        </div>
    );
};

export default MediaCreationPanel;
