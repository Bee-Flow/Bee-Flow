import AudioPlayerInline from './AudioPlayer';
import { resolveUrl } from './messageItemHelpers';
import useTranslation from '../../../hooks/useTranslation';

/**
 * The generated-media strips rendered underneath an assistant message's text:
 * images, audio (premium player with album art) and video. Lifted verbatim out
 * of MessageItem/index.jsx — the callers still own the `!isUser && …` gates.
 */

// AI Generated Images — rendered after text (skip if album art for audio)
export const GeneratedImages = ({ msg, setLightboxImage }) => {
    const { t } = useTranslation();
    return (
    <div className="mt-3 flex flex-wrap gap-2">
        {msg.images.map((img, i) => {
            const imgSrc = resolveUrl(img.url) || (img.data ? `data:${img.mimeType};base64,${img.data}` : null);
            if (!imgSrc) return null;
            return (
            <div key={i} className="relative rounded-xl overflow-hidden border border-[var(--border-subtle)] shadow-lg group/img max-w-md">
                <img
                    src={imgSrc}
                    alt={t('chat.media.image_alt', 'AI generated image')}
                    className="w-full h-auto object-contain cursor-pointer hover:opacity-95 transition-opacity"
                    style={{ background: 'var(--bg-tertiary)', maxHeight: '400px' }}
                    onClick={() => setLightboxImage(imgSrc)}
                />
                <div className="absolute bottom-2 right-2 opacity-0 group-hover/img:opacity-100 transition-opacity">
                    <a
                        href={imgSrc}
                        download={`ai-image-${Date.now()}.png`}
                        className="flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] font-medium text-white bg-black/60 backdrop-blur-sm hover:bg-black/80 transition-colors"
                    >
                        ⬇ {t('chat.download', 'Download')}
                    </a>
                </div>
            </div>
            );
        })}
    </div>
    );
};

// AI Generated Audio — Premium Player with Album Art
export const GeneratedAudio = ({ msg }) => {
    const { t } = useTranslation();
    // Use first image in the message as album art (generated in parallel)
    const albumArt = msg.images && msg.images.length > 0
        ? (resolveUrl(msg.images[0].url) || `data:${msg.images[0].mimeType};base64,${msg.images[0].data}`)
        : null;
    // Merknamen — die vertalen niet, en dat is de reden dat ze hier als
    // gewone strings staan in plaats van achter een sleutel.
    const sourceLabel = {
        'elevenlabs_music': 'ElevenLabs Music',
        'elevenlabs_tts': 'ElevenLabs TTS',
        'elevenlabs_sfx': 'ElevenLabs SFX',
    };
    return (
        <div className="mt-3 flex flex-col gap-2">
            {msg.audioFiles.map((audio, i) => {
                const audioSrc = resolveUrl(audio.url) || (audio.data ? `data:${audio.mimeType};base64,${audio.data}` : null);
                if (!audioSrc) return null;
                return (
                    <AudioPlayerInline
                        key={i}
                        src={audioSrc}
                        albumArt={albumArt}
                        title={t(
                            audio.source?.includes('tts') ? 'chat.media.audio_speech'
                                : audio.source?.includes('sfx') ? 'chat.media.audio_sfx'
                                    : 'chat.media.audio_music',
                            audio.source?.includes('tts') ? 'AI Generated Speech'
                                : audio.source?.includes('sfx') ? 'AI Generated Sound Effect'
                                    : 'AI Generated Music',
                        )}
                        subtitle={sourceLabel[audio.source] || 'ElevenLabs'}
                    />
                );
            })}
        </div>
    );
};

// AI Generated Videos — Modern Player
export const GeneratedVideos = ({ msg }) => {
    const { t } = useTranslation();
    return (
    <div className="mt-3 flex flex-col gap-2">
        {msg.videoFiles.map((vid, i) => (
            <div key={i} className="rounded-2xl overflow-hidden max-w-lg shadow-xl"
                style={{
                    background: 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)',
                    border: '1px solid rgba(255,255,255,0.08)',
                }}>
                <div className="flex items-center gap-2 px-4 pt-3 pb-2">
                    <div className="w-8 h-8 rounded-lg flex items-center justify-center text-sm"
                        style={{ background: 'linear-gradient(135deg, #7c3aed, #4f46e5)', boxShadow: '0 4px 15px rgba(124,58,237,0.3)' }}>
                        🎬
                    </div>
                    <div>
                        <div className="text-sm font-semibold text-white">{t('chat.media.video_title', 'AI Generated Video')}</div>
                        <div className="text-[10px] text-gray-400">Veo 3.1</div>
                    </div>
                </div>
                <div className="px-3 pb-2">
                    <video
                        controls
                        className="w-full rounded-xl"
                        style={{
                            maxHeight: '400px',
                            background: '#000',
                            boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                        }}
                        src={resolveUrl(vid.url)}
                    />
                </div>
                <div className="px-4 pb-3 flex justify-end">
                    <a href={resolveUrl(vid.url)} download={`ai-video-${Date.now()}.mp4`}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-medium transition-all duration-200"
                        style={{ color: '#7c3aed', background: 'rgba(124,58,237,0.1)', border: '1px solid rgba(124,58,237,0.2)' }}
                        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(124,58,237,0.2)'; }}
                        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(124,58,237,0.1)'; }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>
                        {t('chat.media.download_mp4', 'Download MP4')}
                    </a>
                </div>
            </div>
        ))}
    </div>
    );
};


// Files a tool built (a presentation): one card per file with the two
// actions that matter — open where it lives (Nextcloud Office) or download.
// Rendered from the tool RESULT, not from the model's text, so a deck is
// never lost because the reply forgot the link.
const fileSize = (n) => (Number(n) > 0 ? (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`) : '');
/**
 * A generated deck that also lives in the library opens beside the chat —
 * the same event DocumentLinkCard dispatches, with the same fallback to the
 * Studio page when nothing claims it (a transcript rendered outside the
 * chat shell).
 */
function openLibraryDocument(id) {
    const href = `/app/studio/documents/${id}`;
    const evt = new CustomEvent('beeflow:open-document-side', { detail: { id, href }, cancelable: true });
    if (!window.dispatchEvent(evt)) return;
    window.history.pushState({ page: 'studio' }, '', href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { page: 'studio' } }));
}

/** A deck, a Word document (create_word_document) or any other file. */
function fileKind(f) {
    if (f.kind === 'presentation' || /\.pptx$/i.test(f.name || '')) return 'presentation';
    if (f.kind === 'word' || /\.docx$/i.test(f.name || '')) return 'word';
    return 'file';
}
const FILE_KIND_ICON = { presentation: '📊', word: '📝', file: '📄' };

export const GeneratedFiles = ({ msg }) => {
    const { t } = useTranslation();
    return (
        <div className="mt-3 flex flex-col gap-2" data-testid="generated-files">
            {msg.files.map((f, i) => {
                const url = resolveUrl(f.url);
                const kind = fileKind(f);
                const meta = [
                    f.slideCount ? t('chat.files.slides', '{count} slides', { count: f.slideCount }) : null,
                    fileSize(f.size) || null,
                    f.path || null,
                ].filter(Boolean).join(' · ');
                return (
                    <div key={i} className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-[var(--border-subtle)] max-w-md" style={{ background: 'var(--bg-tertiary)' }}>
                        <div className="w-9 h-9 rounded-lg flex items-center justify-center text-base shrink-0" style={{ background: 'var(--bg-secondary)' }} aria-hidden="true" data-file-kind={kind}>
                            {FILE_KIND_ICON[kind]}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium truncate" title={f.name}>{f.name || t('chat.files.file', 'File')}</div>
                            {meta && <div className="text-[11px] text-[var(--text-secondary)] truncate">{meta}</div>}
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                            {f.documentId && (
                                <button type="button" onClick={() => openLibraryDocument(f.documentId)} className="px-2.5 py-1 rounded-lg text-xs font-medium text-white" style={{ background: 'var(--accent-primary, #123a5e)' }} data-testid="generated-file-open">
                                    {t('chat.files.open', 'Open')}
                                </button>
                            )}
                            {f.webUrl && (
                                <a href={f.webUrl} target="_blank" rel="noopener noreferrer" className="px-2.5 py-1 rounded-lg text-xs font-medium text-white" style={{ background: 'var(--accent-primary, #123a5e)' }}>
                                    {t('chat.files.open_nextcloud', 'Open in Nextcloud Office')}
                                </a>
                            )}
                            {url && (
                                <a href={url} download={f.name || true} className="px-2.5 py-1 rounded-lg text-xs font-medium border border-[var(--border-subtle)] hover:bg-[var(--bg-secondary)]">
                                    {t('chat.download', 'Download')}
                                </a>
                            )}
                        </div>
                    </div>
                );
            })}
        </div>
    );
};
