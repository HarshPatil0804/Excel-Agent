import { create } from 'zustand'

type Theme = 'light' | 'dark'
interface PreferencesState { theme: Theme; setTheme: (theme: Theme) => void }

export const usePreferencesStore = create<PreferencesState>((set) => ({ theme: 'light', setTheme: (theme) => set({ theme }) }))
