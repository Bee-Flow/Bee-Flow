/**
 * The intermediate model of a Windmill export (PLAN B2): what `toIntermediate`
 * reads a JSON / YAML file, a `wmill sync pull` zip or a file map into, and
 * what `toBeeFlow` converts. Types only.
 *
 * Nothing here holds a secret VALUE: a resource or variable is its path and
 * type, never its `value` (bundle.mts drops that on read).
 */

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };
export type JsonObject = { [k: string]: JsonValue };

/** One Windmill input transform. */
export type WmInput =
    | { type: 'static'; value: unknown }
    | { type: 'javascript'; expr: string }
    | { type: 'ai' };

export type ModuleKind =
    | 'script' | 'rawscript' | 'flow' | 'forloopflow' | 'whileloopflow'
    | 'branchone' | 'branchall' | 'identity' | 'aiagent' | 'aidecision' | 'unknown';

export interface WmBranch {
    summary?: string;
    expr?: string;
    skipFailure?: boolean;
    nodes: WmNode[];
}

export interface WmSuspend {
    requiredEvents?: number;
    timeoutS?: number;
    continueOnDisapproveTimeout?: boolean;
    resumeSchema?: JsonObject;
    userGroupsRequired?: WmInput;
    selfApprovalDisabled?: boolean;
}

/** Per-module options (OpenFlow FlowModule fields other than id/summary/value). */
export interface ModuleOptions {
    skipIf?: string;
    stopAfterIf?: { expr: string; errorMessage?: string; skipIfStopped?: boolean };
    stopAfterAllItersIf?: { expr: string; errorMessage?: string };
    sleep?: WmInput;
    timeout?: WmInput;
    retry?: { constant?: { attempts?: number; seconds?: number }; exponential?: { attempts?: number; seconds?: number; multiplier?: number }; retryIf?: string };
    continueOnError?: boolean;
    mock?: { enabled?: boolean; returnValue?: unknown };
    suspend?: WmSuspend;
    cacheTtl?: number;
    deleteAfterSecs?: number;
    /** Option names present on the module that the converter only reports (priority, debouncing, …). */
    reportOnly: string[];
}

export interface WmNode {
    wmId: string;
    summary?: string;
    kind: ModuleKind;
    /** The raw `value.type` when it is not a known kind. */
    rawType?: string;
    language?: string;
    /** Inline code (rawscript), or the code of a workspace script found in the bundle. */
    source?: string;
    /** `script` / `flow` path (hub/…, f/…, u/…). */
    scriptPath?: string;
    inputs: Record<string, WmInput>;
    children?: WmNode[];
    branches?: WmBranch[];
    defaultBranch?: WmNode[];
    iterator?: WmInput;
    loop?: { parallel?: boolean; parallelism?: number; skipFailures?: boolean; maxIterations?: number };
    /** aiagent tools, by tool_type. */
    agentTools?: Array<{ type: string; name?: string }>;
    options: ModuleOptions;
}

export interface FlowOptions {
    skipExpr?: string;
    concurrentLimit?: number;
    timeoutS?: number;
    deleteAfterSecs?: number;
    flowEnv?: Record<string, string>;
    earlyReturn?: string;
    /** Flow-level option names that are only reported. */
    reportOnly: string[];
    onBehalfOf?: string;
}

export type Dialect = 'exapp' | 'native' | 'none';

export interface WmFlow {
    path: string;
    summary: string;
    description?: string;
    schema?: JsonObject;
    dialect: Dialect;
    /** Dialect A: the events and filters of the CORE:LISTEN_TO_EVENT module. */
    listenEvents?: { events: string[]; filters?: JsonObject };
    nodes: WmNode[];
    failure?: WmNode;
    preprocessor?: WmNode;
    options: FlowOptions;
    notes: string[];
}

export interface WmScript {
    path: string;
    language?: string;
    summary?: string;
    source?: string;
    kind?: string;
}

export interface WmSchedule {
    file: string;
    scriptPath: string;
    isFlow: boolean;
    cron: string;
    timezone?: string;
    enabled?: boolean;
    args?: JsonObject;
}

export interface WmNativeTrigger {
    file: string;
    scriptPath: string;
    service: string;
    event?: string;
    eventFilter?: JsonValue;
    userIdFilter?: string;
}

export interface WmForeignTrigger {
    file: string;
    /** http, email, kafka, … (the `<kind>_trigger.yaml` suffix). */
    kind: string;
    scriptPath: string;
    routePath?: string;
    httpMethod?: string;
    authenticationMethod?: string;
    requestType?: string;
}

export interface RefUse {
    /** `$res:` or `$var:` path, without the prefix. */
    path: string;
    kind: 'resource' | 'variable';
    /** Where it was used: `<flow path>#<module id>.<input>`, `flow_env.<name>`, `script:<path>`. */
    where: string;
    resourceType?: string;
}

export type SourceKind = 'json' | 'yaml' | 'zip' | 'files' | 'object';

export interface WmBundle {
    flows: WmFlow[];
    scripts: Map<string, WmScript>;
    schedules: WmSchedule[];
    nativeTriggers: WmNativeTrigger[];
    otherTriggers: WmForeignTrigger[];
    refs: { resources: RefUse[]; variables: RefUse[] };
    /** Paths of `*.resource.yaml` files with their type, never their value. */
    resources: Array<{ path: string; resourceType?: string }>;
    /** Windmill apps found in the export (never converted). */
    apps: string[];
    source: SourceKind;
    /** Problems reading the input (a file that did not parse, a path refused). */
    readWarnings: string[];
}
