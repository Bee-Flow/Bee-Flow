/**
 * The Cowork page's right-hand pane while no item is open (./CoworkPage.tsx): the promise, the home (./CoworkHome.tsx),
 * the composer, the starters while there is nothing of the owner's own yet, and the templates.
 *
 * It scrolls from the top. The pane used to centre its content in a scrolling box, and once the home had content the
 * part above the middle (the icon and the headline) was pushed out of the top, where no scroll reaches. Now the inner
 * box is at least the pane's height and centres inside that: a short page still sits in the middle, a long one starts
 * at the top and scrolls.
 */
import type { ReactNode } from 'react';
import { CalendarClock } from 'lucide-react';
import CoworkHome from './CoworkHome';
import CoworkTemplates from './CoworkTemplates';
import { CoworkWelcomeHeader, COWORK_STARTER_ITEMS } from './CoworkWelcome';
import useTranslation from '../../hooks/useTranslation';

interface CoworkHomePaneProps {
    /** The composer, with the page's own status line under it. */
    composer: ReactNode;
    hasItems: boolean;
    reloadKey: number;
    onOpen: (itemId: string) => void;
    /** A starter was picked: its text goes into the box. */
    onStarter: (text: string) => void;
    /** A template became a cowork. */
    onTemplateAdded: (itemId: string) => void;
}

/** The starters, only while there is nothing real to look at: otherwise they compete with the owner's own work. */
function Starters({ onStarter }: { onStarter: (text: string) => void }) {
    const { t } = useTranslation();
    return (
        <div className="mt-5 flex flex-col gap-2">
            {/* The keyed table: the flattened COWORK_STARTERS strings drop the keys, so they show no translation. */}
            {COWORK_STARTER_ITEMS.map(({ key, en }) => {
                const text = t(key, en);
                return (
                    <button
                        key={key}
                        type="button"
                        onClick={() => onStarter(text)}
                        data-testid="cowork-starter"
                        className="text-left px-3.5 py-2.5 rounded-xl border text-[12.5px] transition-colors hover:bg-[var(--bg-secondary)] [background:var(--bg-card)]! [border-color:var(--border-subtle)] [color:var(--text-secondary)]!"
                    >
                        {text}
                    </button>
                );
            })}
        </div>
    );
}

export default function CoworkHomePane({ composer, hasItems, reloadKey, onOpen, onStarter, onTemplateAdded }: CoworkHomePaneProps) {
    const { t } = useTranslation();
    return (
        <div className="h-full overflow-y-auto custom-scrollbar" data-testid="cowork-home-pane">
            <div className="min-h-full flex flex-col items-center justify-center px-6 py-10" data-testid="cowork-home-pane-body">
                <div className="w-full max-w-2xl">
                    <CoworkWelcomeHeader />
                    <CoworkHome onOpen={onOpen} reloadKey={reloadKey} />
                    {composer}
                    {hasItems ? (
                        <p className="mt-6 text-[13px] flex items-center gap-2 justify-center text-[var(--text-tertiary)]">
                            <CalendarClock className="w-4 h-4 flex-shrink-0" />
                            {t('cowork.pick_left', 'Or pick something on the left to see when it runs and how every run went.')}
                        </p>
                    ) : <Starters onStarter={onStarter} />}
                    <div className="flex flex-col items-center">
                        <CoworkTemplates onAdded={onTemplateAdded} />
                    </div>
                </div>
            </div>
        </div>
    );
}
