import type { SchemaProp } from './toolInput/toolInputHelpers';
import type { OnFocusField } from './focusField.types';
import type { ForEachConfig } from './itemRefs';
import type { ParamSuggestion } from './toolInput/ParamExtras';
import type { DeepenHandle } from './deepPick';

/**
 * Schema-driven inputs editor for a step's `inputs` map.
 *
 * Two modes:
 *   1. Schema-driven — when `inputSchema?.properties` is provided
 *      (sourced from the catalog's per-tool function definition).
 *      Essential fields (required / populated / common) show by default;
 *      the rest collapse behind a "Show N more options" disclosure.
 *   2. Generic key/value rows — when no schema is available (custom
 *      tools, AI step user-defined inputs). User adds rows manually.
 *
 * Both modes emit the same `inputs` object the runtime resolver
 * expects: `{ [key]: bindingObject }`.
 *
 * Auto-mapping: `autoMappedKeys` marks fields filled by the connect-time
 * auto-mapper so a small "auto" pill is shown; `onAutoMap` (when given)
 * renders a one-click wand button to (re)run mapping over empty fields.
 */
export interface PendingRow { id: number; key: string; binding: unknown }

export interface ToolInputFormProps {
    inputs?: Record<string, unknown>;
    onChange?: (next: Record<string, unknown>) => void;
    inputSchema?: { properties?: Record<string, SchemaProp>; required?: string[] } | null;
    onFocusField?: OnFocusField | null;
    previewSample?: unknown;
    onAutoMap?: (() => void) | null;
    onRequestForEach?: ((forEach: ForEachConfig | null | undefined) => void) | null;
    suggestions?: Record<string, ParamSuggestion> | null;
    problemKey?: string | null;
    allowExtraFields?: boolean;
    autoMappedKeys?: string[];
    keepEmptyFields?: boolean;
    visualValues?: boolean;
    nameLabel?: string | null;
    valueLabel?: string | null;
    namePlaceholder?: string;
    valuePlaceholder?: string;
    allowRawValues?: boolean;
    deepenForEach?: DeepenHandle | null;
    tool?: string | null;
    problemText?: string | null;
    aiMappedKeys?: string[];
}
