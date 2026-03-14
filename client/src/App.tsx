import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SignedIn, SignedOut, RedirectToSignIn, SignIn } from "@clerk/clerk-react";
import NotFound from "@/pages/not-found";
import Home from "@/pages/home";
import Upgrade from "@/pages/upgrade";

function Router() {
  return (
    <Switch>
      <Route path="/">
        <SignedIn>
          <Home />
        </SignedIn>
        <SignedOut>
          <div className="flex items-center justify-center min-h-screen">
            <SignIn routing="hash" />
          </div>
        </SignedOut>
      </Route>
      <Route path="/upgrade">
        <SignedIn>
          <Upgrade />
        </SignedIn>
        <SignedOut>
          <RedirectToSignIn />
        </SignedOut>
      </Route>
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
