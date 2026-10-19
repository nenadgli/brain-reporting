import { supabase } from './supabase'

// Areas of the PPC team's work (the old Productive tasks), used to group the history. Minutes are the team's usual
// time for one task for one client, used to estimate time saved; adjust them here.
export type TaskKey =
  | 'provera_budzeta' | 'optimizacija_budzeta' | 'provera_naloga' | 'search_terms' | 'disapproved'
  | 'recommendations' | 'placements' | 'ga4' | 'mesecna_potrosnja' | 'kampanje' | 'alokacija_budzeta' | 'osvezavanje_oglasa' | 'proizvodi' | 'hitni_alarmi'

export type View = 'review' | 'budgets' | 'campaigns' | 'products'

export const TASKS: { key: TaskKey; label: string; cadence: string; minutes: number; view: View }[] = [
  { key: 'provera_budzeta', label: 'Budžet', cadence: 'pon/sre/pet', minutes: 15, view: 'review' },
  { key: 'optimizacija_budzeta', label: 'Dnevni budžeti i tROAS', cadence: '~3× mesečno', minutes: 30, view: 'budgets' },
  { key: 'provera_naloga', label: 'Trošak i rezultati', cadence: 'nedeljno', minutes: 20, view: 'review' },
  { key: 'search_terms', label: 'Search termini', cadence: '2× mesečno', minutes: 45, view: 'review' },
  { key: 'disapproved', label: 'Odbijeni oglasi', cadence: 'nedeljno', minutes: 15, view: 'review' },
  { key: 'recommendations', label: 'Google preporuke', cadence: 'nedeljno', minutes: 20, view: 'review' },
  { key: 'placements', label: 'Plasmani', cadence: 'nedeljno', minutes: 30, view: 'review' },
  { key: 'ga4', label: 'GA4 i tracking', cadence: 'nedeljno', minutes: 30, view: 'review' },
  { key: 'alokacija_budzeta', label: 'Mesečna alokacija', cadence: 'mesečno, do 1.', minutes: 60, view: 'budgets' },
  { key: 'mesecna_potrosnja', label: 'Mesečna potrošnja', cadence: 'do 5. u mesecu', minutes: 60, view: 'budgets' },
  { key: 'proizvodi', label: 'Proizvodi i feed', cadence: 'nedeljno', minutes: 30, view: 'products' },
  { key: 'osvezavanje_oglasa', label: 'Osvežavanje oglasa', cadence: 'kvartalno', minutes: 45, view: 'campaigns' },
  { key: 'kampanje', label: 'Kampanje', cadence: 'po briefu', minutes: 60, view: 'campaigns' },
  { key: 'hitni_alarmi', label: 'Hitni alarmi (Slack)', cadence: 'po alarmu', minutes: 0, view: 'review' },
]
export const TASK_BY_KEY = Object.fromEntries(TASKS.map((t) => [t.key, t])) as Record<TaskKey, (typeof TASKS)[number]>

// Records a download or export the database cannot see otherwise. Never blocks the user's action.
export async function logAction(clientId: string | null, task: TaskKey, action: string, text: string) {
  try {
    await supabase.from('ppc_actions').insert({ client_id: clientId, task, action, detail: { text } })
  } catch {
    // Logging is best effort.
  }
}
