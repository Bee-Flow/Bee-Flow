// The Component Studio builder's form model: the shapes the editor keeps,
// how a stored definition becomes editable rows, how the rows become the
// definition the server stores again, and the output schema derived from a
// test run. Pure functions, no React.

export interface ComponentFormData {
    id: string;
    name: string;
    description: string;
    category: string;
    inputs: Record<string, unknown>;
    outputs: Record<string, unknown>;
    dependencies: Record<string, unknown>;
    code: string;
    agentEnabled: boolean;
    directChatEnabled: boolean;
}

export interface InputRow {
    key: string;
    type: string;
    defaultValue: string;
    description: string;
    secure?: boolean;
    _hasStoredValue?: boolean;
}

export interface OutputRow {
    key: string;
    type: string;
}

export interface DependencyRow {
    name: string;
    version: string;
}

export interface ComponentSummary {
    id: string;
    definition: { name?: string; description?: string; category?: string };
}

export interface ComponentDefinition {
    name?: string;
    description?: string;
    category?: string;
    inputs?: Record<string, unknown>;
    outputs?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    code?: string;
    agentEnabled?: boolean;
    directChatEnabled?: boolean;
}

export type TestOutput = Record<string, unknown> & { error?: unknown };

export const INITIAL_FORM: ComponentFormData = {
    id: '',
    name: '',
    description: '',
    category: 'Custom',
    inputs: {},
    outputs: { result: 'any' },
    dependencies: {},
    code: '',
    agentEnabled: true,
    directChatEnabled: false
};

export const DEFAULT_COMPONENT_CODE = `// Read input from stdin
let inputData = '';
process.stdin.on('data', chunk => {
    inputData += chunk;
});

process.stdin.on('end', async () => {
    try {
        const inputs = JSON.parse(inputData);

        // Your component logic here
        const result = {
            output: inputs.input || 'Hello World'
        };

        // Output must be valid JSON
        console.log(JSON.stringify(result));
    } catch (e) {
        process.stderr.write(e.message);
        process.exit(1);
    }
});`;

/** The form of a loaded component, from its id and stored definition. */
export function formFromDefinition(id: string, data: ComponentDefinition): ComponentFormData {
    return {
        id,
        name: data.name || '',
        description: data.description || '',
        category: data.category || 'Custom',
        inputs: data.inputs || {},
        outputs: data.outputs || {},
        dependencies: data.dependencies || {},
        code: data.code || '',
        agentEnabled: data.agentEnabled !== false,
        directChatEnabled: data.directChatEnabled === true
    };
}

/** Stored inputs (a type string or a `{ type, default, ... }` object) as editable rows. */
export function parseInputs(inputs: Record<string, unknown> | undefined): InputRow[] {
    return Object.entries(inputs || {}).map(([key, value]) => {
        if (typeof value === 'object' && value !== null) {
            const v = value as { type?: string; default?: string; description?: string; secure?: boolean; _hasStoredValue?: boolean };
            return { key, type: v.type || 'string', defaultValue: v.default || '', description: v.description || '', secure: v.secure || false, _hasStoredValue: v._hasStoredValue || false };
        }
        return { key, type: (value as string) || 'string', defaultValue: '', description: '', secure: false, _hasStoredValue: false };
    });
}

export function parseOutputs(outputs: Record<string, unknown> | undefined): OutputRow[] {
    return Object.entries(outputs || {}).map(([key, type]) => ({ key, type: type as string }));
}

export function parseDependencies(dependencies: Record<string, unknown> | undefined): DependencyRow[] {
    return Object.entries(dependencies || {}).map(([name, version]) => ({ name, version: version as string }));
}

/** The test-tab input JSON: every input key with its default value (or ''). */
export function defaultTestInput(inputsList: InputRow[]): string {
    const defaultInput: Record<string, string> = {};
    inputsList.forEach(inp => {
        defaultInput[inp.key] = inp.defaultValue || '';
    });
    return JSON.stringify(defaultInput, null, 2);
}

/**
 * Input rows back to the stored shape: a bare type string, or an object when
 * the input has a default, description, secret flag or a stored secret.
 */
export function serializeInputs(inputsList: InputRow[]): Record<string, unknown> {
    const inputs: Record<string, unknown> = {};
    inputsList.forEach(i => {
        if (i.key) {
            const inputDef: { type: string; default?: string; description?: string; secure?: boolean; _hasStoredValue?: boolean } = { type: i.type || 'string' };
            if (i.defaultValue) inputDef.default = i.defaultValue;
            if (i.description) inputDef.description = i.description.slice(0, 150);
            if (i.secure) inputDef.secure = true;
            // If secure field has stored value and user didn't change it, preserve it
            if (i.secure && i._hasStoredValue && !i.defaultValue) {
                inputDef._hasStoredValue = true;
            }
            // Only use object format if there's extra properties
            if (inputDef.default || inputDef.description || inputDef.secure || inputDef._hasStoredValue) {
                inputs[i.key] = inputDef;
            } else {
                inputs[i.key] = i.type || 'string';
            }
        }
    });
    return inputs;
}

export function serializeOutputs(outputsList: OutputRow[]): Record<string, string> {
    const outputs: Record<string, string> = {};
    outputsList.forEach(o => { if (o.key) outputs[o.key] = o.type || 'any'; });
    return outputs;
}

export function serializeDependencies(dependenciesList: DependencyRow[]): Record<string, string> {
    const dependencies: Record<string, string> = {};
    dependenciesList.forEach(d => { if (d.name) dependencies[d.name] = d.version || 'latest'; });
    return dependencies;
}

export interface OutputSchema {
    type: string;
    items?: OutputSchema;
    properties?: Record<string, OutputSchema>;
}

/** Generate output schema from a value */
export function generateOutputSchema(value: unknown): OutputSchema {
    if (value === null) return { type: 'any' };
    if (Array.isArray(value)) {
        return { type: 'array', items: value.length > 0 ? generateOutputSchema(value[0]) : { type: 'any' } };
    }
    if (typeof value === 'object') {
        const properties: Record<string, OutputSchema> = {};
        for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
            properties[key] = generateOutputSchema(val);
        }
        return { type: 'object', properties };
    }
    return { type: typeof value };
}

/** Flatten schema to simple type strings for outputs */
export function flattenSchema(schema: OutputSchema, path = ''): Record<string, string> {
    if (schema.type === 'object' && schema.properties) {
        const result: Record<string, string> = {};
        for (const [key, val] of Object.entries(schema.properties)) {
            const newPath = path ? `${path}.${key}` : key;
            if (val.type === 'object' || val.type === 'array') {
                Object.assign(result, flattenSchema(val, newPath));
            } else {
                result[newPath] = val.type;
            }
        }
        return result;
    } else if (schema.type === 'array') {
        return { [path || 'items']: `array<${schema.items?.type || 'any'}>` };
    }
    return { [path]: schema.type };
}

/** The sidebar's icon and colour for a category name. */
export function getCategoryIcon(cat: string): { icon: string; color: string } {
    const lower = cat.toLowerCase();
    if (lower.includes('ai')) return { icon: '🤖', color: '#a855f7' };
    if (lower.includes('data')) return { icon: '📊', color: '#3b82f6' };
    if (lower.includes('api') || lower.includes('http')) return { icon: '🌐', color: '#22c55e' };
    if (lower.includes('flow') || lower.includes('logic')) return { icon: '⚡', color: '#f59e0b' };
    if (lower.includes('communication') || lower.includes('chat')) return { icon: '💬', color: '#06b6d4' };
    if (lower.includes('input')) return { icon: '📝', color: '#ec4899' };
    if (lower.includes('json')) return { icon: '{ }', color: '#64748b' };
    return { icon: '📦', color: '#6366f1' };
}
