/**
 * The evidence a log row holds, as label/value pairs for its open panel.
 *
 * These are the only per-row facts the two ledgers keep — neither stores what
 * was written or what was sent — so all of them are shown, never trimmed to
 * fit a layout: the model, file, conversation and automation run for a shield
 * event; operator, address, result, tool and place for a call.
 */

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { ENTRY_WORDS, wordFor } from '../activityLabels';
import { placeLabel } from '../egressMap/locationCopy';
import type { MapDestination } from '../egressMap/mapModel';
import { formatStamp } from '../shieldDates';
import type { StreamRow } from '../shieldStream';

export type DetailPair = [label: string, value: string];

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

function guardPairs(row: StreamRow, t: TranslateFn): DetailPair[] {
    const raw = row.raw;
    return [
        [t('admin.shield_activity_d_direction', 'Direction'), text(raw.direction)],
        [t('admin.shield_activity_d_model', 'AI model'), text(raw.model)],
        [t('admin.shield_activity_d_file', 'File'), text(raw.attachment_filename)],
        [t('admin.shield_activity_d_conversation', 'Conversation'), text(raw.conversation_id)],
        [t('admin.shield_activity_d_run', 'Automation run'), text(raw.run_id)],
    ];
}

function egressPairs(row: StreamRow, t: TranslateFn): DetailPair[] {
    const raw = row.raw;
    const duration = Number(raw.duration_ms);
    return [
        [t('admin.shield_activity_d_operator', 'Operated by'), text(row.operator)],
        [t('admin.shield_activity_d_address', 'Server address'), text(raw.peer_ip || raw.server_endpoint)],
        [t('admin.shield_activity_d_result', 'Result'), [text(raw.status), duration ? `${duration} ms` : ''].filter(Boolean).join(' · ')],
        [t('admin.shield_activity_d_tool', 'Tool'), text(raw.tool_name || raw.integration_type)],
        [t('admin.shield_activity_d_country', 'Country'), placeLabel(row as unknown as MapDestination, t) || text(row.country)],
    ];
}

export function detailPairs(row: StreamRow, t: TranslateFn, locale: string): DetailPair[] {
    return [
        [t('shield_activity.d_type', 'Type'), wordFor(ENTRY_WORDS, row.entry, t)],
        [t('admin.shield_activity_col_time', 'Time'), formatStamp(row.ts, locale)],
        ...(row.source === 'guard' ? guardPairs(row, t) : egressPairs(row, t)),
    ];
}
