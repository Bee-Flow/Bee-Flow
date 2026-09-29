import React from 'react';
import useTranslation from '../../../hooks/useTranslation';
import Modal from '../../shared/Modal';

export default function ImageLightbox({ lightboxImage, setLightboxImage }) {
    const { t } = useTranslation();
    if (!lightboxImage) return null;
    const close = () => setLightboxImage(null);

    // Through the shared Modal for Escape, the focus trap and focus back on the
    // image that opened it. A press anywhere beside the picture still closes
    // it: on the scrim Modal does that, and inside the (invisible) panel the
    // handler below does.
    return (
        <Modal
            open
            onClose={close}
            variant="bare"
            size="auto"
            zIndex={9999}
            label={t('chat.msg.lightbox_alt', 'Generated image')}
            className="max-w-[90vw]"
        >
            <div
                className="flex items-center justify-center cursor-pointer"
                onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
            >
                <div className="relative">
                    <img
                        src={lightboxImage}
                        alt={t('chat.msg.lightbox_alt', 'Generated image')}
                        className="max-w-full max-h-[85vh] object-contain rounded-xl shadow-2xl"
                    />
                    <div className="absolute top-3 right-3 flex items-center gap-2">
                        <a
                            href={lightboxImage}
                            download={`ai-image-${Date.now()}.png`}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white bg-black/60 backdrop-blur-sm hover:bg-black/80 transition-colors"
                        >
                            ⬇ {t('chat.download', 'Download')}
                        </a>
                        <button
                            onClick={close}
                            aria-label={t('chat.msg.lightbox_close', 'Close image')}
                            title={t('chat.msg.lightbox_close', 'Close image')}
                            className="w-8 h-8 flex items-center justify-center rounded-lg text-white bg-black/60 backdrop-blur-sm hover:bg-black/80 transition-colors text-lg"
                        >
                            ✕
                        </button>
                    </div>
                </div>
            </div>
        </Modal>
    );
}
