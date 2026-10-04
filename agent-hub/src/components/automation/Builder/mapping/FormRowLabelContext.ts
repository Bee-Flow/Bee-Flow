import { createContext, useContext } from 'react';

/**
 * The visible label of the settings row a field sits in (FormRow provides it).
 *
 * The mapping fields (BindingField, TemplateField, PathField, FieldKeyCombobox,
 * ValueBuilder) tell the drawer which setting has focus so the "Comes in"
 * column can say where a pick will land. They used to fall back to the field's
 * PLACEHOLDER for that name, so the header read "→ From: {{trigger.output.fr…"
 * (an example value, not a setting). The row's own label is the honest name;
 * with neither, the name is empty and the header says nothing.
 */
export const FormRowLabelContext = createContext<string | null>(null);

export function useFormRowLabel(): string | null {
    return useContext(FormRowLabelContext);
}
