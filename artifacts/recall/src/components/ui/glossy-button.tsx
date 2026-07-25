import type { ReactNode } from "react";
import { Link } from "wouter";

/**
 * Glossy button — exact spec:
 * - Fill: linear gradient top→bottom dark (#414141→#030303) or light (#FFF→#E8E8E8)
 * - Stroke: gradient border (0% #313131 → 25% #575757 → 100% #1C1C1C), inverted for light
 * - Left: inset icon chip — small rounded-square that sits inside the button padding
 * - Shadow: soft drop, 18% opacity, blur 80px, straight down
 */
type GlossyButtonProps = {
  variant?: "dark" | "light";
  icon?: ReactNode;
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  "data-testid"?: string;
};

const CHIP_DARK =
  "bg-white/15 text-white border border-white/20 shadow-[inset_0_1px_0_rgba(255,255,255,0.15)]";
const CHIP_LIGHT =
  "bg-black/10 text-black border border-black/15 shadow-[inset_0_1px_0_rgba(0,0,0,0.1)]";

export function GlossyButton({
  variant = "dark",
  icon,
  children,
  href,
  onClick,
  disabled,
  className = "",
  "data-testid": testId,
}: GlossyButtonProps) {
  const isDark = variant === "dark";

  /*
   * Gradient border trick: paint the border as a background layer behind
   * the fill layer, then clip each to the correct box.
   */
  const style: React.CSSProperties = isDark
    ? {
        background:
          "linear-gradient(180deg, #414141, #030303) padding-box," +
          "linear-gradient(180deg, #575757 0%, #313131 25%, #1C1C1C 100%) border-box",
        border: "1.5px solid transparent",
        boxShadow: "0 8px 80px 4px rgba(0,0,0,0.18)",
        color: "#fff",
      }
    : {
        background:
          "linear-gradient(180deg, #FFFFFF, #E8E8E8) padding-box," +
          "linear-gradient(180deg, #E0E0E0 0%, #BFBFBF 25%, #D8D8D8 100%) border-box",
        border: "1.5px solid transparent",
        boxShadow: "0 8px 80px 4px rgba(0,0,0,0.10)",
        color: "#111",
      };

  const base =
    "inline-flex items-center gap-3 px-4 h-14 rounded-full font-bold text-base select-none transition-all active:scale-95 hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-60";

  const inner = (
    <span className="flex items-center gap-3">
      {icon && (
        <span
          className={`w-7 h-7 rounded-[8px] flex items-center justify-center shrink-0 ${isDark ? CHIP_DARK : CHIP_LIGHT}`}
        >
          {icon}
        </span>
      )}
      <span className="pr-1">{children}</span>
    </span>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={`${base} ${className}`}
        style={style}
        data-testid={testId}
      >
        {inner}
      </Link>
    );
  }

  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${className}`}
      style={style}
      data-testid={testId}
    >
      {inner}
    </button>
  );
}
