import type { TranslateParams } from '../../hooks/useTranslation';
import type React from 'react';
import type { WebpageRow } from '../../api/webpagesWebpageRow.types';
import type { OrgGroup } from '../../components/shared/VisibilityCapsule.types';

/**
 * "Who sees the page, and the address" — the fourth column of Data & connections.
 *
 * Three rows come from the shared `AudienceRows` (Personal / Whole
 * organisation / Groups) and write, as everywhere else, to
 * `PATCH /api/webpages/:id/publish`. The FOURTH row is of a different kind and
 * must be so
 * on screen too.
 *
 * ── WHY "PUBLIC" IS NOT A FOURTH RADIO BUTTON ───────────────────────
 *
 * The first three exclude each other: a page is personal OR the
 * organisation's
 * OR groups'. "Public" lies across those — a page can be personal AND have a
 * public address — so it is a switch next to the three, not a fourth option
 * among them. If it were a fourth radio, clicking "Personal" would silently
 * revoke a public link, and that is exactly the kind of surprise a sharing
 * screen is supposed to prevent.
 *
 * ── AND WHY THERE IS AN INTERMEDIATE STEP ───────────────────────────
 *
 * Turning public on is the moment someone chooses
 * WHICH COLUMNS of the bound tables may go outside. That question is asked, not guessed: on a page that
 * was never public nothing is ticked, and what is not ticked does not go
 * outside (the server sets every table missing from the answer to zero
 * columns — `applyColumnChoice`). Hence the switch first opens a column choice
 * for table bindings and only then publishes.
 *
 * ── FOUR THINGS THIS SCREEN STATES ──────────────────────────────────
 *
 *   1. a public page is a SNAPSHOT, not a live page;
 *   2. table blocks there are READ-ONLY — `readwrite` exists only for
 *      Personal, Organisation and Groups;
 *   3. the Agent block does NOT run there (`ai.ask` is deliberately kept out of
 *      the anonymous bridge). This is the "Public" row that WebpageActionsPanel
 *      announced when it said that sentence should be repeated here.
 *   4. but the BARE AI CHAT does run there when it is on. With
 *      `bridge_grants.ai.publicEnabled` the server puts a real beeflowAI bridge
 *      in the public document, and an anonymous visitor chats on the author's
 *      LLM budget (grounded on the page's knowledge with
 *      `publicGroundOnPage`). The first three are CONSTANTS, this one is a
 *      SWITCH — and nowhere else in the editor is there a screen that shows
 *      it, so staying silent lets lines 2 and 3 read as "no AI runs in
 *      public". Only the page's own AI chat can set it: there is no REST route
 *      for it, so this row SHOWS it and offers no button that does not exist.
 *
 * The ADDRESS lives in a card of its own below:
 * `/w/<slug>`, with "All options"
 * (password, e-mail addresses, expiry date) collapsed under it and the footer
 * "Part of solution" from `project_id`. The address remains when public goes
 * off — hence "the address stays" there and not "the link is gone".
 *
 * ── AND WHY "OFF" IS NOT THE SAME AS "CLOSED" ───────────────────────
 *
 * Turning public off only touches the address: the server revokes the canonical
 * share and leaves every LOOSE /share/<token> of the same page standing. That
 * keeps serving the frozen snapshot, table rows included. The screen then says
 * so aloud (`otherLinksNotice`) — otherwise the owner reads "Off" and "Not
 * serving" on a page that is anonymously reachable, and that is the dangerous
 * direction this column exists to rule out.
 */

export interface ColumnGateTable {
    datatableId: string;
    label?: string;
    columns?: string[];
    publicColumns?: string[];
}

export interface ColumnGate {
    tables?: ColumnGateTable[];
    anyBound?: boolean;
}

export type ColumnChoice = Record<string, string[]>;

export interface AddressOptions {
    accessMode: string;
    password: string;
    emails: string;
    expiresAt: string;
}

export interface AudienceModel {
    columnGate?: ColumnGate;
    public?: {
        on?: boolean;
        known?: boolean;
        aiKnown?: boolean;
        aiRuns?: boolean;
        aiGroundsOnPage?: boolean;
        accessMode?: string;
        allowedEmails?: string[];
        expiresAt?: string;
    };
    shareCount?: number;
    shareCountKnown?: boolean;
    address?: { url?: string; path?: string };
    solution?: { name: string };
}

/**
  * The lines that state the public AI. Kept apart because there are three of
  * them — the state, the grounding and where the switch DOES live — and because
  * the fourth row would otherwise become a wall of ternaries.
 */
export interface PublicAiNotesProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    ai: { known: boolean; runs: boolean; grounds: boolean; };
}

export interface PublicRowProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    model: AudienceModel;
    busy: boolean;
    onOpen: () => void;
    onTurnOff: () => Promise<void>;
    disabled: boolean;
}

export interface ColumnGateFormProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    columnGate?: ColumnGate;
    choice: ColumnChoice;
    setChoice: React.Dispatch<React.SetStateAction<ColumnChoice>>;
    onConfirm: () => Promise<void>;
    onCancel: () => void;
    busy: boolean;
}

export interface AddressCardProps {
    t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string;
    model: AudienceModel;
    options: AddressOptions;
    setOptions: React.Dispatch<React.SetStateAction<AddressOptions>>;
    onSaveOptions: () => Promise<void>;
    busy: boolean;
}

/**
 * @param {object} props
 * @param {string} props.webpageId
  * @param {object} [props.page]           the webpage row (isPublished, sharedGroups)
  * @param {Array}  [props.orgGroups]      groups for the group picker
  * @param {boolean}[props.readOnly]       non-owner: /audience is owner-only
  * @param {function}[props.onSetPersonal] the three internal rows write via
  * @param {function}[props.onSetEntireOrg]  PATCH /:id/publish, just like the capsule
 * @param {function}[props.onToggleGroup]
 */
export interface WebpageAudiencePanelProps {
    webpageId: string | number | boolean;
    page?: WebpageRow | null;
    orgGroups?: readonly OrgGroup[];
    readOnly?: boolean;
    onSetPersonal?: (() => void) | null;
    onSetEntireOrg?: (() => void) | null;
    onToggleGroup?: ((groupId: string) => void) | null;
}
