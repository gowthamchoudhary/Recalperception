import { Link, useLocation } from "wouter";
import { useState } from "react";
import { Input, Button, Card } from "@/components/ui";

export default function Login() {
  const [, setLocation] = useLocation();
  const [isRegister, setIsRegister] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setLocation("/dashboard");
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
              <label className="text-[11px] font-bold text-primary uppercase tracking-widest">Name</label>
              <Input placeholder="Sarah Connor" className="h-14 rounded-xl bg-secondary/50 border-transparent focus-visible:bg-background focus-visible:border-primary/20 text-base" />
            </div>
          )}
          <div className="space-y-2">
            <label className="text-[11px] font-bold text-primary uppercase tracking-widest">Email</label>
            <Input type="email" placeholder="sarah@example.com" className="h-14 rounded-xl bg-secondary/50 border-transparent focus-visible:bg-background focus-visible:border-primary/20 text-base" />
          </div>
          <div className="space-y-2">
            <label className="text-[11px] font-bold text-primary uppercase tracking-widest">Password</label>
            <Input type="password" placeholder="••••••••" className="h-14 rounded-xl bg-secondary/50 border-transparent focus-visible:bg-background focus-visible:border-primary/20 text-base" />
          </div>

          <Button type="submit" className="w-full h-14 rounded-xl text-base font-bold mt-2 shadow-[0_8px_20px_-8px_rgba(0,0,0,0.3)] hover:scale-[1.02] active:scale-[0.98] transition-all">
            {isRegister ? "Create account" : "Log in"}
          </Button>
        </form>

        <div className="relative my-8">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-[10px] uppercase font-bold tracking-widest">
            <span className="bg-card px-4 text-muted-foreground">Or continue with</span>
          </div>
        </div>

        <Button variant="outline" className="w-full h-14 rounded-xl font-bold bg-white text-base hover:bg-secondary/50 transition-colors" onClick={handleSubmit}>
          Google
        </Button>

        <p className="mt-8 text-center text-sm font-medium text-muted-foreground">
          {isRegister ? "Already have an archive? " : "Don't have an archive? "}
          <button 
            type="button" 
            onClick={() => setIsRegister(!isRegister)} 
            className="text-primary font-bold hover:underline underline-offset-4"
          >
            {isRegister ? "Log in" : "Sign up"}
          </button>
        </p>
      </Card>
    </div>
  )
}
