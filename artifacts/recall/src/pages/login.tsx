import { Link, useLocation } from "wouter";
import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLogin, useSignup } from "@workspace/api-client-react";
import { Input, Button, Card } from "@/components/ui";
import { useCurrentUser, errorMessage } from "@/lib/auth";

export default function Login() {
  const [, setLocation] = useLocation();
  const [isRegister, setIsRegister] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const queryClient = useQueryClient();
  const { user } = useCurrentUser();
  const login = useLogin();
  const signup = useSignup();
  const isPending = login.isPending || signup.isPending;

  // Already logged in? Straight to the library.
  useEffect(() => {
    if (user) setLocation("/dashboard");
  }, [user, setLocation]);

  const onSuccess = async () => {
    // Refetch everything as the new account — no stale cross-user cache.
    queryClient.clear();
    setLocation("/dashboard");
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (isPending) return;
    setError(null);
    if (isRegister) {
      signup.mutate(
        { data: { name, email, password } },
        { onSuccess, onError: (err) => setError(errorMessage(err)) },
      );
    } else {
      login.mutate(
        { data: { email, password } },
        { onSuccess, onError: (err) => setError(errorMessage(err)) },
      );
    }
  };

  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center relative overflow-hidden bg-background">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-white rounded-full opacity-100 blur-[120px] pointer-events-none" />

      <Link href="/" className="absolute top-8 left-8 flex items-center gap-2 group z-20">
         <div className="w-6 h-6 bg-primary rounded-full flex items-center justify-center group-hover:scale-105 transition-transform">
            <div className="w-2 h-2 bg-accent rounded-sm" />
         </div>
         <span className="font-bold text-xl tracking-tight leading-none mb-0.5">recall</span>
      </Link>

      <Card className="w-full max-w-[420px] p-10 relative z-10 border-border/60 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.05)] rounded-[24px]">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          {isRegister ? "Create your memory" : "Welcome back"}
        </h1>
        <p className="text-muted-foreground font-medium mb-8">
          {isRegister ? "Start archiving your lifetime of video." : "Log in to search your archive."}
        </p>

        <form onSubmit={handleSubmit} className="space-y-5">
          {isRegister && (
            <div className="space-y-2">
              <label htmlFor="name" className="text-[11px] font-bold text-primary uppercase tracking-widest">Name</label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
                placeholder="Your name"
                className="h-14 rounded-xl bg-secondary/50 border-transparent focus-visible:bg-background focus-visible:border-primary/20 text-base"
              />
            </div>
          )}
          <div className="space-y-2">
            <label htmlFor="email" className="text-[11px] font-bold text-primary uppercase tracking-widest">Email</label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
              className="h-14 rounded-xl bg-secondary/50 border-transparent focus-visible:bg-background focus-visible:border-primary/20 text-base"
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="password" className="text-[11px] font-bold text-primary uppercase tracking-widest">Password</label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={isRegister ? 8 : undefined}
              autoComplete={isRegister ? "new-password" : "current-password"}
              placeholder={isRegister ? "At least 8 characters" : "••••••••"}
              className="h-14 rounded-xl bg-secondary/50 border-transparent focus-visible:bg-background focus-visible:border-primary/20 text-base"
            />
          </div>

          {error && (
            <div className="text-sm font-semibold text-red-600 bg-red-50 border border-red-200 rounded-xl px-4 py-3" role="alert">
              {error}
            </div>
          )}

          <Button
            type="submit"
            disabled={isPending}
            className="w-full h-14 rounded-xl text-base font-bold mt-2 shadow-[0_8px_20px_-8px_rgba(0,0,0,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-60 disabled:hover:scale-100"
          >
            {isPending
              ? isRegister ? "Creating account…" : "Logging in…"
              : isRegister ? "Create account" : "Log in"}
          </Button>
        </form>

        <p className="mt-8 text-center text-sm font-medium text-muted-foreground">
          {isRegister ? "Already have an archive? " : "Don't have an archive? "}
          <button
            type="button"
            onClick={() => { setIsRegister(!isRegister); setError(null); }}
            className="text-primary font-bold hover:underline underline-offset-4"
          >
            {isRegister ? "Log in" : "Sign up"}
          </button>
        </p>
      </Card>
    </div>
  )
}
