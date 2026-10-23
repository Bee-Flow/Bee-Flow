import type { TranslateParams } from '../../hooks/useTranslation';

export interface ScannedCall {
    kind: string;
    method: string | null;
    url: string;
    urlPrefix: string;
    dynamic: boolean;
    host: string;
    source: string;
    line: number;
    occurrences: number;
}

export interface CodeScan {
    scanned: boolean;
    calls?: ScannedCall[];
    unresolved: number;
    externalCount: number;
}

export interface BindingsPayload {
    code?: CodeScan | { scanned?: undefined };
    forms?: { supported: boolean; scanned: boolean };
    uses?: { targets?: { automation?: { id: string; count: number }[] } };
    elements?: { scanned?: boolean; marks?: unknown[] };
    agent: { known?: boolean; agentId?: string | null };
}

export type NavigateFn = ((value: string) => void) | null;

export interface OwnCodeCardProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    call: ScannedCall;
    onNavigate?: NavigateFn;
}

export interface OwnCodeSectionProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    code: CodeScan | { scanned?: undefined };
    onNavigate?: NavigateFn;
    onRetry: () => Promise<void>;
}

/**
  * The automations this panel LETS HAPPEN — from the elements on the page.
  *
  * This card literally said "form blocks are not part of this page's building
  * blocks yet, so none can be listed here", while the server already returned
  * `forms.supported: true` and the Code tab next to it drew a `<bf-form>` with
  * file and line. Two panels in the same tab contradicted each other, and the
  * card did not even read the data that the answer contained.
  *
  * The three states of the rest of this panel apply here too: not looked,
  * looked and found nothing, looked and found this.
 */
export interface FormsCardProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    forms?: { supported: boolean; scanned: boolean };
    uses?: BindingsPayload['uses'];
    elements?: BindingsPayload['elements'];
    onNavigate?: NavigateFn;
}

export interface AgentCardProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    agent: BindingsPayload['agent'];
}

/**
 * @param {object} props
 * @param {string} props.webpageId
  * @param {boolean} [props.readOnly]   non-owner: /bindings is owner-only
  * @param {function} [props.onNavigate] in-app navigation for the deep links
 */
export interface WebpageActionsPanelProps {
    webpageId: string;
    readOnly?: boolean;
    onNavigate?: NavigateFn;
}
