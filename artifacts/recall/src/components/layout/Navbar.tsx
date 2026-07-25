import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { LogOut } from "lucide-react";
import { useCurrentUser, useLogoutAction } from "@/lib/auth";

function initialsOf(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  }
  if (parts.length === 1 && parts[0]!.length > 0) {
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return (email[0] ?? "?").toUpperCase();
}

function UserMenu() {
  const { user } = useCurrentUser();
  const { logout, isPending } = useLogoutAction();
  const [open, setOpen] = useState(false);

  if (!user) {
    return <div className="w-9 h-9 rounded-full bg-secondary animate-pulse ml-2" />;
  }

  return (
    <div className="relative ml-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold hover:opacity-90 transition-opacity"
        aria-label="Account menu"
      >
        {initialsOf(user.name, user.email)}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-12 z-50 w-64 bg-card border border-border rounded-2xl shadow-xl p-2 animate-in fade-in slide-in-from-top-2 duration-150">
            <div className="px-4 py-3 border-b border-border/60 mb-1">
              <p className="font-bold text-sm truncate">{user.name}</p>
              <p className="text-xs text-muted-foreground font-medium truncate">{user.email}</p>
            </div>
            <button
              onClick={() => { setOpen(false); logout(); }}
              disabled={isPending}
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors disabled:opacity-60"
            >
              <LogOut className="w-4 h-4" />
              {isPending ? "Logging out…" : "Log out"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function Navbar({ variant = "public" }: { variant?: "public" | "app" }) {
  const [location] = useLocation();
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  /* Pill mode — floated, centered, with rounded corners and shadow */
  const pillStyle = scrolled
    ? {
        margin: "12px auto",
        maxWidth: "720px",
        left: "50%",
        transform: "translateX(-50%)",
        borderRadius: "9999px",
        padding: "0 20px",
        background: "rgba(244,244,242,0.92)",
        backdropFilter: "blur(20px)",
        WebkitBackdropFilter: "blur(20px)",
        boxShadow: "0 4px 24px -4px rgba(0,0,0,0.12), 0 1px 3px rgba(0,0,0,0.06)",
        border: "1px solid rgba(0,0,0,0.07)",
      }
    : {};

  return (
    <nav
      className="w-full flex items-center justify-between px-6 md:px-10 py-4 fixed top-0 z-50 transition-all duration-300"
      style={scrolled ? pillStyle : { background: "transparent" }}
    >
      <Link href={variant === "public" ? "/" : "/dashboard"} className="flex items-center gap-2 group">
        <div className="w-6 h-6 bg-primary rounded-full flex items-center justify-center group-hover:scale-105 transition-transform">
          <div className="w-2 h-2 bg-accent rounded-sm" />
        </div>
        <span className="font-bold text-xl tracking-tight leading-none mb-0.5">recall</span>
      </Link>

      {variant === "public" ? (
        <div className="hidden md:flex items-center gap-8 text-sm font-medium">
          <Link href="/search" className="text-muted-foreground hover:text-primary transition-colors">Search</Link>
          <Link href="/dashboard" className="text-muted-foreground hover:text-primary transition-colors">Library</Link>
          <Link href="/dashboard" className="text-muted-foreground hover:text-primary transition-colors">People</Link>
          <Link href="/dashboard" className="text-muted-foreground hover:text-primary transition-colors">Review</Link>
        </div>
      ) : (
        <div className="hidden md:flex items-center gap-8 text-sm font-medium">
          <Link href="/dashboard" className={location === "/dashboard" ? "text-primary" : "text-muted-foreground hover:text-primary transition-colors"}>Library</Link>
          <Link href="/search" className={location.startsWith("/search") ? "text-primary" : "text-muted-foreground hover:text-primary transition-colors"}>Search</Link>
          <Link href="/dashboard" className="text-muted-foreground hover:text-primary transition-colors">People</Link>
          <Link href="/dashboard" className="text-muted-foreground hover:text-primary transition-colors">Review</Link>
        </div>
      )}

      <div className="flex items-center gap-3">
        {variant === "public" ? (
          <>
            <Link href="/login" className="text-sm font-medium hover:underline underline-offset-4 mx-2">Log in</Link>
            <Link
              href="/login"
              className="inline-flex items-center gap-2 h-10 px-5 rounded-full font-semibold text-sm transition-all hover:scale-[1.03] active:scale-95"
              style={{
                background: "linear-gradient(180deg,#414141,#030303) padding-box,linear-gradient(180deg,#575757 0%,#313131 25%,#1C1C1C 100%) border-box",
                border: "1.5px solid transparent",
                color: "#fff",
                boxShadow: "0 4px 20px rgba(0,0,0,0.22)",
              }}
            >
              Get started
            </Link>
          </>
        ) : (
          <UserMenu />
        )}
      </div>
    </nav>
  );
}
