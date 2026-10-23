import type React from 'react';

export interface MermaidBlockProps {
    code: string;
    onCodeChange: (code: string) => boolean;
    editable?: boolean;
}

export interface ToolbarBtnProps {
    onClick: React.MouseEventHandler<HTMLButtonElement>;
    title: string;
    active?: boolean;
    children?: React.ReactNode;
}
