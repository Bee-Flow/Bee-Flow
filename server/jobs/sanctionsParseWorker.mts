/**
 * The worker thread that parses one downloaded sanctions list (jobs/sanctionsListRefresh.mts
 * parseInWorker). It gets the list id and the raw files (transferred, not copied), decodes and
 * parses them with the list's own parser (core/sanctions/sources.mts) and posts the entities
 * back. The parse of a 25 MB XML file needs a few hundred MB for a moment: in a worker that
 * memory is bounded by resourceLimits (SANCTIONS_PARSE_MEMORY_MB) and gone when it ends, and an
 * oversized file ends the worker instead of the server.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { decodeFiles, sourceById } from '../core/sanctions/sources.mts';

interface Job { listId: string; files: Record<string, Uint8Array> }

async function main(): Promise<void> {
    const { listId, files } = workerData as Job;
    const source = sourceById(listId);
    if (!source) throw new Error(`unknown list ${listId}`);
    const entities = await source.parse(decodeFiles(source, files));
    parentPort?.postMessage({ ok: true, entities });
}

main().catch((err: unknown) => {
    parentPort?.postMessage({ ok: false, error: (err as Error)?.message || String(err) });
});
