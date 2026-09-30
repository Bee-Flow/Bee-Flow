/**
 * The App Studio definition, as the phone reads and edits it.
 *
 * The contract is server/appStudio/componentSpecs.js (schemaVersion 2). Every
 * shape here is deliberately open: props, style and the binding bodies are
 * records, because the catalog (GET /api/studio-apps/catalog) is what says
 * which keys a type takes, and the server validates on save. The editor ops
 * (core/ops) and the runtime read what they need and carry the rest through
 * untouched, so a field the phone does not know yet survives a round trip.
 */

export type NodeEvent =
    | 'onClick'
    | 'onSubmit'
    | 'onRowClick'
    | 'onRowSelect'
    | 'onCardMove'
    | 'onChange'
    | 'onDecided';

export interface ValidationRule {
    kind: string;
    value?: unknown;
    expr?: string;
    message?: string;
    [key: string]: unknown;
}

export interface AppNode {
    id: string;
    type: string;
    props?: Record<string, unknown>;
    style?: Record<string, unknown>;
    visible?: boolean;
    children?: AppNode[];
    onClick?: string | null;
    onSubmit?: string | null;
    onRowClick?: string | null;
    onRowSelect?: string | null;
    onCardMove?: string | null;
    onChange?: string | null;
    onDecided?: string | null;
    visibleWhen?: string | null;
    enabledWhen?: string | null;
    readOnly?: boolean | string | null;
    computed?: Record<string, string> | null;
    validations?: ValidationRule[] | null;
    /** Role keys allowed to see this node; absent or empty is everyone. */
    visibleToRoles?: string[] | null;
    [key: string]: unknown;
}

export interface AppSection {
    id: string;
    style?: Record<string, unknown>;
    children: AppNode[];
    [key: string]: unknown;
}

export interface AppScreen {
    id: string;
    name: string;
    icon?: string | null;
    showInNav?: boolean;
    maxWidth?: string | number | null;
    kind?: string | null;
    description?: string | null;
    refreshInterval?: number | null;
    visibleToRoles?: string[] | null;
    sections: AppSection[];
    [key: string]: unknown;
}

/** One step of a sequence action. Branch bodies nest (then/else, cases, body). */
export interface ActionStep {
    kind: string;
    [key: string]: unknown;
}

export interface AppAction {
    kind: string;
    name?: string;
    steps?: ActionStep[];
    automationId?: string | null;
    inputMapping?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface AppVariable {
    name: string;
    type: 'text' | 'number' | 'yesno' | 'date' | 'record' | 'list' | 'any';
    default?: unknown;
    description?: string;
    [key: string]: unknown;
}

export interface AppRole {
    id: string;
    name: string;
    [key: string]: unknown;
}

export interface AppDefinition {
    schemaVersion?: number;
    meta?: { name?: string; description?: string; icon?: string; [key: string]: unknown };
    theme?: Record<string, unknown>;
    design?: Record<string, unknown>;
    nav?: { style?: 'tabs' | 'sidebar' | 'mega' | 'rail' | string; groups?: unknown[]; [key: string]: unknown };
    homeScreenId?: string;
    roles?: AppRole[];
    variables?: AppVariable[];
    publicAccess?: Record<string, unknown> | null;
    screens: AppScreen[];
    actions: Record<string, AppAction>;
    [key: string]: unknown;
}

/** The binding kinds a prop of type `binding` may hold. */
export type Binding =
    | { kind: 'static'; value: unknown }
    | { kind: 'actionResult'; actionId: string; path?: string }
    | { kind: 'formula'; expr: string }
    | { kind: 'record'; tableId: string; recordId?: string; path?: string }
    | { kind: 'records'; tableId: string; filter?: unknown; sort?: unknown; limit?: number }
    | { kind: 'dataset'; datasetId: string; params?: Record<string, unknown> }
    | { kind: 'connector'; [key: string]: unknown }
    | { kind: 'aggregate'; [key: string]: unknown };
