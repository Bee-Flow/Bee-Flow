import ClipVideo from '../components/ClipVideo';
import PopupModal from '../components/PopupModal';
import type { TourData } from './motion.types';
import './tourModal.css';

const MODAL_STYLE = { width: 'min(960px, 92vw)', maxHeight: '90vh', overflow: 'hidden' } as const;

/**
 * The product-tour player in its modal. Its own chunk (TourPill loads it with
 * React.lazy on first open), so the public entry carries only the pill.
 */
export default function TourModal({ tour, title, onClose }: { tour: TourData; title: string; onClose: () => void }) {
    return (
        <PopupModal title={title} onClose={onClose} modalStyle={MODAL_STYLE}>
            <ClipVideo
                className="tour-player"
                media={{ src: tour.src, poster: tour.poster, captionsSrc: tour.captionsSrc, captionsLang: tour.captionsLang, alt: tour.alt }}
            />
        </PopupModal>
    );
}
