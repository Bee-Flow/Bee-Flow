/**
 * The incognito switch of a new chat: a ghost next to the Chat ⇄ Cowork
 * switch. Like that switch it disappears once the thread has a message in it:
 * a conversation that has started is either stored or it is not, and there is
 * no honest way to change that halfway. Starting a new chat is how you pick
 * again, and a new chat always starts in normal mode.
 */
import { Ghost } from 'lucide-react';
import React from 'react';
import Tooltip from '@/components/shared/Tooltip';
import { useTranslation } from '@/hooks/useTranslation';

interface IncognitoToggleProps {
    on: boolean;
    onChange: (on: boolean) => void;
    /** The first message was sent: the mode is settled. */
    locked: boolean;
}

export default function IncognitoToggle({ on, onChange, locked }: IncognitoToggleProps) {
    const { t } = useTranslation();
    if (locked) return null;
    const hint = on
        ? t('incognito.toggle_hint_on', 'Incognito is on. Click to turn it off before you send the first message')
        : t('incognito.toggle_hint_off', 'Start an incognito chat: nothing is saved and no memory is used');
    return (
        <Tooltip content={hint} side="bottom">
            <button
                type="button"
                aria-pressed={on}
                aria-label={t('incognito.toggle_label', 'Incognito chat')}
                data-testid="incognito-toggle"
                onClick={() => onChange(!on)}
                className={`inline-flex h-7 w-7 items-center justify-center rounded-full border transition-colors motion-reduce:transition-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)] ${
                    on
                        ? 'border-[var(--text-primary)] bg-[var(--text-primary)] text-[var(--bg-primary)]'
                        : 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                }`}
            >
                <Ghost className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
        </Tooltip>
    );
}
