/**
 * The shape of one field of a template the assistant fills in with the user,
 * as the template-fill form renders it. A `list` field carries its columns in
 * `fields`.
 */
export type TemplateFillFieldType = 'text' | 'number' | 'date' | 'boolean' | 'choice' | 'list';

export interface TemplateFillField {
    key: string;
    label: string;
    type: TemplateFillFieldType;
    required: boolean;
    options?: string[];
    help?: string;
    /** The full instructions, behind an ⓘ toggle. */
    details?: string;
    example?: string;
    /** A value to offer (the template's default): shown, accepted with one click, not filled in until then. */
    suggestion?: unknown;
    fields?: TemplateFillField[];
}
