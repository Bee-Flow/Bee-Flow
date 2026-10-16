/** The host's rewrite of the whole automation: how many bindings moved, or undefined. */
export type OnRenameField = (from: string, to: string) => number | undefined;

/** One declared field, as a parameter row or a form question carries it. */
export interface DesignedField {
    name?: string;
    type?: string;
    label?: string;
    description?: string;
    required?: boolean;
    [key: string]: unknown;
}

export interface RenameArgs {
    from: string;
    to: unknown;
    siblings?: unknown;
    onRenameField?: OnRenameField | null;
    takenError?: string;
    orphanNote?: boolean;
}

export interface BindingNameFieldProps {
    field: DesignedField & { name: string };
    siblings: unknown;
    bindingBase: string;
    onRenameField?: OnRenameField | null;
    onChange: (patch: { name: string }) => void;
}

export interface RowNameBoxArgs {
    name: string;
    siblings: unknown;
    onRenameField: OnRenameField | null;
    onCommit: (name: string) => void;
    sanitize: ((value: string) => string) | null;
    takenError: string;
    ariaLabel: string;
}

export interface FieldRowProps {
    row: DesignedField;
    siblings: unknown;
    types: Array<{ value: string; label: string }>;
    removeLabel: string;
    descriptionPlaceholder: string | null;
    sanitizeName: ((value: string) => string) | null;
    takenError: string;
    onRenameField: OnRenameField | null;
    onPatch: (changes: Partial<DesignedField>) => void;
    onRemove: () => void;
    position: number;
}

export interface FieldDesignerProps {
    rows?: Array<DesignedField | null> | null;
    onChange: (next: Array<DesignedField | null>) => void;
    types: Array<{ value: string; label: string }>;
    addLabel: string;
    removeLabel: string;
    emptyNote: string;
    namePrefix?: string;
    descriptionPlaceholder?: string | null;
    sanitizeName?: ((value: string) => string) | null;
    onRenameField?: OnRenameField | null;
    takenError?: string;
    defaults?: Partial<DesignedField> | null;
}
