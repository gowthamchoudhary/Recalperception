import {
  useGetCurrentUser,
  getGetCurrentUserQueryKey,
  useLogout,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";

/**
 * The single source of truth for "who is logged in". Backed by the real
 * server session (GET /auth/me) — a 401 simply means logged out.
 */
export function useCurrentUser() {
  const query = useGetCurrentUser({
    query: {
      queryKey: getGetCurrentUserQueryKey(),
      retry: false,
      staleTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
    },
  });
  return {
    user: query.error ? null : (query.data ?? null),
    isLoading: query.isLoading,
  };
}

export function useLogoutAction() {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const logout = useLogout({
    mutation: {
      onSuccess: () => {
        // Drop every cached query — nothing user-scoped may survive logout.
        queryClient.clear();
        setLocation("/");
      },
    },
  });
  return { logout: () => logout.mutate(), isPending: logout.isPending };
}

export function errorMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const maybe = err as {
      error?: unknown;
      message?: unknown;
      data?: { error?: unknown };
    };
    if (typeof maybe.error === "string") return maybe.error;
    if (maybe.data && typeof maybe.data.error === "string")
      return maybe.data.error;
    if (typeof maybe.message === "string") return maybe.message;
  }
  return "Something went wrong. Please try again.";
}
