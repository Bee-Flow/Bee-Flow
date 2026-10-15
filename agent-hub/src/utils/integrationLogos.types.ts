import type { JSX, ReactNode } from 'react';

export interface LogoProps {
    size?: number;
    className?: string;
}

export interface WrapProps extends LogoProps {
    viewBox: string;
    children?: ReactNode;
}

export type LogoComponent = (props: LogoProps) => JSX.Element;
