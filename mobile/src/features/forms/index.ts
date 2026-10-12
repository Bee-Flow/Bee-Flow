/**
 * Forms: the directory, one form's page (Questions · Share · Answers ·
 * Settings), a new form, and filling a form in natively. Import from
 * '@/features/forms'.
 *
 * A form is an automation whose trigger is a form: its questions save through the
 * flow editor's draft store, its link is the automation's form link, and going
 * live is arming the automation.
 */

export { FormsScreen } from './screens/FormsScreen';
export { FormPageScreen, type FormPageScreenProps } from './screens/FormPageScreen';
export { NewFormScreen } from './screens/NewFormScreen';
export { FillFormScreen, type FillFormScreenProps } from './screens/FillFormScreen';

export { useFormRecents, useForms, useRememberFormOpened } from './hooks/queries';
export { recentForms } from './model/recents';
export { formFillPath, formPagePath } from './model/formPage';
export type { FormSummary } from './model/types';
