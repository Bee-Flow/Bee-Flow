/**
 * File sizes, in the app's one voice.
 *
 * Also written three times before this file existed — in `features/library/
 * upload.ts`, `features/recording/outbox.ts` and `features/chat/attachments.ts`
 * — and all three disagreed. The chat composer said "512 kB" where the upload
 * queue said "512 KB"; the recording outbox stopped at MB, so a 1.2 GB meeting
 * recording read as "1229 MB"; and 1000 bytes was "1000 B" in the composer but
 * "1 KB" in the queue. Three spellings of one fact, on three screens a person
 * moves between in a single task.
 *
 * The generalisation kept here is the upload queue's, because it was the only
 * one that carried on past MB and the only one that varied its precision — one
 * decimal while the number is small enough for a decimal to mean something,
 * none once it is not. "2.4 MB", then "240 MB".
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * "2.4 MB". Absent, zero and negative all return an empty string.
 *
 * Empty rather than "0 B" or a dash: this goes in meta slots next to other
 * facts, and a caller that wants a placeholder can say `formatBytes(n) || '—'`
 * — which reads as the deliberate choice it is. Baking the dash in here would
 * put it on the four call sites that already guard on size and do not want it.
 */
export function formatBytes(bytes?: number | null): string {
    if (!bytes || bytes <= 0 || !Number.isFinite(bytes)) return '';

    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }

    // A decimal on raw bytes is noise ("973.0 B"), so it is spent only once
    // there is a unit to spend it on and the value is small enough to need it.
    const shown = value < 10 && unit > 0 ? value.toFixed(1) : String(Math.round(value));
    return `${shown} ${UNITS[unit] ?? 'B'}`;
}
