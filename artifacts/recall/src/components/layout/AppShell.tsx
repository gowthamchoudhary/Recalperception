import { useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { isToday, isYesterday, differenceInCalendarDays } from "date-fns";
import {
  MessageCircle,
  Film,
  Users,
  Eye,
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  LogOut,
  Languages,
  Menu,
  X,
  Loader2,
  Check,
} from "lucide-react";
import {
  useListChats,
  useUpdateChat,
  useDeleteChat,
  useListReviewItems,
  useUpdateCurrentUser,
  getListChatsQueryKey,
  getListReviewItemsQueryKey,
  type Chat,
} from "@workspace/api-client-react";
import { useCurrentUser, useLogoutAction } from "@/lib/auth";
import { BrandMark } from "@/components/layout/Navbar";
import { GlossyButton } from "@/components/ui/glossy-button";
import { languageDisplayName, CLUSTER_LANGUAGES } from "@/lib/languages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui";

function initialsOf(name: string, email: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]}${parts[1]![0]}`.toUpperCase();
  if (parts.length === 1 && parts[0]!.length > 0) return parts[0]!.slice(0, 2).toUpperCase();
  return (email[0] ?? "?").toUpperCase();
}

/** Same language dialog as the old navbar — rendered over the app shell. */
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

function groupLabel(iso: string): string {
  const d = new Date(iso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  if (differenceInCalendarDays(new Date(), d) < 7) return "Previous 7 days";
  return "Older";
}

const GROUP_ORDER = ["Today", "Yesterday", "Previous 7 days", "Older"];

/** One conversation row: open, rename inline, or delete. */
function ChatRow({ chat, active }: { chat: Chat; active: boolean }) {
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();
  const updateChat = useUpdateChat();
  const deleteChat = useDeleteChat();
  const [isRenaming, setIsRenaming] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const commitRename = () => {
    const title = draft.trim();
    setIsRenaming(false);
    if (!title || title === chat.title) {
      setDraft(chat.title);
      return;
    }
    updateChat.mutate(
      { id: chat.id, data: { title } },
      {
        onSuccess: () => void queryClient.invalidateQueries({ queryKey: getListChatsQueryKey() }),
        onError: () => setDraft(chat.title),
      },
    );
  };

  const confirmDelete = () => {
    deleteChat.mutate(
      { id: chat.id },
      {
        onSuccess: () => {
          setConfirmOpen(false);
          void queryClient.invalidateQueries({ queryKey: getListChatsQueryKey() });
          if (active) navigate("/dashboard");
        },
      },
    );
  };

  if (isRenaming) {
    return (
      <div className="px-2">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") {
              setDraft(chat.title);
              setIsRenaming(false);
            }
          }}
          className="w-full bg-white/10 text-white text-[13px] font-semibold rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 focus:ring-accent"
          data-testid={`rename-chat-input-${chat.id}`}
        />
      </div>
    );
  }

  return (
    <div className={`group/row relative flex items-center rounded-xl transition-colors ${active ? "bg-white/10" : "hover:bg-white/5"}`}>
      <Link
        href={`/chat/${chat.id}`}
        className={`flex-1 min-w-0 px-3 py-2 text-[13px] font-semibold truncate ${active ? "text-white" : "text-[#b5b5aa] hover:text-white"} transition-colors`}
        data-testid={`chat-link-${chat.id}`}
      >
        {chat.title}
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="mr-1 p-1.5 rounded-lg text-[#8f8f86] opacity-0 group-hover/row:opacity-100 data-[state=open]:opacity-100 hover:text-white hover:bg-white/10 transition-all focus-visible:opacity-100"
            aria-label={`Options for ${chat.title}`}
            data-testid={`chat-options-${chat.id}`}
          >
            <MoreHorizontal className="w-4 h-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-44 rounded-xl">
          <DropdownMenuItem
            onClick={() => {
              setDraft(chat.title);
              setIsRenaming(true);
            }}
            className="font-semibold"
            data-testid={`rename-chat-${chat.id}`}
          >
            <Pencil className="w-4 h-4 mr-2" /> Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => setConfirmOpen(true)}
            className="font-semibold text-red-600 focus:text-red-600"
            data-testid={`delete-chat-${chat.id}`}
          >
            <Trash2 className="w-4 h-4 mr-2" /> Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => !deleteChat.isPending && setConfirmOpen(o)}>
        <AlertDialogContent className="max-w-md rounded-2xl">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl font-extrabold">Delete “{chat.title}”?</AlertDialogTitle>
            <AlertDialogDescription className="font-medium">
              The conversation and its answers will be removed. Your videos are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-full font-bold" disabled={deleteChat.isPending}>
              Keep chat
            </AlertDialogCancel>
            <Button
              variant="destructive"
              className="rounded-full px-6 font-bold"
              onClick={confirmDelete}
              disabled={deleteChat.isPending}
              data-testid="confirm-delete-chat"
            >
              {deleteChat.isPending ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Deleting…
                </>
              ) : (
                "Delete chat"
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const { user } = useCurrentUser();
  const { logout, isPending: isLoggingOut } = useLogoutAction();
  const updateUser = useUpdateCurrentUser();
  const [menuOpen, setMenuOpen] = useState(false);
  const [langOpen, setLangOpen] = useState(false);

  const { data: chats = [] } = useListChats({
    query: { queryKey: getListChatsQueryKey() },
  });
  const { data: reviewItems = [] } = useListReviewItems({
    query: { queryKey: getListReviewItemsQueryKey() },
  });

  const groups = useMemo(() => {
    const byLabel = new Map<string, Chat[]>();
    for (const chat of chats) {
      const label = groupLabel(chat.updatedAt);
      const list = byLabel.get(label) ?? [];
      list.push(chat);
      byLabel.set(label, list);
    }
    return GROUP_ORDER.filter((l) => byLabel.has(l)).map((l) => ({ label: l, chats: byLabel.get(l)! }));
  }, [chats]);

  const navItems = [
    { href: "/dashboard", label: "Chat", icon: MessageCircle, active: location === "/dashboard" || location.startsWith("/chat") },
    { href: "/library", label: "Library", icon: Film, active: location === "/library" },
    { href: "/people", label: "People", icon: Users, active: location === "/people" },
    { href: "/review", label: "Review", icon: Eye, active: location === "/review", badge: reviewItems.length || undefined },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Brand */}
      <Link href="/dashboard" className="flex items-center gap-2.5 px-5 pt-5 pb-4 group" onClick={onNavigate}>
        <BrandMark className="w-6 h-6 group-hover:scale-105 transition-transform" />
        <span className="font-extrabold text-lg tracking-tight leading-none mb-0.5 text-white">recall</span>
      </Link>

      {/* New chat */}
      <div className="px-4 pb-4">
        <GlossyButton
          variant="light"
          href="/dashboard"
          className="w-full py-2.5 text-[13.5px]"
          icon={<Plus className="w-4 h-4" />}
          data-testid="new-chat-button"
        >
          New chat
        </GlossyButton>
      </div>

      {/* Primary nav */}
      <nav className="px-3 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon, active, badge }) => (
          <Link
            key={label}
            href={href}
            onClick={onNavigate}
            className={`flex items-center gap-3 px-3 py-2.5 rounded-xl text-[13.5px] font-bold transition-colors ${
              active ? "bg-white/10 text-white" : "text-[#b5b5aa] hover:text-white hover:bg-white/5"
            }`}
            data-testid={`nav-${label.toLowerCase()}`}
          >
            <Icon className="w-4 h-4" />
            <span className="flex-1">{label}</span>
            {badge ? (
              <span className="bg-accent text-accent-foreground text-[10px] font-bold px-2 py-0.5 rounded-full" data-testid="review-badge">
                {badge}
              </span>
            ) : null}
          </Link>
        ))}
      </nav>

      {/* Chat history */}
      <div className="flex-1 overflow-y-auto mt-5 px-2 pb-4 space-y-5 [scrollbar-width:thin] [scrollbar-color:#33332a_transparent]">
        {groups.length === 0 && (
          <p className="px-4 text-xs font-medium text-[#6f6f66] leading-relaxed">
            Your conversations will appear here — ask your first question to get started.
          </p>
        )}
        {groups.map((group) => (
          <div key={group.label}>
            <div className="px-3 mb-1.5 text-[10px] font-mono font-bold uppercase tracking-widest text-[#6f6f66]">{group.label}</div>
            <div className="space-y-0.5">
              {group.chats.map((chat) => (
                <ChatRow key={chat.id} chat={chat} active={location === `/chat/${chat.id}`} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* User */}
      <div className="relative border-t border-white/10 p-3">
        {user ? (
          <>
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="w-full flex items-center gap-3 px-2 py-2 rounded-xl hover:bg-white/5 transition-colors"
              aria-label="Account menu"
              data-testid="user-menu-button"
            >
              <span className="w-8 h-8 rounded-full bg-accent text-accent-foreground flex items-center justify-center text-xs font-bold shrink-0">
                {initialsOf(user.name, user.email)}
              </span>
              <span className="flex-1 min-w-0 text-left">
                <span className="block text-[13px] font-bold text-white truncate">{user.name}</span>
                <span className="block text-[11px] font-medium text-[#8f8f86] truncate">{user.email}</span>
              </span>
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                <div className="absolute left-3 right-3 bottom-[68px] z-50 bg-card border border-border rounded-2xl shadow-xl p-2 animate-in fade-in slide-in-from-bottom-2 duration-150">
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      setLangOpen(true);
                    }}
                    className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold hover:bg-secondary transition-colors"
                  >
                    <Languages className="w-4 h-4" />
                    Languages you film in
                  </button>
                  <button
                    onClick={() => {
                      setMenuOpen(false);
                      logout();
                    }}
                    disabled={isLoggingOut}
                    className="w-full flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors disabled:opacity-60"
                    data-testid="logout-button"
                  >
                    <LogOut className="w-4 h-4" />
                    {isLoggingOut ? "Logging out…" : "Log out"}
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
                updateUser.mutate({ data: { languageProfile } }, { onSuccess: () => setLangOpen(false) });
              }}
            />
          </>
        ) : (
          <div className="h-12 rounded-xl bg-white/5 animate-pulse" />
        )}
      </div>
    </div>
  );
}

/**
 * Authed application frame: dark sidebar (brand, new chat, nav, chat
 * history, account) + cream content area. On mobile the sidebar becomes a
 * slide-over behind a hamburger.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    <div className="min-h-[100dvh] bg-background flex">
      {/* Desktop sidebar */}
      <aside
        className="hidden md:flex flex-col w-[272px] shrink-0 fixed inset-y-0 left-0 z-40"
        style={{ background: "linear-gradient(180deg, #171711, #100f0b)", borderRight: "1px solid rgba(255,255,255,0.07)" }}
      >
        <SidebarContent />
      </aside>

      {/* Mobile top bar */}
      <div
        className="md:hidden fixed top-0 inset-x-0 z-40 flex items-center justify-between px-4 h-14"
        style={{ background: "linear-gradient(180deg, #171711, #100f0b)", borderBottom: "1px solid rgba(255,255,255,0.07)" }}
      >
        <Link href="/dashboard" className="flex items-center gap-2">
          <BrandMark className="w-6 h-6" />
          <span className="font-extrabold text-lg tracking-tight text-white">recall</span>
        </Link>
        <button
          onClick={() => setDrawerOpen(true)}
          className="p-2 rounded-lg text-white hover:bg-white/10 transition-colors"
          aria-label="Open menu"
          data-testid="open-sidebar"
        >
          <Menu className="w-5 h-5" />
        </button>
      </div>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="md:hidden fixed inset-0 z-50">
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => setDrawerOpen(false)} />
          <aside
            className="absolute inset-y-0 left-0 w-[300px] max-w-[85vw] flex flex-col animate-in slide-in-from-left duration-200"
            style={{ background: "linear-gradient(180deg, #171711, #100f0b)" }}
          >
            <button
              onClick={() => setDrawerOpen(false)}
              className="absolute top-4 right-4 z-10 p-1.5 rounded-lg text-[#8f8f86] hover:text-white hover:bg-white/10 transition-colors"
              aria-label="Close menu"
            >
              <X className="w-5 h-5" />
            </button>
            <SidebarContent onNavigate={() => setDrawerOpen(false)} />
          </aside>
        </div>
      )}

      {/* Content */}
      <main className="flex-1 min-w-0 md:ml-[272px] pt-14 md:pt-0 flex flex-col min-h-[100dvh]">{children}</main>
    </div>
  );
}
