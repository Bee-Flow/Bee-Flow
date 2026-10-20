// A small group of radio buttons, one per option.
export default function RadioRow<T extends string>({ name, value, options, onChange }: {
    name: string; value: T; options: Array<[T, string]>; onChange: (v: T) => void;
}) {
    return (
        <div role="radiogroup" className="space-y-1">
            {options.map(([id, label]) => (
                <label key={id} className="flex items-center gap-2 text-xs">
                    <input type="radio" name={name} checked={value === id} onChange={() => onChange(id)} />
                    {label}
                </label>
            ))}
        </div>
    );
}
