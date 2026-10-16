/**
 * The Compliance Center's shared form atoms (audits/auditForms.ts) and its
 * status pill, re-exported for the chat-signals card.
 */
import StatusPillJs from '../../../shared/StatusPill';
import {
    ActionButton as ActionButtonJs,
    DateInput as DateInputJs,
    Field as FieldJs,
    Select as SelectJs,
    TextArea as TextAreaJs,
    TextInput as TextInputJs,
    Toggle as ToggleJs,
} from '../../audits/auditForms';

export const Field = FieldJs;

export const TextInput = TextInputJs;
export const DateInput = DateInputJs;
export const TextArea = TextAreaJs;

export const Select = SelectJs;

export const Toggle = ToggleJs;

export const ActionButton = ActionButtonJs;

export const StatusPill = StatusPillJs;
