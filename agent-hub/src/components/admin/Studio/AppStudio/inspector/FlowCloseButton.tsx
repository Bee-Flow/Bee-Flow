import { X } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';

/** The ✕ in the header of the "What happens, step by step" dialog: Esc was the only way out. */
export default function FlowCloseButton({ onClose }: { onClose: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close', 'Close')}
            title={t('common.close', 'Close')}
            className="grid place-items-center w-8 h-8 rounded-md shrink-0 text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
        >
            <X size={16} aria-hidden="true" />
        </button>
    );
}
