import { paint } from './paint';

export interface SwatchProps {
    /** Any CSS colour, normally a theme variable. */
    color: string;
    /** Replaces the default size and shape (`h-2 w-2 rounded-sm`). */
    className?: string;
}

/** A small coloured square next to a legend label; the colour is data, so it is set through the ref. */
export function Swatch({ color, className = 'h-2 w-2 rounded-sm' }: SwatchProps) {
    return <span aria-hidden="true" className={`inline-block shrink-0 ${className}`} ref={el => paint(el, { 'background-color': color })} />;
}
