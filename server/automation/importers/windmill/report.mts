/**
 * The conversion report of one flow: per Windmill module what became of it,
 * the AI checklist the builder gets, and the warnings a person reads before
 * activating (secrets left out, outbound hosts, identity change, …).
 *
 * Plain data, so it serialises straight into a golden file and a route answer.
 */

export type ModuleStatus = 'mapped' | 'pattern' | 'shim' | 'ai' | 'unsupported' | 'dropped';
export type Confidence = 'high' | 'medium' | 'low';

export interface ModuleEntry {
    wmId: string;
    summary?: string;
    /** What the module was in Windmill: `rawscript:bun`, `script:hub/…`, `branchone`, … */
    source: string;
    status: ModuleStatus;
    confidence: Confidence;
    reason: string;
    /** Bee Flow step ids that hold this module (none when it was dropped). */
    stepIds: string[];
}

export interface AiChecklistItem {
    wmId: string;
    /** The placeholder step that stands where the module was. */
    stepId: string | null;
    title: string;
    why: string;
    language?: string;
    /** The original code or expression, secrets removed. Read-only for the builder. */
    source?: string;
    /** The module's inputs as the converter understood them (bindings or the untranslated expression). */
    inputs?: Record<string, unknown>;
}

export type WarningCode =
    | 'secret_removed' | 'connection_needed' | 'outbound_host' | 'identity_change' | 'ai_destination'
    | 'repick_id' | 'trigger_switch_off' | 'trigger_unsupported' | 'trigger_approximated' | 'option_dropped'
    | 'option_approximated' | 'privacy_retention' | 'new_webhook_url' | 'approval_expiry' | 'approval_people'
    | 'schedule_seconds' | 'mock_pinned' | 'expression_unsupported' | 'parallel_serial' | 'read_problem'
    | 'not_migrated';

export interface Warning {
    code: WarningCode;
    message: string;
    wmId?: string;
}

export interface ConnectionHint {
    kind: 'resource' | 'variable';
    path: string;
    resourceType?: string;
    where: string[];
}

export interface FlowReport {
    flowPath: string;
    modules: ModuleEntry[];
    aiChecklist: AiChecklistItem[];
    warnings: Warning[];
    connections: ConnectionHint[];
    outboundHosts: string[];
    counts: Record<ModuleStatus, number>;
}

/** Collects report entries while one flow converts. */
export class ReportBuilder {
    flowPath: string;
    modules: ModuleEntry[] = [];
    aiChecklist: AiChecklistItem[] = [];
    warnings: Warning[] = [];
    connections = new Map<string, ConnectionHint>();
    hosts = new Set<string>();

    constructor(flowPath: string) {
        this.flowPath = flowPath;
    }

    module(entry: ModuleEntry): void {
        this.modules.push(entry);
    }

    ai(item: AiChecklistItem): void {
        this.aiChecklist.push(item);
    }

    warn(code: WarningCode, message: string, wmId?: string): void {
        const dup = this.warnings.some((w) => w.code === code && w.message === message && w.wmId === wmId);
        if (!dup) this.warnings.push(wmId ? { code, message, wmId } : { code, message });
    }

    connection(kind: 'resource' | 'variable', path: string, where: string, resourceType?: string): void {
        const key = `${kind}:${path}`;
        const hit = this.connections.get(key);
        if (hit) {
            if (!hit.where.includes(where)) hit.where.push(where);
            return;
        }
        this.connections.set(key, { kind, path, where: [where], ...(resourceType ? { resourceType } : {}) });
    }

    host(host: string): void {
        this.hosts.add(host);
    }

    finish(): FlowReport {
        const counts: Record<ModuleStatus, number> = { mapped: 0, pattern: 0, shim: 0, ai: 0, unsupported: 0, dropped: 0 };
        for (const m of this.modules) counts[m.status] += 1;
        return {
            flowPath: this.flowPath,
            modules: this.modules,
            aiChecklist: this.aiChecklist,
            warnings: this.warnings,
            connections: [...this.connections.values()],
            outboundHosts: [...this.hosts].sort(),
            counts,
        };
    }
}
