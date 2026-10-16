// Shapes shared by the agent editor's bootstrap context, hero and category field.
import type { READ } from './canUse/canUseFacts';
import type { RefineChange } from './builderSplit/RefineDoneCard';
import type { ModelTierMap } from '../../../api/queries/modelTiers';
import type { Skill } from '../../../api/queries/skills';
import type { IntegrationStatus } from '../AgentDesigner/DesignerPanels';
import type { OrgGroup } from '../AgentDesigner/PublishMenu';

/** Whether a source could be read: not yet, read, or unreadable. */
export type ReadState = (typeof READ)[keyof typeof READ];

/** An agent category as `GET /agents/categories` lists it. */
export type CategoryRow = { id: string; name: string; icon?: string };

/** What the category actions answer with. */
export interface CategoryResult {
    ok: boolean;
    existed?: boolean;
    error?: string;
    code?: string;
    count?: number;
}

/** One line of the refine rail: the person's text, a plan, an outcome or an error. */
export interface ChatMessage {
    role: string;
    content?: string;
    plan?: unknown;
    changes?: RefineChange[];
    undoVersionId?: string | null;
    undoState?: string;
}

/** An automation as the skill picker lists it; the server row may lack an id or a title. */
export interface AutomationRow { id?: string; title?: string; [key: string]: unknown }

/** What the editor's pickers read, fetched once for the whole studio. */
export interface AgentEditorBootstrap {
    allSkills: Skill[] | null;
    integrationStatus: IntegrationStatus | null;
    categories: CategoryRow[];
    categoriesState: ReadState;
    orgGroups: OrgGroup[];
    tiers: ModelTierMap;
    automations: AutomationRow[];
    automationsState: ReadState;
    loaded: boolean;
    refreshSkills: () => Promise<void>;
    refreshCategories: () => Promise<void>;
}
