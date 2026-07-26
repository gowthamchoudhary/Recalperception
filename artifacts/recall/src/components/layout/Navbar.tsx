import { useState, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { LogOut, Languages, X, Check } from "lucide-react";
import { useCurrentUser, useLogoutAction } from "@/lib/auth";
import { useUpdateCurrentUser } from "@workspace/api-client-react";
import { GlossyButton } from "@/components/ui/glossy-button";
import { languageDisplayName, CLUSTER_LANGUAGES } from "@/lib/languages";

/**
 * Brand mark — the reference uses a leaf-shaped outline with a central dot.
 * Using the same icon as the existing app, just styled with the gradient.
 */
export function BrandMark({ className = "" }: { className?: string }) {
  return (
    <div
      className={`rounded-md flex items-center justify-center ${className}`}
      style={{
        background: "linear-gradient(135deg, #1c8a3e, #0e5024)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3)",
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" className="w-3/4 h-3/4">
        <path
          d="M4 12c2-5 6-8 8-8s6 3 8 8c-2 5-6 8-8 8s-6-3-8-8Z"
          stroke="#fff"
          strokeWidth="2"
        />
        <circle cx="12" cy="12" r="2.2" fill="#fff" />
      </svg>
    </div>
  );
}

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

function LanguageProfileDialog({
  open,
  onClose,
  profile,
  onSave,
  isPending,
}: {
  open: boolean;
  onClose: () => void;
  profile: string[];
  onSave: (langs: string[]) => void;
  isPending: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(profile));
  if (!open) return null;

  const toggle = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-md p-6 animate-in fade-in zoom-in duration-200">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-bold">Languages you film in</h3>
          <button onClick={onClose} aria-label="Close" className="text-muted-foreground hover:text-foreground">
            <X className="w-5 h-5" />
          </button>
        </div>
        <p className="text-sm text-muted-foreground font-medium mb-4">
          Recall uses this to catch likely transcription misdetections between similar languages.
        </p>
        <div className="flex flex-wrap gap-2 mb-6">
          {CLUSTER_LANGUAGES.map((code) => {
            const active = selected.has(code);
            return (
              <button
                key={code}
                onClick={() => toggle(code)}
                className={`px-3 py-1.5 rounded-full text-xs font-bold border transition-colors flex items-center gap-1.5 ${
                  active
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-secondary text-secondary-foreground border-border hover:border-primary/50"
                }`}
              >
                {active && <Check className="w-3 h-3" />}
                {languageDisplayName(code)}
              </button>
            );
          })}
        </div>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-muted-foreground hover:bg-secondary transition-colors"
          >
            Cancel
          </button>
          <button
            disabled={isPending}
            onClick={() => onSave(Array.from(selected))}
            className="px-4 py-2 rounded-xl text-sm font-bold bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-60"
          >
            {isPending ? "Saving…" : "Save languages"}
          </button>
        </div>
      </div>
    </div>
  );
}

function UserMenu() {
  const { user } = useCurrentUser();
  const { logout, isPending } = useLogoutAction();
  const [menuOpen, setMenuOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);
  const updateUser = useUpdateCurrentUser();

  if (!user) {
    return <div className="w-9 h-9 rounded-full bg-secondary animate-pulse ml-2" />;
  }

  return (
    <div className="relative ml-2">
      <button
        onClick={() => setMenuOpen((o) => !o)}
        className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold hover:opacity-90 transition-opacity"
        aria-label="Account menu"
      >
        {initialsOf(user.name, user.email)}
      </button>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
          <div className="absolute right-0 top-12 z-50 w-64 bg-card border border-border rounded-2xl shadow-xl p-2 animate-in fade-in slide-in-from-top-2 duration-150">
            <div className="px-4 py-3 border-b border-border/60 mb-1">
              <p className="font-bold text-sm truncate">{user.name}</p>
              <p className="text-xs text-muted-foreground font-medium truncate">{user.email}</p>
            </div>
            <button
              onClick={() => { setMenuOpen(false); setLangOpen(true); }}
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-secondary transition-colors"
            >
              <Languages className="w-4 h-4" />
              Languages you film in
            </button>
            <button
              onClick={() => { setMenuOpen(false); logout(); }}
              disabled={isPending}
              className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors disabled:opacity-60"
            >
              <LogOut className="w-4 h-4" />
              {isPending ? "Logging out…" : "Log out"}
            </button>
          </div>
        </>
      )}
      <LanguageProfileDialog
        open={langOpen}
        onClose={() => setLangOpen(false)}
        profile={user.languageProfile ?? []}
        isPending={updateUser.isPending}
        onSave={(languageProfile) => {
          updateUser.mutate(
            { data: { languageProfile } },
            {
              onSuccess: () => setLangOpen(false),
            },
          );
        }}
      />
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

  const isPublic = variant === "public";
  const links = isPublic
    ? [
        { href: "/search", label: "Search" },
        { href: "/dashboard", label: "Library" },
        { href: "/people", label: "People" },
        { href: "/dashboard", label: "Review" },
      ]
    : [
        { href: "/dashboard", label: "Library", active: location === "/dashboard" },
        { href: "/search", label: "Search", active: location.startsWith("/search") },
        { href: "/people", label: "People" },
        { href: "/dashboard", label: "Review" },
      ];

  return (
    <div
      className="fixed top-0 left-0 right-0 z-50 flex justify-center transition-[padding] duration-300"
      style={{ padding: scrolled ? "12px 24px" : "18px 24px" }}
    >
      <nav
        className="w-full flex items-center justify-between px-5 py-3 rounded-full transition-all duration-300"
        style={
          scrolled
            ? {
                maxWidth: 980,
                background: "linear-gradient(180deg, #ffffff, #f7f7f5)",
                border: "1px solid #e5e5e0",
                boxShadow:
                  "inset 0 1px 0 rgba(255,255,255,0.9), 0 12px 30px -10px rgba(0,0,0,0.18)",
              }
            : {
                maxWidth: 1400,
                background: "transparent",
                border: "1px solid transparent",
              }
        }
      >
        <Link href={isPublic ? "/" : "/dashboard"} className="flex items-center gap-2.5 group">
          <BrandMark className="w-6 h-6 group-hover:scale-105 transition-transform" />
          <span className="font-extrabold text-lg tracking-tight leading-none mb-0.5">recall</span>
        </Link>

        <div className="hidden md:flex items-center gap-7 text-sm font-medium text-[#55554d]">
          {links.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              className={`hover:text-[#14140f] transition-colors ${
                l.active ? "text-[#14140f] font-semibold" : ""
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-3">
          {isPublic ? (
            <>
              <Link href="/login" className="hidden sm:inline text-sm font-semibold text-[#55554d] hover:text-[#14140f] transition-colors">
                Log in
              </Link>
              <GlossyButton href="/login" variant="dark" className="px-4 py-2.5 text-[13.5px]">
                Get started
              </GlossyButton>
            </>
          ) : (
            <UserMenu />
          )}
        </div>
      </nav>
    </div>
  );
}
