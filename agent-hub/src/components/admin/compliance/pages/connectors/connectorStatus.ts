import { formatDayTime } from '../../shared/formatDates';

/**
 * connectorStatus: the one status vocabulary of an ISO evidence connector,
 * shared by the register (ConnectorsPage) and its drawer (ConnectorDrawer),
 * so the two can never disagree about the same sweep.
 *
 *   off                  !enabled                      neutral
 *   never swept          on, no last_sweep_at          warning
 *   last sweep failed    last_status 'error'           error
 *   swept with findings  swept, but last_error is set  warning
 *   collecting           swept cleanly                 success
 *
 * The order matters: a connector that has swept is never "never swept",
 * whatever word its last_status holds (the server writes 'ok' or 'error';
 * anything else used to fall through to "Never swept").
 *
 * Sweeps run every six hours plus on demand. The next one is expected at
 * `last_sweep_at + 6 h`; it is only worth a warning once a whole interval has
 * gone by after that (a background job, not a legal deadline: no clock).
 */

export const SWEEP_INTERVAL_HOURS = 6;
const HOUR_MS = 3_600_000;

export type ConnectorTone = 'neutral' | 'warning' | 'error' | 'success';
export type ConnectorState = 'off' | 'never' | 'failed' | 'findings' | 'collecting';

export interface ConnectorConfig {
    enabled?: boolean | null;
    last_sweep_at?: string | null;
    last_status?: string | null;
    last_error?: string | null;
}

const pad = (n: number) => String(n).padStart(2, '0');

type Translate = (key: string, fallback: string, params?: Record<string, unknown>) => string;

function sweptMs(cfg: ConnectorConfig | null | undefined): number | null {
    const at = cfg?.last_sweep_at;
    if (!at) return null;
    const ms = new Date(at).getTime();
    return Number.isNaN(ms) ? null : ms;
}

export function connectorState(cfg: ConnectorConfig | null | undefined): ConnectorState {
    if (!cfg?.enabled) return 'off';
    if (!cfg.last_sweep_at) return 'never';
    if (cfg.last_status === 'error') return 'failed';
    if (cfg.last_error) return 'findings';
    return 'collecting';
}

const TONE: Readonly<Record<ConnectorState, ConnectorTone>> = Object.freeze({
    off: 'neutral', never: 'warning', failed: 'error', findings: 'warning', collecting: 'success',
});

export function toneOfConnector(cfg: ConnectorConfig | null | undefined): ConnectorTone {
    return TONE[connectorState(cfg)];
}

export function statusLabel(t: Translate, cfg: ConnectorConfig | null | undefined): string {
    switch (connectorState(cfg)) {
        case 'off': return t('compliance.conn_status_off', 'Off');
        case 'never': return t('compliance.conn_never_swept', 'Never swept');
        case 'failed': return t('compliance.conn_status_error', 'Last sweep failed');
        case 'findings': return t('compliance.conn_status_findings', 'Swept with findings');
        default: return t('compliance.conn_status_ok', 'Collecting');
    }
}

/** The expected next sweep (ISO), or null when nothing has swept yet. */
export function nextSweepAt(cfg: ConnectorConfig | null | undefined, hours = SWEEP_INTERVAL_HOURS): string | null {
    const ms = sweptMs(cfg);
    return ms === null ? null : new Date(ms + hours * HOUR_MS).toISOString();
}

/** True once the expected next sweep is more than one whole interval overdue. */
export function sweepIsLate(cfg: ConnectorConfig | null | undefined, now: number = Date.now(), hours = SWEEP_INTERVAL_HOURS): boolean {
    const ms = sweptMs(cfg);
    if (ms === null || !cfg?.enabled) return false;
    return now - ms > 2 * hours * HOUR_MS;
}

/**
 * "Swept 6 Oct 13:04 · next ~19:04": the day is left off the next sweep when
 * it falls on the same day as the last one. Null when nothing has swept.
 */
export function sweepText(t: Translate, cfg: ConnectorConfig | null | undefined, locale = 'en', now: number = Date.now()): string | null {
    const ms = sweptMs(cfg);
    if (ms === null) return null;
    const last = formatDayTime(new Date(ms).toISOString(), locale, now);
    const nextMs = ms + SWEEP_INTERVAL_HOURS * HOUR_MS;
    const nextAt = new Date(nextMs);
    const next = new Date(ms).toDateString() === nextAt.toDateString()
        ? `${pad(nextAt.getHours())}:${pad(nextAt.getMinutes())}`
        : formatDayTime(nextAt.toISOString(), locale, now);
    return t('compliance.conn_sweep_cell', 'Swept {last} · next ~{next}', { last, next });
}
