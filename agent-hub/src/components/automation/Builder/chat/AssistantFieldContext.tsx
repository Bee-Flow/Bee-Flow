import { createContext, useContext } from 'react';
import type { AssistantField } from '../useBuilderShellState';

type AskAssistantField = (field: AssistantField) => unknown;

const AssistantFieldContext = createContext<AskAssistantField | null>(null);

export const AssistantFieldProvider = AssistantFieldContext.Provider;
export function useAssistantField() { return useContext(AssistantFieldContext); }
