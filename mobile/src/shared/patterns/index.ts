/**
 * Screen-level building blocks composed from the UI kit. Import from
 * '@/shared/patterns'. Each one replaces a scaffold screens used to hand-roll;
 * see ARCHITECTURE.md ("UI") for which to reach for.
 */

export {
    QueryList,
    visibleRows,
    type ListQuery,
    type QueryListNoMatch,
    type QueryListProps,
    type QueryListSearch,
} from './QueryList';
export { QueryScreen, type DetailQuery, type QueryScreenProps } from './QueryScreen';
export {
    BlockList,
    cardRows,
    type Block,
    type BlockGap,
    type BlockListProps,
    type CardRowsOptions,
} from './BlockList';
export {
    useForm,
    type FieldBinding,
    type FormErrors,
    type FormState,
    type FormValues,
    type UseFormOptions,
} from './useForm';
export { email, matches, maxLength, minLength, required, type Validator } from './validators';
export { FormSheet, type FormSheetProps } from './FormSheet';
export { ConfirmProvider, useConfirm, type ConfirmFn, type ConfirmOptions } from './confirm';
export { AudienceSheet, type Audience, type AudienceSheetProps } from './AudienceSheet';
export { UsedByList, type UsedByListProps } from './UsedByList';
export { usageHref, usageSubtitle, usageTitle } from './usedBy';
export { ORG_GROUPS_KEY, useOrgGroups } from './useOrgGroups';
export { useConfirmLeave, useLeaveGuard } from './useLeaveGuard';
export { useUserRefresh, type UserRefresh } from './useUserRefresh';
export { isStale, StaleNote, type StaleNoteProps } from './StaleNote';
