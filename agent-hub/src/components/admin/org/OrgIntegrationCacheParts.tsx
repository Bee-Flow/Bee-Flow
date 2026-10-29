import { AlertTriangle, DatabaseZap, Loader2, Timer, Trash2 } from 'lucide-react';
import type { TranslateFn, TranslateParams } from '@/hooks/useTranslation';

// The pieces of OrgIntegrationCacheEditor: the two ChoiceCards, what may be kept,
// the reuse window, what is stored now, and the header and buttons.

export const MINUTES = (s: number) => Math.round(s / 60);

// An admin deciding whether to clear needs a size, not just a count — a
// thousand calendar look-ups and a thousand mail searches are not the same
// amount of somebody's data sitting in the database.
export const BYTES = (n: number) => {
    if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
    if (n >= 1024) return `${Math.round(n / 1024)} kB`;
    return `${n} B`;
};

/** Off (ask every run) or on (keep answers for a while), as ChoiceCards options. */
export function cacheModeOptions(t: TranslateFn) {
    return [
    {
        value: 'off',
        label: t('admin.integration_cache.off', 'Ask every run (recommended)'),
        description: t(
            'admin.integration_cache.off_desc',
            'Nothing an app answers is stored. An automation can still avoid asking the same thing twice inside one run — that reuse never leaves the run.',
        ),
        Icon: DatabaseZap,
    },
    {
        value: 'on',
        label: t('admin.integration_cache.on', 'Keep answers for a short while'),
        description: t(
            'admin.integration_cache.on_desc',
            'Answers are stored, encrypted, so a later run can use them instead of asking again — both what a connected app answers and what a web service call brings back. Only look-ups, never anything that changes something, and only for steps whose author asked for it. Faster and cheaper — but a run can then work from data that is a few minutes old.',
        ),
        Icon: Timer,
    },
    ];
}

/** The operator has switched the store off for the whole server. */
export function KillSwitchNotice({ t }: { t: TranslateFn }) {
    return (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
            <AlertTriangle className="mr-2 inline h-4 w-4" aria-hidden="true" />
            {t(
                'admin.integration_cache.kill_switch',
                'This is switched off for the whole server by its operator, so nothing is stored whatever you choose here.',
            )}
        </div>
    );
}

interface ScopeChecksProps {
    t: TranslateFn;
    saving: boolean;
    scopeIntegration: boolean;
    setScopeIntegration: (on: boolean) => void;
    scopeHttp: boolean;
    setScopeHttp: (on: boolean) => void;
    scopeAi: boolean;
    setScopeAi: (on: boolean) => void;
}

/** What may be kept: connected-app answers, web-service replies, AI-step answers. */
export function ScopeChecks({ t, saving, scopeIntegration, setScopeIntegration, scopeHttp, setScopeHttp, scopeAi, setScopeAi }: ScopeChecksProps) {
    return (
        <>
            <label className="flex items-start gap-2 text-sm">
                <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopeIntegration}
                    disabled={saving}
                    onChange={(e) => setScopeIntegration(e.target.checked)}
                />
                <span>
                    {t('admin.integration_cache.scope_integration', 'Answers from connected apps')}
                    <span className="block text-xs opacity-70">
                        {t('admin.integration_cache.scope_integration_desc', 'Look-ups an automation makes through an app action — a calendar, a mailbox, a ticket system.')}
                    </span>
                </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
                <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopeHttp}
                    disabled={saving}
                    onChange={(e) => setScopeHttp(e.target.checked)}
                />
                <span>
                    {t('admin.integration_cache.scope_http', 'Answers from web service calls')}
                    <span className="block text-xs opacity-70">
                        {t('admin.integration_cache.scope_http_desc', 'Replies to a "Call a web service" step, which can point at any address the automation author chooses. Only ever GET and HEAD, and never when that step is allowed to reach private addresses.')}
                    </span>
                </span>
            </label>

            <label className="flex items-start gap-2 text-sm">
                <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={scopeAi}
                    disabled={saving}
                    onChange={(e) => setScopeAi(e.target.checked)}
                />
                <span>
                    {t('admin.integration_cache.scope_ai', 'Answers from AI steps')}
                    <span className="block text-xs opacity-70">
                        {t('admin.integration_cache.scope_ai_desc', 'When an AI step asks the same question with the same (privacy-protected) input, the stored answer is reused instead of asking the model again. Stored encrypted until the window ends; never used in test runs.')}
                    </span>
                </span>
            </label>
        </>
    );
}

interface TtlPickerProps {
    t: TranslateFn;
    range: { min: number; max: number };
    ttlSeconds: number;
    setTtlSeconds: (seconds: number) => void;
    saving: boolean;
}

/** How long an answer may be reused, in whole minutes on the slider. */
export function TtlPicker({ t, range, ttlSeconds, setTtlSeconds, saving }: TtlPickerProps) {
    return (
        <>
            <label htmlFor="integration-cache-ttl" className="block text-sm font-medium pt-2">
                {t('admin.integration_cache.ttl_label', 'How long an answer may be reused')}
            </label>
            <p className="text-xs opacity-70">
                {t(
                    'admin.integration_cache.ttl_note',
                    'After this, the answer is deleted and the next run asks the app again. This is also the longest a run can be working from stale data. Shortening it applies to answers already stored, not just new ones.',
                )}
            </p>
            <div className="flex items-center gap-3">
                <input
                    id="integration-cache-ttl"
                    type="range"
                    min={range.min}
                    max={range.max}
                    step={60}
                    value={ttlSeconds}
                    onChange={(e) => setTtlSeconds(Number(e.target.value))}
                    disabled={saving}
                    className="flex-1"
                />
                <span className="w-28 shrink-0 text-sm tabular-nums">
                    {t('admin.integration_cache.ttl_minutes', '{{n}} minutes').replace('{{n}}', String(MINUTES(ttlSeconds)))}
                </span>
            </div>
        </>
    );
}

/** What is stored right now, and how much of it has already expired. */
export function StoredLine({ t, storedEntries, storedBytes, expiredEntries }: { t: TranslateFn; storedEntries: number; storedBytes: number; expiredEntries: number }) {
    return (
        <p className="text-xs opacity-70">
            {t('admin.integration_cache.held', 'Stored right now: {{n}} answer(s), {{size}}.')
                .replace('{{n}}', String(storedEntries))
                .replace('{{size}}', BYTES(storedBytes))}
            {expiredEntries > 0 && ' ' + t(
                'admin.integration_cache.held_expired',
                '{{n}} of those have already expired and are never served — they are deleted by the hourly clean-up, or by the button below.',
            ).replace('{{n}}', String(expiredEntries))}
        </p>
    );
}

export function OrgIntegrationCacheEditorHeader({ t }: { t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; }) {
    return <header>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
            <DatabaseZap className="h-5 w-5" aria-hidden="true" />
            {t('admin.integration_cache.title', 'Reusing answers between runs')}
        </h2>
        <p className="mt-1 text-sm opacity-75">
            {t(
                'admin.integration_cache.intro',
                'Automations often ask the same question over and over — of a connected app, or of a web service they call directly. This decides whether the answer may be stored so a later run can use it, which means storing what the other side sent back.'
            )}
        </p>
    </header>;
}

export function OrgIntegrationCacheEditorSection({ handleSave, isDirty, saving, t, storedEntries, handleClear, clearing }: { handleSave: () => Promise<void>; isDirty: boolean; saving: boolean; t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams | null) => string; storedEntries: number; handleClear: () => Promise<void>; clearing: boolean; }) {
    return <div className="flex flex-wrap items-center gap-3">
        <button
            type="button"
            onClick={handleSave}
            disabled={!isDirty || saving}
            className="inline-flex items-center gap-2 rounded-lg bg-[var(--accent-primary)] px-3 py-2 text-sm font-medium text-[var(--accent-primary-fg)] disabled:opacity-50"
        >
            {saving && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {t('common.save', 'Save')}
        </button>

        {storedEntries > 0 && (
            <button
                type="button"
                onClick={handleClear}
                disabled={clearing}
                className="inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm disabled:opacity-50"
            >
                {clearing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                {t('admin.integration_cache.clear', 'Delete the {{n}} stored answer(s) now').replace('{{n}}', String(storedEntries))}
            </button>
        )}
    </div>;
}
