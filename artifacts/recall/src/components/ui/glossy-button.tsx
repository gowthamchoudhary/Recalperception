import { useState, type ReactNode } from "react";
import { Link } from "wouter";

/**
 * Gradient/glass button system — matches the reference landing spec.
 *
 * .dark: vertical fill #414141 → #030303, border #1c1c1c, inset highlight,
 *        1px top edge #575757, deep soft shadow.
 * .light: vertical fill #ffffff → #e8e8e8, border #d6d6d6, inset highlight,
 *         1px top edge #cfcfcf, soft shadow — for use on dark surfaces.
 */
type GlossyButtonProps = {
  variant?: "dark" | "light";
  children: ReactNode;
  href?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
  icon?: ReactNode;
  type?: "button" | "submit";
  "data-testid"?: string;
};

const base =
  "inline-flex items-center justify-center gap-2 rounded-full font-bold transition-transform active:translate-y-px active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-60";

export function GlossyButton({
  variant = "dark",
  children,
  href,
  onClick,
  disabled,
  className = "",
  icon,
  type = "button",
  "data-testid": testId,
}: GlossyButtonProps) {
  const [hover, setHover] = useState(false);
  const isDark = variant === "dark";

  const style: React.CSSProperties = isDark
    ? {
        color: "#fff",
        background: "linear-gradient(180deg, #414141 0%, #030303 100%)",
        border: "1px solid #1c1c1c",
        boxShadow: hover
          ? "inset 0 1px 0 rgba(255,255,255,0.24), inset 0 -1px 0 rgba(0,0,0,0.4), 0 1px 0 0 #666, 0 18px 34px -8px rgba(0,0,0,0.6)"
          : "inset 0 1px 0 rgba(255,255,255,0.18), inset 0 -1px 0 rgba(0,0,0,0.4), 0 1px 0 0 #575757, 0 14px 30px -10px rgba(0,0,0,0.55)",
      }
    : {
        color: "#111",
        background: "linear-gradient(180deg, #ffffff 0%, #e8e8e8 100%)",
        border: "1px solid #d6d6d6",
        boxShadow: hover
          ? "inset 0 1px 0 rgba(255,255,255,0.95), inset 0 -1px 0 rgba(0,0,0,0.06), 0 1px 0 0 #cfcfcf, 0 14px 30px -8px rgba(0,0,0,0.4)"
          : "inset 0 1px 0 rgba(255,255,255,0.9), inset 0 -1px 0 rgba(0,0,0,0.06), 0 1px 0 0 #cfcfcf, 0 10px 24px -8px rgba(0,0,0,0.35)",
      };

  const content = (
    <>
      {icon}
      {children}
    </>
  );

  if (href) {
    return (
      <Link
        href={href}
        className={`${base} ${className}`}
        style={style}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        data-testid={testId}
      >
        {content}
      </Link>
    );
  }

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${className}`}
      style={style}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      data-testid={testId}
    >
      {content}
    </button>
  );
}
