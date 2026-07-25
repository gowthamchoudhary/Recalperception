import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui";
import { Bell, Moon } from "lucide-react";

export function Navbar({ variant = "public" }: { variant?: "public" | "app" }) {
  const [location] = useLocation();
  
  return (
    <nav className="w-full flex items-center justify-between px-6 md:px-10 py-5 fixed top-0 z-50 bg-background/50 backdrop-blur-xl border-b border-transparent">
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
           <Link href="/dashboard" className={location === "/people" ? "text-primary" : "text-muted-foreground hover:text-primary transition-colors"}>People</Link>
           <Link href="/dashboard" className={location === "/review" ? "text-primary" : "text-muted-foreground hover:text-primary transition-colors"}>Review</Link>
         </div>
       )}

       <div className="flex items-center gap-3">
         <Button variant="ghost" size="icon" className="rounded-full hidden md:flex">
           <Moon className="w-4 h-4" />
         </Button>
         {variant === "public" ? (
           <>
             <Link href="/login" className="text-sm font-medium hover:underline underline-offset-4 mx-2">Log in</Link>
             <Link href="/login" className="bg-primary text-primary-foreground h-10 px-5 rounded-full inline-flex items-center justify-center text-sm font-medium hover:bg-primary/90 transition-colors">
               Get started
             </Link>
           </>
         ) : (
           <>
             <Button variant="ghost" size="icon" className="rounded-full relative">
               <Bell className="w-5 h-5" />
               <span className="absolute top-2 right-2 w-2 h-2 bg-accent rounded-full border-2 border-background" />
             </Button>
             <div className="w-9 h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center text-xs font-bold ml-2">
               ME
             </div>
           </>
         )}
       </div>
    </nav>
  )
}
