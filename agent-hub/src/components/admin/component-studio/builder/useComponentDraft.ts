// The state of the component being edited: the form, its input / output /
// dependency rows and the dirty flag, plus the test tab's input, output and
// run state. useComponentEditor drives it; the panes read and write it.

import { useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
    DEFAULT_COMPONENT_CODE,
    INITIAL_FORM,
    formFromDefinition,
    parseDependencies,
    parseInputs,
    parseOutputs,
} from './componentForm';
import type { ComponentDefinition, ComponentFormData, DependencyRow, InputRow, OutputRow, TestOutput } from './componentForm';

export interface ComponentDraft {
    formData: ComponentFormData;
    setFormData: Dispatch<SetStateAction<ComponentFormData>>;
    inputsList: InputRow[];
    setInputsList: Dispatch<SetStateAction<InputRow[]>>;
    outputsList: OutputRow[];
    setOutputsList: Dispatch<SetStateAction<OutputRow[]>>;
    dependenciesList: DependencyRow[];
    setDependenciesList: Dispatch<SetStateAction<DependencyRow[]>>;
    isDirty: boolean;
    setIsDirty: Dispatch<SetStateAction<boolean>>;
    testInput: string;
    setTestInput: Dispatch<SetStateAction<string>>;
    testOutput: TestOutput | null;
    setTestOutput: Dispatch<SetStateAction<TestOutput | null>>;
    isTesting: boolean;
    setIsTesting: Dispatch<SetStateAction<boolean>>;
    /** Fill the form from a loaded definition; returns the parsed input rows. */
    loadDefinition: (id: string, data: ComponentDefinition) => InputRow[];
    /** Reset the form to the starter template of a new component. */
    loadStarter: () => void;
}

export function useComponentDraft(): ComponentDraft {
    const [formData, setFormData] = useState<ComponentFormData>(INITIAL_FORM);
    const [inputsList, setInputsList] = useState<InputRow[]>([]);
    const [outputsList, setOutputsList] = useState<OutputRow[]>([{ key: 'result', type: 'any' }]);
    const [dependenciesList, setDependenciesList] = useState<DependencyRow[]>([]);
    const [isDirty, setIsDirty] = useState(false);
    const [testInput, setTestInput] = useState('{}');
    const [testOutput, setTestOutput] = useState<TestOutput | null>(null);
    const [isTesting, setIsTesting] = useState(false);

    const loadDefinition = (id: string, data: ComponentDefinition) => {
        setFormData(formFromDefinition(id, data));
        const parsedInputs = parseInputs(data.inputs);
        setInputsList(parsedInputs);
        setOutputsList(parseOutputs(data.outputs));
        setDependenciesList(parseDependencies(data.dependencies));
        return parsedInputs;
    };

    const loadStarter = () => {
        setFormData({ ...INITIAL_FORM, code: DEFAULT_COMPONENT_CODE });
        setInputsList([{ key: 'input', type: 'string', defaultValue: '', description: '' }]);
        setOutputsList([{ key: 'output', type: 'any' }]);
        setDependenciesList([]);
    };

    return {
        formData, setFormData,
        inputsList, setInputsList,
        outputsList, setOutputsList,
        dependenciesList, setDependenciesList,
        isDirty, setIsDirty,
        testInput, setTestInput,
        testOutput, setTestOutput,
        isTesting, setIsTesting,
        loadDefinition,
        loadStarter,
    };
}
