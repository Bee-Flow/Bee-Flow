// Types for the JavaScript audit form helpers (auditForms.js). The .js infers
// RegisterLayout's `drawerMode = undefined` default as the type `undefined`,
// which rejects the DrawerMode that useDrawerMode returns; the declarations
// here give TypeScript callers the real prop types.
import type { ReactElement, ReactNode, Ref } from 'react';
import type { DrawerMode } from '../../shared/useDrawerMode';

type Table = Readonly<Record<string, string>>;
type Props = Record<string, unknown>;

export const AUDIT_STATUS: Table;
export const FINDING_SEVERITY: Table;
export const NC_STATUS: Table;
export const NC_SEVERITY: Table;
export const NC_SOURCE: Table;
export const OBJ_STATUS: Table;

export function labelOf(t: unknown, table: unknown, value: unknown): string;
export function toneOf(table: unknown, value: unknown, fallback?: string): string;
export function userName(orgUsers: unknown, id: unknown): string;
export function fmtDate(value: unknown, locale?: string): string;
export function fmtStamp(value: unknown, locale?: string): string;
export function dateInputValue(value: unknown): string;
export function isOverdue(dueAt: unknown, options?: { closed?: boolean; now?: number }): boolean;
export function userOptionLabel(user: unknown): string;

export const INPUT_CLASS: string;
export const LABEL_CLASS: string;
export const PAGE_FRAME: string;

export function Field(props: Props): ReactElement;
export function TextInput(props: Props): ReactElement;
export function TextArea(props: Props): ReactElement;
export function DateInput(props: Props): ReactElement;
export function Select(props: Props): ReactElement;
export function UserSelect(props: Props): ReactElement;
export function UserChecklist(props: Props): ReactElement;
export function Toggle(props: Props): ReactElement;
export function ActionButton(props: Props): ReactElement;
export function Fact(props: Props): ReactElement;
export function ReadFailed(props: Props): ReactElement;
export function Intro(props: Props): ReactElement;

export interface RegisterLayoutProps {
    toolbar?: ReactNode;
    children?: ReactNode;
    drawer?: ReactNode;
    isMobile?: boolean;
    drawerMode?: DrawerMode | undefined;
    frameRef?: Ref<HTMLDivElement> | ((node: HTMLDivElement | null) => void) | undefined;
    testId?: string;
}

export function RegisterLayout(props: RegisterLayoutProps): ReactElement;
