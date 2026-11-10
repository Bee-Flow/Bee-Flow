/**
 * Which settled steps of a dry run only PRETENDED to send or write.
 *
 * The server records a simulated step as `success`: the only signal is a
 * marker in its recorded output (server/core/automationRunner):
 *
 *   notification                      `_dryRun: true` (execNotification.js)
 *   generate_document, fill_document  `_dryRun: true` (execDocument.js, execFillDocument.js)
 *   http_request, write or signed     `_dryRun: true` from httpDryRun.js, with
 *                                     `_dryRunFallback` null or 'guardrail_block'
 *   integration_action, a write tool  `_dryRunSynthesised: true`, `_dryRunFallback: null`
 *   knowledge_write                   `_dryRunSynthesised: true`, `_dryRunFallback: null`
 *   datatable write                   `_dryRunSynthesised: true` beside the write
 *                                     shape (`created` | `updated` | `deleted`)
 *
 * The same markers sit on steps that sent nothing because they had nothing
 * real to work with: a read tool that answered sample data carries
 * `_dryRunSynthesised` WITH a `_dryRunFallback` reason, and a read of a table
 * that is only proposed carries it with the empty read shape. Those are not
 * "would have been sent", so they do not count here.
 */

/** What the step would have done in a live run. */
export type SimulatedKind = 'send' | 'write' | 'act';

export interface SimulatedStepInput {
    stepType?: string | null;
    status?: string | null;
    output?: unknown;
}

type Translate = (key: string, fallback: string) => string;

const SENDS = new Set(['notification', 'http_request']);
const WRITES = new Set(['datatable', 'knowledge_write', 'generate_document', 'fill_document']);
const DATATABLE_WRITE_KEYS = ['created', 'updated', 'deleted'];

function markedOutput(step: SimulatedStepInput | null | undefined): Record<string, unknown> | null {
    if (!step || step.status !== 'success') return null;
    const out = step.output;
    if (!out || typeof out !== 'object' || Array.isArray(out)) return null;
    return out as Record<string, unknown>;
}

/** A simulated answer with no fallback reason: the step itself was held back, not its input. */
function heldBack(out: Record<string, unknown>): boolean {
    return out._dryRunSynthesised === true && out._dryRunFallback == null;
}

/** 'send' | 'write' | 'act' for a step a dry run simulated instead of carrying out; null for every other row. */
export function simulatedWriteKind(step: SimulatedStepInput | null | undefined): SimulatedKind | null {
    const out = markedOutput(step);
    if (!out) return null;
    const type = String(step?.stepType ?? '');
    if (SENDS.has(type)) return out._dryRun === true ? 'send' : null;
    if (type === 'integration_action') return heldBack(out) ? 'act' : null;
    if (!WRITES.has(type)) return null;
    if (out._dryRun === true) return 'write';
    if (!heldBack(out)) return null;
    return type !== 'datatable' || DATATABLE_WRITE_KEYS.some((k) => k in out) ? 'write' : null;
}

export function isSimulatedWrite(step: SimulatedStepInput | null | undefined): boolean {
    return simulatedWriteKind(step) !== null;
}

/** The card's result line for a simulated step, in place of "done". */
export function simulatedResultText(kind: SimulatedKind, t: Translate): string {
    if (kind === 'send') return t('automations.canvas.result.not_sent', 'not sent');
    if (kind === 'write') return t('automations.canvas.result.not_written', 'not written');
    return t('automations.canvas.result.not_carried_out', 'not carried out');
}
