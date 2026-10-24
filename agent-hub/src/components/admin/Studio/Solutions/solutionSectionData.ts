/**
 * What a Solution can hold, section by section, without the icons: the
 * data half of solutionSections.ts. The phone reads a generated copy of this
 * file (scripts/shared-mirror.manifest.json), so keep it a leaf: no imports.
 */

export interface SectionRow {
    /** The key of this section in the GET /api/projects/:id/resources payload. */
    key: string;
    labelKey: string;
    /** The server's kind name, used for attach/detach. */
    kind: string;
    movable: boolean;
    ownerFields: readonly string[] | null;
}

export const SECTION_DATA: readonly SectionRow[] = [
    { key: 'notebooks', labelKey: 'projects.notebooks', kind: 'notebook', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'apps', labelKey: 'projects.apps', kind: 'app', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'automations', labelKey: 'projects.automations', kind: 'automation', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'webpages', labelKey: 'projects.webpages', kind: 'webpage', movable: true, ownerFields: ['userId', 'ownerId'] },
    { key: 'datatables', labelKey: 'datatables.heading', kind: 'datatable', movable: true, ownerFields: ['ownerUserId'] },
    { key: 'agents', labelKey: 'agent_studio.title', kind: 'agent', movable: true, ownerFields: ['ownerId'] },
    { key: 'skills', labelKey: 'skills.title', kind: 'skill', movable: true, ownerFields: ['ownerId'] },
    { key: 'documentTemplates', labelKey: 'documents.library.templates', kind: 'document_template', movable: true, ownerFields: ['userId'] },
    { key: 'knowledgeBases', labelKey: 'knowledge.title', kind: 'knowledge_base', movable: true, ownerFields: null },
    { key: 'approvals', labelKey: 'projects.approvals', kind: 'approval', movable: false, ownerFields: null },
];

/** The three bands of the content table, and which membership sections land in each. */
export const SOLUTION_BANDS = [
    { key: 'people', labelKey: 'solutions.band_people', fallback: 'People use', sections: ['apps', 'webpages'] },
    { key: 'work', labelKey: 'solutions.band_work', fallback: 'Work happens', sections: ['automations', 'approvals'] },
    { key: 'knowledge', labelKey: 'solutions.band_knowledge', fallback: 'Knowledge & data', sections: ['datatables', 'agents', 'skills', 'documentTemplates', 'knowledgeBases', 'notebooks'] },
];
