/**
 * The sheet everything on the Cowork page opens in: a task, Settings, Teamwork, Templates, Organisation. It slides in
 * from the right (full screen on a phone), over a scrim; Escape, the scrim and Close close it. The focus moves into it
 * (onto Close) when it opens, stays inside while it is open, and goes back to what opened it when it closes.
 *
 * Built on the shared Modal (../shared/Modal.tsx, right placement): its focus trap, its Escape that only the top
 * dialog hears, its focus return and its slide-in, which stands still under reduced motion. What the sheet shows is
 * the caller's (./CoworkPage.tsx, through ./coworkSheetPanels.ts).
 */
import { X } from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import Modal from '../shared/Modal';
import { LINK_BUTTON } from './coworkUi';
import { useTranslation } from '@/hooks/useTranslation';

interface CoworkSheetProps {
    open: boolean;
    /** What the sheet is, for a screen reader: the task's title, "Settings", … */
    label: string;
    onClose: () => void;
    children: ReactNode;
}

export default function CoworkSheet({ open, label, onClose, children }: CoworkSheetProps) {
    const { t } = useTranslation();
    const close = useRef<HTMLButtonElement>(null);
    return (
        <Modal
            open={open}
            onClose={onClose}
            placement="right"
            variant="bare"
            size="auto"
            label={label}
            initialFocus={close}
            data-testid="cowork-sheet"
            className="w-full sm:max-w-[580px] max-sm:rounded-none bg-[var(--bg-primary)] text-[var(--text-primary)] shadow-[var(--shadow-lg)] overflow-hidden"
        >
            <div className="flex items-center justify-end px-4 pt-2.5 pb-1.5 flex-shrink-0">
                <button ref={close} type="button" className={LINK_BUTTON} onClick={onClose} data-testid="cowork-sheet-close">
                    <X aria-hidden="true" className="w-4 h-4" />
                    {t('cowork_home.sheet.close', 'Close')}
                </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar px-4 sm:px-6 pb-12 pt-1.5 flex flex-col">
                {children}
            </div>
        </Modal>
    );
}
