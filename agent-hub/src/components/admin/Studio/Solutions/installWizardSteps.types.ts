import type React from 'react';
import type { SourceClaim as SourceClaimData, BlueprintReadOk, TableRequirement, StepAddress, GrantRow } from './installRequirements';
import type { Catalog } from '@/components/automation/Builder/mapping/upstream/upstream.types';
import type { WaitlistUser } from '../../subscriptions/access/useSignupSettings';

/**
 * The four screens of the install wizard, and the pieces they share.
 *
 * Split out of InstallBlueprintModal so that file is the wizard's SHELL — which
 * step is showing, what the buttons do, what happens after the install — and
 * this one is what each step looks like. The decisions all live next door, in
 * that file's header; nothing here does more than render what it is handed.
 *
 * Two rules run through every screen below, and both have a test:
 *
 *   - A LIST THAT COULD NOT BE READ NEVER RENDERS AS AN EMPTY ONE. Every picker
 *     here can genuinely be empty, so each carries its own status and says
 *     which of the two it is. A silent empty picker teaches somebody their
 *     organisation has no tables.
 *   - WHAT THE FILE ASKED FOR ARRIVES UNTICKED. A page's tools run as whoever
 *     installed it, so a checkbox that came pre-ticked would hand over
 *     authority the file asked for — one screen above the code that was
 *     hardened to refuse exactly that.
 */

/** A list that could not be read must never render as an empty one. */
export interface ListStatusProps {
    status: string;
    testId: string;
}

export interface RowProps {
    children?: React.ReactNode;
    testId: string;
}

/**
  * What the file says about its own origin, as a CLAIM.
  *
  * A Blueprint comes from the installer's disk, and `source.orgName` is nothing
  * more than text that sits in that file. It may appear here, because the
  * recipient wants to know who claims to have sent this; but it appears together
  * with the sentence that says what it is. A bare sender line would turn a claim
  * into an established fact, and that is exactly the misunderstanding from which
  * someone draws a reassurance he does not have.
  *
  * Nothing here decides anything: the server uses `canRead` on the real gallery
  * row to decide what this installer may do, and that question never touches
  * this block. Without a name nothing is shown: an empty "originates from —" line adds nothing.
 */
export interface SourceClaimProps {
    source: SourceClaimData;
}

export interface ContentsStepProps {
    read: BlueprintReadOk;
    name: string;
    onName: React.Dispatch<React.SetStateAction<string>>;
}

export interface TableRowsProps {
    rows: TableRequirement[];
    choice: Record<string, string>;
    onChoice: (key: string, value: string) => void;
    catalog: { status: string; data: Catalog | null; key?: string };
}

export interface ConnectionRowsProps {
    rows: StepAddress[];
    connections: { status: string; data: { connections?: Array<{ id: string; label?: string; name?: string }> } | null; key?: string };
    choice: Record<string, string>;
    onChoice: (address: string, arg1: string) => void;
}

export interface ApproverRowsProps {
    rows: StepAddress[];
    choice: Record<string, string>;
    people: { status: string; data: WaitlistUser[] | null; key?: string };
    groups: { status: string; data: { id: string; name: string }[] | null; key?: string };
    onChoice: (address: string, arg1: string) => void;
}

/**
 * What the file asked each page to be allowed to do.
 *
 * Unticked, always. The whole point of the row is that the FILE cannot grant
 * it — a checkbox that arrived ticked would restore exactly the behaviour
 * install.js was hardened to remove, one screen higher up.
 */
export interface GrantRowsProps {
    rows: GrantRow[];
    catalog: { status: string; data: Catalog | null; key?: string };
    ticked: Record<string, GrantRow | false>;
    onTick: (key: string, on: boolean, row: GrantRow) => void;
}

/** What the installer has answered so far, by bucket and then by row. */
export interface InstallChoices {
    tables: Record<string, string>;
    connections: Record<string, string>;
    approvers: Record<string, string>;
    grants: Record<string, GrantRow | false>;
}

export interface ConnectStepProps {
    read: BlueprintReadOk;
    connections: { status: string; data: { connections?: Array<{ id: string; label?: string; name?: string }> } | null; key?: string };
    catalog: { status: string; data: Catalog | null; key?: string };
    people: { status: string; data: WaitlistUser[] | null; key?: string };
    groups: { status: string; data: { id: string; name: string }[] | null; key?: string };
    choices: InstallChoices;
    setChoices: React.Dispatch<React.SetStateAction<InstallChoices>>;
}

/** The row that names somebody and says what they may do. */
/** A person or a group, as the pickers list them. */
export interface AccessPerson {
    id: string;
    username?: string;
    email?: string;
    name?: string;
}

export interface AccessAdderProps {
    users: AccessPerson[];
    groups: AccessPerson[];
    onAdd: (value: { type: string; id: string; permission: string; }) => void;
}

export interface AccessStepProps {
    people: { key?: string; status: string; data: WaitlistUser[] | null };
    groups: { key?: string; status: string; data: { id: string; name: string }[] | null };
    access: { type: string; id: string; permission: string }[];
    setAccess: React.Dispatch<React.SetStateAction<{ type: string; id: string; permission: string }[]>>;
}

/**
 * What happened, including the parts that did not.
 *
 * `report.grantRequires` is the SERVER's list of what it refused to grant, and
 * it is rendered whether or not the Connect step spotted the same rows — the
 * client reads the file with its own eyes, and this is the answer from the side
 * that actually decides.
 */
/** What `POST /package/install` answers with. */
export interface InstallReport {
    installed?: { webpages?: Array<{ ref: string; id: string }> };
    skipped?: Array<{ kind: string; why: string }>;
    warnings?: string[];
    grantRequires?: GrantRow[];
}

export interface InstallPayload {
    error?: string;
    projectId: string;
    report?: InstallReport;
}

export interface ResultStepProps {
    result: InstallPayload | null;
    failures: string[];
}
