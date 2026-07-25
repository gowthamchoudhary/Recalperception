import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Route, Switch, Router as WouterRouter, Link } from 'wouter';
import Home from './pages/home';
import Login from './pages/login';
import Dashboard from './pages/dashboard';
import Search from './pages/search';

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

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/login" component={Login} />
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/search" component={Search} />
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
