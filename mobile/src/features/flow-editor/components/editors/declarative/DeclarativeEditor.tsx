/**
 * The editor for every step type that has a spec (specs/): its sections as
 * accordion bands, through SpecSections.
 */

import React from 'react';

import type { StepEditorProps } from '../types';
import { specFor } from './specs';
import { SpecSections } from './SpecSections';

export function DeclarativeEditor(props: StepEditorProps) {
    const spec = specFor(props.step.type);
    return spec ? <SpecSections {...props} sections={spec.sections} /> : null;
}
