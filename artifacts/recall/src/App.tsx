import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter, Link, Redirect } from 'wouter';
import type { ReactNode } from 'react';
import Home from './pages/home';
import Login from './pages/login';
import ChatHome from './pages/chat-home';
import ChatPage from './pages/chat';
import LibraryPage from './pages/library';
import ReviewPage from './pages/review';
import People from './pages/people';
import { useCurrentUser } from './lib/auth';

const queryClient = new QueryClient();

function NotFound() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-background text-center px-6">
      <h1 className="text-[120px] font-extrabold text-primary mb-4 leading-none tracking-tighter">404</h1>
      <p className="text-2xl font-bold text-muted-foreground mb-8">This memory could not be found.</p>
      <Link href="/" className="bg-primary text-primary-foreground h-14 px-8 rounded-full inline-flex items-center justify-center text-base font-semibold hover:bg-primary/90 transition-transform hover:scale-105">
        Return to start
      </Link>
    </div>
  );
}

/**
 * Frontend companion to the server-side session check: unauthenticated
 * visitors are bounced to /login. (The API enforces auth independently —
 * this guard is purely for UX.)
 */
function Protected({ children }: { children: ReactNode }) {
  const { user, isLoading } = useCurrentUser();
  if (isLoading) {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-background">
        <div className="w-10 h-10 border-4 border-secondary border-t-accent rounded-full animate-spin" />
      </div>
    );
  }
  if (!user) return <Redirect to="/login" />;
  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/login" component={Login} />
      <Route path="/dashboard">{() => <Protected><ChatHome /></Protected>}</Route>
      <Route path="/chat/:id">{() => <Protected><ChatPage /></Protected>}</Route>
      <Route path="/library">{() => <Protected><LibraryPage /></Protected>}</Route>
      <Route path="/review">{() => <Protected><ReviewPage /></Protected>}</Route>
      {/* The old standalone search page now lives in chat. */}
      <Route path="/search">{() => <Redirect to="/dashboard" />}</Route>
      <Route path="/people">{() => <Protected><People /></Protected>}</Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Router />
      </WouterRouter>
    </QueryClientProvider>
  );
}

export default App;
