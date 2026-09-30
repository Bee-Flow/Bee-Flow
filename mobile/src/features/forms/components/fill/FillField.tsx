/** One field of a form page, by its type — every type formTriggerContract.js declares. */

import React from 'react';

import { isFileField } from '@/features/forms/model/contract';

import { CheckAnswer } from './CheckAnswer';
import { ChoiceAnswer } from './ChoiceAnswer';
import { DisplayFile } from './DisplayFile';
import { FileAnswer } from './FileAnswer';
import { PickAnswer } from './PickAnswer';
import { TextAnswer } from './TextAnswer';
import type { AnswerProps } from './types';

const CONTROLS: Readonly<Record<string, (props: AnswerProps) => React.JSX.Element>> = {
    select: ChoiceAnswer,
    checkbox: CheckAnswer,
    file: FileAnswer,
    app_pick: PickAnswer,
};

export function FillField(props: AnswerProps) {
    if (isFileField(props.field)) return <DisplayFile field={props.field} actions={props.actions} />;
    const Control = CONTROLS[props.field.type] ?? TextAnswer;
    return <Control {...props} />;
}
