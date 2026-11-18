import { create } from "zustand";
import { ApiError, authApi, type User } from "../api/client";

interface AuthState {
  user: User | null;
  loading: boolean;
  initialized: boolean;
  error: string | null;
  initialize: () => Promise<void>;
  login: (input: { email: string; password: string }) => Promise<void>;
  register: (input: { name: string; email: string; password: string }) => Promise<void>;
  logout: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: false,
  initialized: false,
  error: null,

  initialize: async () => {
    try {
      const user = await authApi.me();
      set({ user, initialized: true });
    } catch (error) {
      set({
        user: null,
        initialized: true,
        error: error instanceof ApiError && error.status === 401
          ? null
          : error instanceof Error ? error.message : "Unable to check your session"
      });
    }
  },

  login: async (input) => {
    set({ loading: true, error: null });
    try {
      const user = await authApi.login(input);
      set({ user, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Sign in failed" });
      throw error;
    }
  },

  register: async (input) => {
    set({ loading: true, error: null });
    try {
      const user = await authApi.register(input);
      set({ user, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Registration failed" });
      throw error;
    }
  },

  logout: async () => {
    set({ loading: true, error: null });
    try {
      await authApi.logout();
      set({ user: null, loading: false });
    } catch (error) {
      set({ loading: false, error: error instanceof Error ? error.message : "Sign out failed" });
      throw error;
    }
  },

  clearError: () => set({ error: null })
}));
