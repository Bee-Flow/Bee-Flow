/** One step of a sequence action; the branch bodies are step lists of their own. */
export interface Step {
    kind?: string;
    screenId?: string;
    modalId?: string;
    then?: Step[];
    else?: Step[];
    steps?: Step[];
    default?: Step[];
    cases?: { steps?: Step[] }[];
    [key: string]: unknown;
}
