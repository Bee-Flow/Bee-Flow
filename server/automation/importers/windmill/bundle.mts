/**
 * Reads a Windmill export into a `WmBundle` (PLAN B2 bundle.mts).
 *
 * Accepted input:
 *   { kind: 'zip', data }      a zip of a `wmill sync pull` folder (the primary form), or of a few flow files
 *   { kind: 'files', files }   the same tree as a { path: text } map (a folder the caller already read)
 *   { kind: 'text', text }     one flow (or a list of flows) as JSON or YAML
 *   { kind: 'object', value }  one flow (or a list) already parsed: OpenFlow, the REST `Flow` object,
 *                              or the Hub's `{ flow: … }` wrapper
 *
 * Both sync-pull layouts are recognised (`<name>__flow/flow.yaml` and the
 * older `<name>.flow/flow.yaml`), `content: '!inline <file>'` is resolved
 * against the flow's folder, and a workspace script's code is found next to
 * its `.script.yaml`.
 *
 * Safety: the zip is opened through core/documents/zipGuard.js (entry count
 * and inflated size checked on the declarations BEFORE anything is
 * inflated, then counted per chunk). Names with `..`, absolute paths or NUL
 * bytes are refused (paths.mts). Nothing is written to disk. Of a
 * `*.resource.yaml` only the path and `resource_type` are kept; its `value`,
 * where tokens live, is dropped the moment the file is parsed, and a
 * `*.variable.yaml` keeps its path and secret flag only.
 */

import { createRequire } from 'node:module';
import type { RefUse, SourceKind, WmBundle, WmFlow, WmScript } from './ir.mts';
import { parseFlow, unwrapFlow } from './parseFlow.mts';
import { readForeignTrigger, readNativeTrigger, readSchedule } from './parseTriggers.mts';
import { collectFlowRefs, refsInSource } from './refs.mts';
import { commonRoot, dirname, normalisePath, resolveRelative } from './paths.mts';
import { parseYaml } from './yaml.mts';
import { asObject, isObject, str } from './util.mts';

const nodeRequire = createRequire(import.meta.url);
const zipGuard = nodeRequire('../../../core/documents/zipGuard') as {
    openZipGuarded: (buf: Buffer, limits: { maxEntries: number; maxTotalBytes: number }) => Promise<{ entries: Array<{ name: string; unsafeOriginalName?: string }> }>;
    readEntryCapped: (entry: unknown, opts: { maxBytes: number; budget: unknown }) => Promise<Buffer>;
    createByteBudget: (max: number) => unknown;
};

export interface BundleLimits {
    /** Files in one export (0 = unlimited). */
    maxEntries: number;
    /** Bytes of all files together, unpacked (0 = unlimited). */
    maxTotalBytes: number;
    /** Bytes of one file, unpacked (0 = unlimited). */
    maxFileBytes: number;
}

export const DEFAULT_LIMITS: BundleLimits = Object.freeze({
    maxEntries: 5000,
    maxTotalBytes: 64 * 1024 * 1024,
    maxFileBytes: 8 * 1024 * 1024,
});

export type WindmillInput =
    | { kind: 'zip'; data: Uint8Array }
    | { kind: 'files'; files: Record<string, string> }
    | { kind: 'text'; text: string; name?: string }
    | { kind: 'object'; value: unknown; name?: string };

export class BundleError extends Error {
    code: string;
    constructor(message: string, code: string) {
        super(message);
        this.name = 'BundleError';
        this.code = code;
    }
}

/** Read any accepted input into the intermediate bundle. */
export async function toIntermediate(input: WindmillInput, limits: Partial<BundleLimits> = {}): Promise<WmBundle> {
    const caps: BundleLimits = { ...DEFAULT_LIMITS, ...limits };
    switch (input.kind) {
        case 'zip': return bundleFromFiles(await readZip(input.data, caps), 'zip');
        case 'files': return bundleFromFiles(checkFileMap(input.files, caps), 'files');
        case 'text': return bundleFromText(input.text, input.name, caps);
        case 'object': return bundleFromValue(input.value, input.name ?? 'f/imported/flow', 'object');
        default: throw new BundleError('Unknown input kind.', 'input_kind');
    }
}

async function readZip(data: Uint8Array, caps: BundleLimits): Promise<Map<string, string>> {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    let opened;
    try {
        opened = await zipGuard.openZipGuarded(buf, { maxEntries: caps.maxEntries, maxTotalBytes: caps.maxTotalBytes });
    } catch (e) {
        throw new BundleError(e instanceof Error ? e.message : 'The zip could not be read.', 'zip_rejected');
    }
    const budget = zipGuard.createByteBudget(caps.maxTotalBytes);
    const files = new Map<string, string>();
    for (const entry of opened.entries) {
        // JSZip resolves `..` in a name on load and keeps what the archive said in
        // unsafeOriginalName: the archive's own name is the one judged.
        const name = normalisePath(entry.unsafeOriginalName ?? entry.name);
        if (!wanted(name)) continue;
        let bytes: Buffer;
        try {
            bytes = await zipGuard.readEntryCapped(entry, { maxBytes: caps.maxFileBytes, budget });
        } catch (e) {
            throw new BundleError(e instanceof Error ? e.message : 'A file in the zip could not be read.', 'zip_rejected');
        }
        files.set(name, bytes.toString('utf8'));
    }
    return stripRoot(files);
}

/** Lock files and binary assets are never read. */
function wanted(name: string): boolean {
    return !(name.endsWith('.lock') || name.endsWith('.png') || name.endsWith('.jpg') || name.includes('/node_modules/'));
}

function checkFileMap(files: Record<string, string>, caps: BundleLimits): Map<string, string> {
    const names = Object.keys(files);
    if (caps.maxEntries > 0 && names.length > caps.maxEntries) {
        throw new BundleError(`The export holds more than ${caps.maxEntries} files.`, 'too_many_entries');
    }
    const out = new Map<string, string>();
    let total = 0;
    for (const raw of names) {
        const text = files[raw];
        if (typeof text !== 'string') continue;
        const bytes = Buffer.byteLength(text, 'utf8');
        total += bytes;
        if (caps.maxFileBytes > 0 && bytes > caps.maxFileBytes) throw new BundleError(`${raw} is larger than a file of an export may be.`, 'part_too_large');
        if (caps.maxTotalBytes > 0 && total > caps.maxTotalBytes) throw new BundleError('The export is larger than allowed.', 'total_too_large');
        const name = normalisePath(raw);
        if (wanted(name)) out.set(name, text);
    }
    return stripRoot(out);
}

function stripRoot(files: Map<string, string>): Map<string, string> {
    const root = commonRoot([...files.keys()]);
    if (!root) return files;
    const out = new Map<string, string>();
    for (const [k, v] of files) out.set(k.slice(root.length + 1), v);
    return out;
}

function bundleFromText(text: string, name: string | undefined, caps: BundleLimits): WmBundle {
    if (caps.maxFileBytes > 0 && Buffer.byteLength(text, 'utf8') > caps.maxFileBytes) {
        throw new BundleError('The file is larger than allowed.', 'part_too_large');
    }
    const trimmed = text.trimStart();
    const isJson = trimmed.startsWith('{') || trimmed.startsWith('[');
    let value: unknown;
    try {
        value = isJson ? JSON.parse(text) : parseYaml(text);
    } catch (e) {
        throw new BundleError(`The file is not valid ${isJson ? 'JSON' : 'YAML'}: ${e instanceof Error ? e.message : String(e)}`, 'parse');
    }
    return bundleFromValue(value, flowPathFromName(name), isJson ? 'json' : 'yaml');
}

function flowPathFromName(name: string | undefined): string {
    if (!name) return 'f/imported/flow';
    let base = name.split('\\').join('/').split('/').pop() || 'flow';
    for (const ext of ['.json', '.yaml', '.yml']) if (base.endsWith(ext)) base = base.slice(0, -ext.length);
    if (base.endsWith('.flow')) base = base.slice(0, -'.flow'.length);
    return `f/imported/${base || 'flow'}`;
}

function bundleFromValue(value: unknown, path: string, source: SourceKind): WmBundle {
    const bundle = emptyBundle(source);
    const list = Array.isArray(value) ? value : [value];
    list.forEach((raw, i) => {
        const flowObj = unwrapFlow(raw);
        if (!isObject(flowObj.value)) {
            bundle.readWarnings.push(`Item ${i + 1} is not a Windmill flow (it has no "value").`);
            return;
        }
        const own = str(flowObj.path) ?? (list.length > 1 ? `${path}_${i + 1}` : path);
        bundle.flows.push(parseFlow(raw, own, { readWarnings: bundle.readWarnings }));
    });
    finishRefs(bundle);
    return bundle;
}

function emptyBundle(source: SourceKind): WmBundle {
    return {
        flows: [], scripts: new Map(), schedules: [], nativeTriggers: [], otherTriggers: [],
        refs: { resources: [], variables: [] }, resources: [], apps: [], source, readWarnings: [],
    };
}

const FLOW_FILES = ['__flow/flow.yaml', '__flow/flow.yml', '__flow/flow.json', '.flow/flow.yaml', '.flow/flow.yml', '.flow/flow.json'];
const FLOW_SUFFIXES = ['.flow.json', '.flow.yaml', '.flow.yml'];

/** The Windmill path of a flow file, or null when the file is not a flow. */
function flowPathOf(name: string): string | null {
    for (const f of FLOW_FILES) if (name.endsWith(f)) return name.slice(0, -f.length);
    for (const f of FLOW_SUFFIXES) if (name.endsWith(f) && !name.includes('__flow/')) return name.slice(0, -f.length);
    return null;
}

function parseData(name: string, text: string, warnings: string[]): unknown {
    try {
        return name.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
    } catch (e) {
        warnings.push(`${name} could not be read: ${e instanceof Error ? e.message : String(e)}`);
        return undefined;
    }
}

export function bundleFromFiles(files: Map<string, string>, source: SourceKind): WmBundle {
    const bundle = emptyBundle(source);
    for (const [name, text] of files) readOneFile(bundle, files, name, text);
    readScripts(bundle, files);
    for (const flow of bundle.flows) {
        if (bundle.nativeTriggers.some((t) => t.scriptPath === flow.path) && flow.dialect === 'none') flow.dialect = 'native';
    }
    finishRefs(bundle);
    return bundle;
}

function readOneFile(bundle: WmBundle, files: Map<string, string>, name: string, text: string): void {
    const flowPath = flowPathOf(name);
    if (flowPath !== null) { readFlowFile(bundle, files, name, flowPath, text); return; }
    if (name.endsWith('__app/app.yaml') || name.endsWith('__raw_app/raw_app.yaml') || name.endsWith('.app/app.yaml')) {
        bundle.apps.push(dirname(name));
        return;
    }
    if (isKnownDataFile(name)) readDataFile(bundle, name, text);
}

function isKnownDataFile(name: string): boolean {
    return name.endsWith('.yaml') || name.endsWith('.yml') || name.endsWith('.json');
}

function readFlowFile(bundle: WmBundle, files: Map<string, string>, name: string, flowPath: string, text: string): void {
    const raw = parseData(name, text, bundle.readWarnings);
    if (raw === undefined) return;
    const dir = dirname(name);
    const resolveInline = (ref: string): string | null => {
        try { return files.get(resolveRelative(dir, ref)) ?? null; } catch { return null; }
    };
    bundle.flows.push(parseFlow(raw, flowPath, { resolveInline, readWarnings: bundle.readWarnings }));
}

function readDataFile(bundle: WmBundle, name: string, text: string): void {
    if (!isTriggerOrRefFile(name)) return;
    const content = parseData(name, text, bundle.readWarnings);
    if (content === undefined) return;
    const schedule = readSchedule(name, content);
    if (schedule) { bundle.schedules.push(schedule); return; }
    const native = readNativeTrigger(name, content);
    if (native) { bundle.nativeTriggers.push(native); return; }
    const other = readForeignTrigger(name, content);
    if (other) { bundle.otherTriggers.push(other); return; }
    readRefFile(bundle, name, content);
}

function isTriggerOrRefFile(name: string): boolean {
    return name.includes('.schedule.') || name.includes('_trigger.') || name.includes('.resource.') || name.includes('.variable.');
}

function readRefFile(bundle: WmBundle, name: string, content: unknown): void {
    const c = asObject(content);
    for (const suffix of ['.resource.yaml', '.resource.yml', '.resource.json']) {
        if (name.endsWith(suffix)) {
            // Only the path and the type survive; `value` (the credentials) is never kept.
            bundle.resources.push({ path: name.slice(0, -suffix.length), ...(str(c.resource_type) ? { resourceType: str(c.resource_type) } : {}) });
            return;
        }
    }
}

const SCRIPT_META = ['.script.yaml', '.script.yml', '.script.json'];

/** Code file extension (longest first) to Windmill language (research 01 §2.1). */
const LANGUAGE_BY_EXT: Array<[string, string]> = [
    ['.bun.ts', 'bun'], ['.deno.ts', 'deno'], ['.native.ts', 'nativets'], ['.pg.sql', 'postgresql'],
    ['.my.sql', 'mysql'], ['.bq.sql', 'bigquery'], ['.sf.sql', 'snowflake'], ['.ms.sql', 'mssql'],
    ['.odb.sql', 'oracledb'], ['.duckdb.sql', 'duckdb'], ['.playbook.yml', 'ansible'], ['.ts', 'bun'],
    ['.py', 'python3'], ['.go', 'go'], ['.sh', 'bash'], ['.ps1', 'powershell'], ['.gql', 'graphql'],
    ['.php', 'php'], ['.rs', 'rust'], ['.cs', 'csharp'], ['.nu', 'nu'], ['.java', 'java'], ['.rb', 'ruby'], ['.r', 'rlang'],
];

function readScripts(bundle: WmBundle, files: Map<string, string>): void {
    for (const [name, text] of files) {
        const suffix = SCRIPT_META.find((s) => name.endsWith(s));
        if (!suffix) continue;
        const base = name.slice(0, -suffix.length);
        const meta = asObject(parseData(name, text, bundle.readWarnings));
        const script: WmScript = { path: base };
        if (str(meta.summary)) script.summary = str(meta.summary);
        if (str(meta.kind)) script.kind = str(meta.kind);
        for (const [ext, language] of LANGUAGE_BY_EXT) {
            const code = files.get(`${base}${ext}`);
            if (code !== undefined) { script.source = code; script.language = str(meta.language) ?? language; break; }
        }
        bundle.scripts.set(base, script);
    }
}

function finishRefs(bundle: WmBundle): void {
    const typeOf = new Map(bundle.resources.map((r) => [r.path, r.resourceType]));
    const all: RefUse[] = bundle.flows.flatMap((f: WmFlow) => collectFlowRefs(f));
    for (const s of bundle.scripts.values()) {
        if (s.source) for (const r of refsInSource(s.source)) all.push({ ...r, where: `script:${s.path}` });
    }
    for (const r of all) {
        const t = r.kind === 'resource' ? typeOf.get(r.path) : undefined;
        const use = t ? { ...r, resourceType: t } : r;
        (r.kind === 'resource' ? bundle.refs.resources : bundle.refs.variables).push(use);
    }
}
