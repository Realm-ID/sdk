/**
 * React bindings for @realm-id/web.
 *
 *   <RealmProvider realm={realm}>
 *     <App />
 *   </RealmProvider>
 *
 *   const { state, login, logout, switchTenant } = useRealm();
 *   const user = useUser();         // null when anonymous
 *   const tenant = useTenant();     // null when no tenant selected
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { AuthState, LoginRequest, LoginResponse, Realm, TenantRef, UserSummary } from "@realm-id/web";

interface RealmContextValue {
  realm: Realm;
  state: AuthState;
  login: (req: LoginRequest) => Promise<LoginResponse>;
  logout: () => Promise<void>;
  switchTenant: (tenantId: string) => Promise<void>;
}

const RealmContext = createContext<RealmContextValue | null>(null);

export interface RealmProviderProps {
  realm: Realm;
  children: ReactNode;
}

export function RealmProvider({ realm, children }: RealmProviderProps) {
  const subscribe = useMemo(() => (fn: () => void) => realm.onAuthChange(fn), [realm]);
  const getSnapshot = useMemo(() => () => realm.getState(), [realm]);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const value = useMemo<RealmContextValue>(
    () => ({
      realm,
      state,
      login: (req) => realm.login(req),
      logout: () => realm.logout(),
      switchTenant: (tenantId) => realm.switchTenant(tenantId),
    }),
    [realm, state],
  );

  return <RealmContext.Provider value={value}>{children}</RealmContext.Provider>;
}

export function useRealm(): RealmContextValue {
  const ctx = useContext(RealmContext);
  if (!ctx) throw new Error("useRealm must be used within <RealmProvider>");
  return ctx;
}

export function useUser(): UserSummary | null {
  return useRealm().state.user;
}

export function useTenant(): TenantRef | null {
  const { state } = useRealm();
  if (!state.currentTenantId) return null;
  return state.tenants.find((t) => t.id === state.currentTenantId) ?? null;
}

export function useTenants(): TenantRef[] {
  return useRealm().state.tenants;
}

export function useIsAuthenticated(): boolean {
  return useRealm().state.status === "authenticated";
}

/**
 * Returns true once the SDK's initial restore probe has settled. Use to
 * gate routes between "loading" and "anonymous" states.
 */
export function useRealmReady(): boolean {
  const { realm, state } = useRealm();
  const [ready, setReady] = useState(state.status !== "loading");
  const fired = useRef(ready);
  useEffect(() => {
    if (fired.current) return;
    realm.ready().finally(() => {
      fired.current = true;
      setReady(true);
    });
  }, [realm]);
  return ready;
}
