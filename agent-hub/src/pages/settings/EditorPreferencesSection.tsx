import React, { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import scopedStorage from '../../utils/scopedStorage';

/** The builder reads this key on mount (Builder/BuildTab.jsx). '0' = off, anything else = on. */
export const AUTO_MAP_KEY = 'autoMapOnConnect';

/**
 * Profile › Editor preferences: personal choices for the automation editor.
 * "Map fields automatically" lived in each automation's settings, but it is
 * this person's habit, not a property of the automation, so it lives here
 * (handoff 5, artboard 5b). Same storage key as before, so nobody loses it.
 */
export default function EditorPreferencesSection() {
    const { t } = useTranslation();
    const [autoMap, setAutoMap] = useState(() => scopedStorage.getItem(AUTO_MAP_KEY) !== '0');
    const toggle = () => {
        const next = !autoMap;
        setAutoMap(next);
        scopedStorage.setItem(AUTO_MAP_KEY, next ? '1' : '0');
    };
    return (
        <div data-testid="editor-preferences">
            <p className="text-[11px] font-semibold uppercase tracking-widest px-1 mb-2 text-[var(--text-muted)]">
                {t('settings.editor_preferences', 'Editor preferences')}
            </p>
            <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4 px-5 py-3.5">
                    <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-medium text-[var(--text-primary)]">
                            {t('settings.auto_map', 'Map fields automatically')}
                        </p>
                        <p className="text-[11px] mt-0.5 text-[var(--text-muted)]">
                            {t('settings.auto_map_desc', 'When you connect two steps in an automation, fill the new step\'s fields from the step before it. You can always change them.')}
                        </p>
                    </div>
                    <button
                        type="button"
                        role="switch"
                        aria-checked={autoMap}
                        aria-label={t('settings.auto_map', 'Map fields automatically')}
                        onClick={toggle}
                        className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${autoMap ? 'bg-[var(--accent-primary)]' : 'bg-[var(--border-default)]'}`}
                    >
                        <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${autoMap ? 'translate-x-5' : ''}`} />
                    </button>
                </div>
            </div>
        </div>
    );
}
