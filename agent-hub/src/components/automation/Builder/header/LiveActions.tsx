import { AlertTriangle, Check, Loader2, Pause, Power, Upload } from 'lucide-react';
import useTranslation from '../../../../hooks/useTranslation';
import type { LiveState } from './liveState';

export type SavingState = 'idle' | 'saving' | 'saved' | 'error';

/**
 * The autosave indicator. `settled` is what an idle or finished save reads
 * as: nothing on the Editor (the canvas speaks for itself), "Saved
 * automatically" on Settings (artboard 5b), where there is no Save button.
 * Below 1400px of bar "Saving…" and "Saved" keep only their icon (the words
 * stay the tooltip and the accessible text). "Saved automatically" keeps its
 * words and goes whole below 1180px, since a lone tick there would read as a
 * stray mark. "Not saved" always keeps its words.
 */
export function SavingPill({ state, settled = false, readOnly = false }: { state: SavingState; settled?: boolean; readOnly?: boolean }) {
    const { t } = useTranslation();
    // A managed automation saves nothing, so it never claims to have.
    if (readOnly) return null;
    const base = 'inline-flex items-center gap-[5px] text-[12px] whitespace-nowrap flex-shrink-0';
    const word = '@max-[1400px]/bar:sr-only';
    if (state === 'saving') {
        const saving = t('automations.header.saving', 'Saving…');
        return <span className={`${base} text-[var(--text-tertiary)]`} title={saving}><Loader2 size={12} className="animate-spin" /> <span className={word}>{saving}</span></span>;
    }
    if (state === 'error') {
        return (
            <span className={`${base} text-[var(--error)]`} title={t('automations.header.save_failed_title', 'Save failed, try again')}>
                <AlertTriangle size={12} /> {t('automations.header.save_failed', 'Not saved')}
            </span>
        );
    }
    if (settled) {
        const saved = t('automations.header.saved_automatically', 'Saved automatically');
        return <span className={`${base} text-[var(--text-tertiary)] @max-[1180px]/bar:hidden`}><Check size={12} /> {saved}</span>;
    }
    if (state === 'saved') {
        const saved = t('automations.header.saved', 'Saved');
        return <span className={`${base} text-[var(--success)]`} title={saved}><Check size={12} /> <span className={word}>{saved}</span></span>;
    }
    return null;
}

interface LiveActionsProps {
    live: LiveState;
    busy?: boolean;
    /**
     * An autosave is pending or in flight. Going live now would publish the
     * version before the last edit, so the primary waits for the save.
     */
    saving?: boolean;
    /** Structurally complete (a trigger and a step). */
    canActivate?: boolean;
    /** Versions tab: a never-live automation's Activate reads "Make vN live". */
    versionsView?: boolean;
    onActivate?: (() => void) | null;
    onPublish?: (() => void) | null;
    onDeactivate?: (() => void) | null;
}

const PRIMARY = 'flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12px] font-semibold whitespace-nowrap bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:brightness-95 transition disabled:opacity-50';
const SECONDARY = 'flex items-center gap-1.5 h-8 px-3 rounded-lg text-[12px] font-medium whitespace-nowrap text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] transition disabled:opacity-50';

/**
 * The right end of the bar: one filled primary per state (artboards 5a/5d),
 *   never live  → Activate (Make vN live on the Versions tab)
 *   paused      → Activate
 *   live, ahead → Make vN live, with Pause as the quiet secondary
 *   live        → Pause alone, quiet
 * The primary wears the theme's accent with its paired foreground, never the
 * artboard's ink fill.
 *
 * An automation managed by a Solution stage (`live.managed`) is read-only: "Make
 * vN live" never shows (the stage's deploy is the only way a version goes
 * live), while Pause and Activate stay. Before its first deploy there is no
 * live copy to switch on, so Activate shows disabled and says why.
 */
export default function LiveActions({ live, busy = false, saving = false, canActivate = true, versionsView = false, onActivate, onPublish, onDeactivate }: LiveActionsProps) {
    const { t } = useTranslation();
    const n = live.workingVersion ?? '';
    const makeLive = t('automations.header.make_live', 'Make v{version} live', { version: n });
    const incomplete = t('automations.header.activate_incomplete', 'Add a trigger and at least one step first');
    const waitTitle = t('automations.header.wait_for_save', 'Saving your last change first');

    let primary = null;
    if (live.managed && live.notDeployed) {
        primary = (
            <button type="button" disabled className={PRIMARY} data-testid="managed-not-deployed"
                title={t('managed_part.not_deployed', 'This part has not been deployed yet.')}>
                <Power size={13} /> <span>{t('automations.header.activate', 'Activate')}</span>
            </button>
        );
    } else if (live.primary === 'publish' && !live.managed) {
        primary = (
            <button type="button" onClick={() => onPublish?.()} disabled={busy || saving || !canActivate} className={PRIMARY}
                title={!canActivate
                    ? incomplete
                    : (saving ? waitTitle : t('automations.header.make_live_title', 'Runs use v{version} from now on', { version: n }))}>
                <Upload size={13} /> <span>{makeLive}</span>
            </button>
        );
    } else if (live.primary === 'activate') {
        const asMakeLive = versionsView && live.kind === 'never' && live.workingVersion != null;
        primary = (
            <button type="button" onClick={() => onActivate?.()} disabled={busy || saving || !canActivate} className={PRIMARY}
                title={!canActivate
                    ? incomplete
                    : (saving ? waitTitle : (live.kind === 'never'
                        ? t('automations.header.activate_first_title', 'Goes live with this version and starts listening for its trigger')
                        : t('automations.header.activate_paused_title', 'Switches the live version back on')))}>
                {asMakeLive ? <Upload size={13} /> : <Power size={13} />}
                <span>{asMakeLive ? makeLive : t('automations.header.activate', 'Activate')}</span>
            </button>
        );
    }

    return (
        <>
            {live.canPause && (
                <button type="button" onClick={() => onDeactivate?.()} disabled={busy} className={SECONDARY}
                    aria-label={t('automations.header.pause', 'Pause')}
                    title={t('automations.header.pause_title', 'Pause: stop starting new runs')}>
                    <Pause size={13} />
                    {/* Beside a primary, the quiet secondary keeps only its icon on a small bar. */}
                    <span className={live.primary ? '@max-[1400px]/bar:hidden' : ''}>{t('automations.header.pause', 'Pause')}</span>
                </button>
            )}
            {primary}
        </>
    );
}
