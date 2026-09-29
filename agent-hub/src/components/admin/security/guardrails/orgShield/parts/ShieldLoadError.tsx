import { OctagonAlert } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../hooks/useTranslation';

/**
 * The load failed, so every field would hold a constructor default, not this
 * org's configuration. Saying so, and rendering no form and no Save, is the
 * fix: the page used to show "shield off, no categories" indistinguishably
 * from a real answer, with Save live, and one click wrote that blank config
 * over the org's real one.
 */
export function ShieldLoadError({ status, t }: { status: number; t: TranslateFn }) {
    return (
        <div className="p-6">
            <div
                role="alert"
                className="flex items-start gap-3 p-4 rounded-xl border border-[var(--error)] bg-[color-mix(in_srgb,var(--error)_8%,transparent)]"
            >
                <OctagonAlert className="w-5 h-5 shrink-0 text-[var(--error-ink)]" aria-hidden="true" />
                <div>
                    <span className="text-sm font-semibold block text-[var(--error-ink)]">
                        {t('admin.shield_load_failed', 'Could not load these settings')}
                    </span>
                    <span className="text-xs block mt-0.5 leading-relaxed text-[var(--text-secondary)]">
                        {status === 403
                            ? t('admin.shield_load_failed_403', 'You do not have access to this organisation\'s privacy settings.')
                            : t('admin.shield_load_failed_desc', 'The current configuration could not be read, so nothing can be changed here safely. Saving is disabled — reload the page to try again.')}
                    </span>
                    <div className="flex gap-2 pt-2.5">
                        <button
                            type="button"
                            onClick={() => window.location.reload()}
                            className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-[var(--error-ink)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)]"
                        >
                            {t('admin.shield_reload', 'Reload')}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ShieldLoadError;
