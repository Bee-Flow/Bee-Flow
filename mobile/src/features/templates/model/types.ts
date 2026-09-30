/** Template shapes, from server/stores/templateStore.js (mapRow). */

/** `{{Name: description}}` placeholders mammoth found in the .docx. */
export interface TemplateParameter {
    name: string;
    description: string;
}

export interface Template {
    id: string;
    userId: string;
    name: string;
    description: string;
    instructions: string;
    fileName: string | null;
    storageKey: string;
    parameters: TemplateParameter[];
    knowledgeBaseIds: string[];
    createdAt: string | null;
    updatedAt: string | null;
}
