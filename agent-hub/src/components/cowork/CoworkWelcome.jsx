/**
 * The empty-state header for Cowork, shared by the /app/work page and the
 * chat composer once the user flips the switch to Cowork.
 *
 * Flipping to Cowork changes what the box does — the next thing you type is
 * not answered here, it goes off and runs. Leaving "How can I help you?" above
 * it said the opposite of what the composer was about to do, so the heading
 * changes with the mode. Both surfaces read from this one file so the promise
 * is worded identically wherever it is made.
 */
import { Handshake } from 'lucide-react';
import React from 'react';
import useTranslation from '../../hooks/useTranslation';

// The English is still exported — it is the fallback every t() call below
// passes, and it is what a caller without a translator prints.
export const COWORK_HEADING = 'What can Bee Flow take off your plate?';
export const COWORK_SUBHEADING = 'Describe it once. It runs on its own — now, later, or every week.';

/**
 * Concrete enough to send as-is, generic enough to survive any workspace.
 *
 * Each starter carries its own key beside the English.
 *
 * `COWORK_STARTERS` — the same four sentences with the KEYS THROWN AWAY — is
 * still exported, but nothing in the product renders it any more: the Cowork
 * page did, and therefore printed English where this screen printed the
 * translation, out of one file. Render `COWORK_STARTER_ITEMS` and translate at
 * the call site. This array is what a caller with no translator at all would
 * print, and the test file below still measures against it.
 *
 * NOTE FOR WHOEVER SEEDS THE DICTIONARY: this table is a {key, en} pair list,
 * which is the shape the i18n guard only checks for files named in
 * KEY_TABLE_FILES — and this file is not one of them. Add it there, or these
 * four keys stay invisible to the guard.
 */
export const COWORK_STARTER_ITEMS = [
    { key: 'cowork.welcome.starter_ai_news', en: 'Every Monday at 09:00, summarise the AI news from the past week with source links.' },
    { key: 'cowork.welcome.starter_inbox_digest', en: 'Every weekday morning, give me a digest of what changed in my inbox overnight.' },
    { key: 'cowork.welcome.starter_progress_report', en: 'On the 1st of each month, draft a short progress report from my meeting notes.' },
    { key: 'cowork.welcome.starter_open_items', en: 'Every Friday, list the open items from this week that nobody has answered yet.' },
];

export const COWORK_STARTERS = COWORK_STARTER_ITEMS.map(s => s.en);

export function CoworkWelcomeHeader({ className = 'text-center mb-6' }) {
    const { t } = useTranslation();
    return (
        <div className={className} data-testid="cowork-welcome">
            <div
                className="inline-flex items-center justify-center w-11 h-11 rounded-2xl mb-4"
                style={{ background: 'color-mix(in srgb, var(--accent-primary) 12%, transparent)' }}
            >
                <Handshake className="w-5 h-5" style={{ color: 'var(--accent-primary)' }} />
            </div>
            <h1
                className="font-semibold"
                style={{ fontSize: 'clamp(20px, 4.5vw, 30px)', color: 'var(--text-primary)', letterSpacing: '-0.02em' }}
            >
                {t('cowork.welcome.heading', COWORK_HEADING)}
            </h1>
            <p className="mt-2 text-[13px]" style={{ color: 'var(--text-tertiary)' }}>
                {t('cowork.welcome.subheading', COWORK_SUBHEADING)}
            </p>
        </div>
    );
}

/**
 * The whole Cowork empty state as the chat surface needs it: heading, the
 * composer passed as children, then starters that fill the box rather than
 * sending anything — a schedule should never fire from a single click.
 */
export default function CoworkWelcome({ children, onStarterClick, isMobile = false }) {
    const { t } = useTranslation();
    return (
        <div className={`w-full ${isMobile ? 'max-w-full px-1' : 'max-w-3xl'} mx-auto`}>
            <CoworkWelcomeHeader />
            {children}
            <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                {COWORK_STARTER_ITEMS.map(({ key, en }) => {
                    // The click hands over the TRANSLATED sentence — it fills
                    // the box, so what lands there has to be the language the
                    // user is reading, not the English behind it.
                    const text = t(key, en);
                    return (
                        <button
                            key={key}
                            type="button"
                            onClick={() => onStarterClick && onStarterClick(text)}
                            data-testid="cowork-starter"
                            className="px-3 py-2 rounded-xl border text-[12.5px] text-left transition-colors hover:border-[var(--border-default)]"
                            style={{
                                background: 'var(--bg-card)',
                                borderColor: 'var(--border-subtle)',
                                color: 'var(--text-secondary)',
                                maxWidth: '100%',
                            }}
                        >
                            {text}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
