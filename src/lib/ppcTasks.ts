import { supabase } from './supabase'

// The PPC team's recurring Productive tasks and where Brain does them. Minutes are the team's usual
// time for one task for one client, used to estimate time saved; adjust them here.
export type TaskKey =
  | 'provera_budzeta' | 'optimizacija_budzeta' | 'provera_naloga' | 'search_terms' | 'disapproved'
  | 'recommendations' | 'placements' | 'ga4' | 'mesecna_potrosnja' | 'kampanje' | 'alokacija_budzeta'

export type View = 'review' | 'budgets' | 'campaigns'

export const TASKS: { key: TaskKey; label: string; cadence: string; minutes: number; view: View }[] = [
  { key: 'provera_budzeta', label: 'Provera budžeta', cadence: 'pon/sre/pet', minutes: 15, view: 'review' },
  { key: 'optimizacija_budzeta', label: 'Optimizacija dnevnih budžeta i tROAS', cadence: '~3× mesečno', minutes: 30, view: 'budgets' },
  { key: 'provera_naloga', label: 'Provera naloga i kampanja', cadence: 'nedeljno', minutes: 20, view: 'review' },
  { key: 'search_terms', label: 'Search terms i KW optimizacija', cadence: '2× mesečno', minutes: 45, view: 'review' },
  { key: 'disapproved', label: 'Disapproved ads', cadence: 'nedeljno', minutes: 15, view: 'review' },
  { key: 'recommendations', label: 'Weekly Recommendations check', cadence: 'nedeljno', minutes: 20, view: 'review' },
  { key: 'placements', label: 'Placement optimizacija', cadence: 'nedeljno', minutes: 30, view: 'review' },
  { key: 'ga4', label: 'GA4 analiza source/medium', cadence: 'nedeljno', minutes: 30, view: 'review' },
  { key: 'alokacija_budzeta', label: 'Mesečna alokacija budžeta', cadence: 'mesečno, do 1.', minutes: 60, view: 'budgets' },
  { key: 'mesecna_potrosnja', label: 'Mesečna potrošnja (svi klijenti)', cadence: 'do 5. u mesecu', minutes: 60, view: 'budgets' },
  { key: 'kampanje', label: 'Kampanje i akcije', cadence: 'po briefu', minutes: 60, view: 'campaigns' },
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
