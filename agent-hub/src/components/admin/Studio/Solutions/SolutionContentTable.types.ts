/** One row of a section: a listed part of the Solution. */
export type ContentItem = Record<string, unknown> & {
    id: string;
    isActive?: boolean;
    isDraft?: boolean;
    isPublished?: boolean;
    description?: unknown;
};

/** A finding the completeness check raised about one entity. */
export interface ContentFinding {
    severity?: string;
    message?: string;
    targetRef?: { id?: string; kind?: string } | null;
}

/** A node of the flow graph, as this view reads it. */
export interface GraphNodeLike {
    id: string;
    name?: string;
    type?: string;
    triggers?: unknown;
}

/** The flow graph: nodes and the links between them. */
export interface ContentGraph {
    nodes?: GraphNodeLike[];
    edges?: { from?: string; to?: string | null }[];
}

/** A node another row depends on. */
export interface DepTarget {
    id: string;
    name?: string;
}

export interface SolutionContentTableProps {
    projectId: string;
    resources: Record<string, ContentItem[] | null | undefined> | null | undefined;
    loading?: boolean;
    role: string;
    currentUserId: string | null | undefined;
    graph: ContentGraph | null | undefined;
    completeness: { findings?: ContentFinding[] } | null | undefined;
    onOpen?: (kind: string, item: ContentItem) => void;
    onRemove?: (kind: string, item: ContentItem) => void;
    onAdded?: () => void;
    readOnly?: boolean;
}
