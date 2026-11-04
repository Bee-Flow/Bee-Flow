/**
 * The stable class names a form's custom CSS can target, with one line each on
 * what they are. The renderer (components/forms) puts them on its elements;
 * the server's style-assist prompt lists the same names. Every bf-form__field
 * also carries data-field="<question name>".
 */
export const FORM_CLASS_LIST: Array<{ name: string; key: string; fallback: string }> = [
    { name: 'bf-form', key: 'forms.style.class_form', fallback: 'The whole form (also on the waiting and closing screens)' },
    { name: 'bf-form__card', key: 'forms.style.class_card', fallback: 'The card everything sits on' },
    { name: 'bf-form__logo', key: 'forms.style.class_logo', fallback: 'The logo above the title' },
    { name: 'bf-form__title', key: 'forms.style.class_title', fallback: 'The title' },
    { name: 'bf-form__intro', key: 'forms.style.class_intro', fallback: 'The intro text under the title' },
    { name: 'bf-form__field', key: 'forms.style.class_field', fallback: 'One question; [data-field="name"] picks a single one' },
    { name: 'bf-form__label', key: 'forms.style.class_label', fallback: 'A question\'s label' },
    { name: 'bf-form__hint', key: 'forms.style.class_hint', fallback: 'Help text under a question' },
    { name: 'bf-form__input', key: 'forms.style.class_input', fallback: 'Text, e-mail, number, date, long text and dropdown inputs' },
    { name: 'bf-form__choice', key: 'forms.style.class_choice', fallback: 'A choice question (buttons, several choices, a checkbox)' },
    { name: 'bf-form__choice-option', key: 'forms.style.class_choice_option', fallback: 'One option of a choice question' },
    { name: 'bf-form__file', key: 'forms.style.class_file', fallback: 'A file upload' },
    { name: 'bf-form__pick', key: 'forms.style.class_pick', fallback: 'A "pick from an app" question' },
    { name: 'bf-form__error', key: 'forms.style.class_error', fallback: 'An error message' },
    { name: 'bf-form__actions', key: 'forms.style.class_actions', fallback: 'The row that holds the button' },
    { name: 'bf-form__submit', key: 'forms.style.class_submit', fallback: 'The submit button' },
    { name: 'bf-form__footer', key: 'forms.style.class_footer', fallback: 'The footer text' },
    { name: 'bf-form__progress', key: 'forms.style.class_progress', fallback: 'The progress bar while the automation works' },
    { name: 'bf-form__waiting', key: 'forms.style.class_waiting', fallback: 'The card shown while the automation works' },
    { name: 'bf-form__ending', key: 'forms.style.class_ending', fallback: 'The closing page\'s card' },
];
