import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * A number the customer can type freely. The field may be empty while they
 * type; the value is taken when they leave it or press Enter, kept within
 * min..max, and an empty or invalid field goes back to the value it had.
 *
 * The fields used to turn "" into 1 (or 0) on every keystroke, so a 1 could
 * not be deleted: to get 40 you had to type 140 and then remove the 1.
 *
 * `live` also takes every valid value while typing, for fields whose result
 * should follow along (the guide's plan, the text's size). Fields that
 * rearrange the sheet wait until the customer is done.
 */
export function NumberInput({
  value,
  onCommit,
  min = 1,
  max,
  decimals = false,
  live = false,
  ariaLabel,
  placeholder,
  style,
}: {
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  decimals?: boolean;
  live?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  style?: CSSProperties;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  // What the field held when the customer clicked into it: a field emptied
  // and left gets this back, not a value passed while deleting digits.
  const atFocus = useRef(value);
  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const parse = (text: string): number | null => {
    const n = decimals ? parseFloat(text.replace(",", ".")) : parseInt(text, 10);
    return Number.isFinite(n) ? n : null;
  };
  const inRange = (n: number) => n >= min && (max === undefined || n <= max);

  const commit = () => {
    focused.current = false;
    const n = parse(draft);
    if (n === null) {
      if (atFocus.current !== value) onCommit(atFocus.current);
      setDraft(String(atFocus.current));
      return;
    }
    const kept = Math.min(max ?? Infinity, Math.max(min, n));
    if (kept !== value) onCommit(kept);
    setDraft(String(kept));
  };

  return (
    <input
      type="text"
      inputMode={decimals ? "decimal" : "numeric"}
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onFocus={(e) => {
        focused.current = true;
        atFocus.current = value;
        e.target.select();
      }}
      onChange={(e) => {
        const text = e.target.value.replace(decimals ? /[^0-9.,]/g : /[^0-9]/g, "");
        setDraft(text);
        if (!live) return;
        const n = parse(text);
        if (n !== null && inRange(n) && n !== value) onCommit(n);
      }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
      style={style}
    />
  );
}
