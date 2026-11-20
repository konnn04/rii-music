import { Slider as S } from "radix-ui";

type Props = {
  value: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  onCommit?: (v: number) => void;
  label: string;
  className?: string;
  np?: boolean;
  valueText?: string;
};

export function Slider({ value, max, step = 1, onChange, onCommit, label, className = "", np, valueText }: Props) {
  return (
    <S.Root
      className={`group relative flex h-6 touch-none select-none items-center ${className}`}
      value={[Math.max(0, Math.min(value, max || 0))]}
      max={max || 1}
      step={step}
      onValueChange={(v) => onChange(v[0])}
      onValueCommit={(v) => onCommit?.(v[0])}
      aria-label={label}
    >
      <S.Track className={`relative h-1 grow overflow-hidden rounded-full ${np ? "bg-white/20" : "bg-surface-4"}`}>
        <S.Range className={`absolute h-full rounded-full ${np ? "bg-np-accent" : "bg-fg group-hover:bg-accent"}`} />
      </S.Track>
      <S.Thumb
        aria-valuetext={valueText}
        className="focus-ring block size-3.5 rounded-full bg-fg shadow-float opacity-0 transition-opacity duration-fast group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
      />
    </S.Root>
  );
}
