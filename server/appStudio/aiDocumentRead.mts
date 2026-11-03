/**
 * One attachment that cannot be read must not take an AI step down with it.
 *
 * The helpers here let ai_generate / ai_extract read a batch of attachments
 * with per-file isolation: a file that cannot be redeemed, loaded or extracted
 * is SKIPPED with a note ("skipped: <name> (<type>): <reason>") that travels in
 * the step result, and the step only fails when nothing at all could be read
 * and the step needed something to read (assertSomethingRead).
 *
 * Only refusals written for the viewer are skippable (4xx and `expose`
 * errors); an internal fault, a lost database or a quota is not about this
 * file and still stops the step.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { HttpError } = nodeRequire('../shared/httpErrors') as {
    HttpError: new (status: number, code: string, message: string) => Error & { status: number };
};

export type DocReport = { read: number; notes: string[]; total: number; strict: boolean };

type Described = { name?: unknown; mime?: unknown; type?: unknown } | null | undefined;
type Failure = Error & { status?: number; code?: string; expose?: boolean };

/** `strict`: refusals are rethrown instead of noted (callers that need every file). */
export function newReport(strict = false): DocReport {
    return { read: 0, notes: [], total: 0, strict };
}

/** Whether a failure is about THIS file (skip it) rather than the step. */
export function isSkippable(e: unknown): boolean {
    const err = e as Failure | null;
    if (!err || typeof err !== 'object') return false;
    if (err.code === 'quota_exceeded' || err.code === 'vision_required') return false;
    const status = typeof err.status === 'number' ? err.status : 0;
    return (status >= 400 && status < 500) || err.expose === true;
}

function cleanReason(reason: unknown): string {
    return String(reason || 'could not be read').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/** Record a skipped file and return its note. */
export function noteSkipped(report: DocReport, d: Described, reason: unknown): string {
    const name = String(d?.name || 'attachment').replace(/\s+/g, ' ').slice(0, 120);
    const type = String(d?.mime || d?.type || 'unknown type').slice(0, 80);
    const note = `skipped: ${name} (${type}): ${cleanReason(reason)}`;
    report.notes.push(note);
    return note;
}

/**
 * Run `fn` for one descriptor; a skippable failure becomes a note and `null`.
 */
export async function skipOnRefusal<T>(report: DocReport, d: Described, fn: () => Promise<T>): Promise<T | null> {
    try {
        return await fn();
    } catch (e) {
        if (report.strict || !isSkippable(e)) throw e;
        noteSkipped(report, d, (e as Error).message);
        return null;
    }
}

/**
 * Redeem every pending descriptor on its own; the ones that cannot be redeemed
 * are noted and left out.
 */
export async function redeemEach(
    descriptors: Array<Record<string, unknown> & Described>,
    redeemOne: (d: Record<string, unknown>) => Promise<Record<string, unknown>>,
    report: DocReport,
): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    report.total += descriptors.length;
    for (const d of descriptors) {
        const redeemed = await skipOnRefusal(report, d, () => redeemOne(d));
        if (redeemed) out.push(redeemed);
    }
    return out;
}

type Att = { name: string; type: string; content?: string };
type Extracted = { kind: string; reason?: string; text?: string; images?: Array<{ mimeType: string; base64: string }>; meta?: Record<string, unknown> };

/**
 * Read one descriptor into `{ att, result }`, or `null` when it is skipped
 * (the note is in the report). A transient `inline_text` descriptor (an xml
 * file, a forwarded mail) is already text and needs no load/extract. A result
 * of kind `failed` is returned as is (the caller still tells the model) but
 * does not count as read.
 */
export async function readDocument(
    descriptor: Record<string, unknown> & Described,
    { load, extract, report }: {
        load: () => Promise<Att>;
        extract: (att: Att) => Promise<Extracted>;
        report: DocReport;
    },
): Promise<{ att: Att; result: Extracted } | null> {
    const out = await skipOnRefusal<{ att: Att; result: Extracted }>(report, descriptor, async () => {
        if (descriptor.kind === 'inline_text') {
            const text = String(descriptor.text ?? '');
            return {
                att: { name: String(descriptor.name), type: String(descriptor.mime) },
                result: { kind: 'text', text, source: 'utf8', meta: { extractedChars: text.length } },
            };
        }
        const att = await load();
        return { att, result: await extract(att) };
    });
    if (!out) return null;
    if (out.result.kind === 'failed') {
        noteSkipped(report, { name: out.att.name, type: out.att.type }, out.result.reason);
    } else {
        report.read += 1;
    }
    return out;
}

/**
 * Fail with the real reason when nothing could be read. `needed` is false when
 * the step has other material to work from (context, knowledge bases).
 */
export function assertSomethingRead(report: DocReport, { needed = true }: { needed?: boolean } = {}): void {
    if (report.total === 0 || report.read > 0 || !needed) return;
    const detail = report.notes
        .map((n) => n.replace(/^skipped: /, ''))
        .join('; ')
        .slice(0, 800);
    const n = report.total;
    throw new HttpError(422, 'attachments_unreadable',
        `None of the ${n} attachment${n === 1 ? '' : 's'} could be read${detail ? `: ${detail}` : ''}`);
}
