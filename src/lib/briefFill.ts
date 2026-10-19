import { supabase } from './supabase'
import type { Brief } from './creatives'

// What a brief often leaves out, filled from the account and the media plan: the landing page and the daily budget.
// Both come with a short reason, so the form says where the value came from.

const plain = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
const STOP = new Set(['akcija', 'akcije', 'brief', 'online', 'samo', 'the', 'and', 'za', 'na', 'do', 'od', 'sa'])

// Words of the action's name and its initials ("Mid season sale" -> mid, season, sale, mss): what a landing page
// path or a media plan line for it usually contains.
export function actionTokens(b: Brief): string[] {
  const words = plain(b.headline ?? b.title).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w))
  const all = plain(b.title).split(/[^a-z0-9]+/).filter(Boolean)
  const initials = all.length >= 2 ? all.map((w) => w[0]).join('') : ''
  return [...new Set([...(initials.length >= 3 ? [initials] : []), ...words])]
}

export async function landingFor(clientId: string, b: Brief): Promise<{ url: string; why: string } | null> {
  if (b.landing_page) return { url: b.landing_page, why: 'iz briefa' }
  const { data: snap } = await supabase.from('google_search_ads').select('snapshot_date').eq('client_id', clientId).order('snapshot_date', { ascending: false }).limit(1)
  if (!snap?.length) return null
  const { data: ads } = await supabase.from('google_search_ads').select('final_url').eq('client_id', clientId).eq('snapshot_date', snap[0].snapshot_date).limit(1000)
  // Pages of earlier drafts count too (PMax and Demand Gen landing pages are not in the Search ads snapshot).
  const drafts = await Promise.all(['pmax_asset_group_drafts', 'demand_gen_drafts', 'display_ad_drafts'].map((t) =>
    supabase.from(t).select('final_url').eq('client_id', clientId).order('created_at', { ascending: false }).limit(50)))
  const urls = [...new Set([...(ads ?? []), ...drafts.flatMap((d) => d.data ?? [])].map((a) => String(a.final_url ?? '')).filter((u) => /^https?:\/\//.test(u)))]
  if (!urls.length) return null
  const tokens = actionTokens(b)
  const path = (u: string) => plain(new URL(u).pathname)
  // The initials ("mss") say more than a single word like "sale".
  const weight = (t: string, i: number) => (i === 0 && t.length <= 4 && !/[aeiou]{2}/.test(t) && plain(b.title).split(/\s+/).length >= 2 ? 2 : 1)
  const hit = urls.map((u) => ({ u, n: tokens.reduce((n, t, i) => n + (path(u).includes(t) ? weight(t, i) : 0), 0) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n || x.u.length - y.u.length)[0]
  if (hit) return { url: hit.u, why: 'strana iz naloga koja odgovara nazivu akcije, proveri da li je aktuelna' }
  const home = urls.sort((x, y) => path(x).length - path(y).length)[0]
  return { url: home, why: 'brief nema landing page; početna strana iz naloga, zameni stranom akcije' }
}

// Daily budget from the media plan line for this action and campaign type (its budget over its days).
export async function dailyBudgetFor(clientId: string, b: Brief, adSetType: 'SEARCH' | 'PERFORMANCE_MAX' | 'DEMAND_GEN' | 'DISPLAY'): Promise<{ value: number; why: string } | null> {
  if (!b.start_date) return null
  const month = `${b.start_date.slice(0, 7)}-01`
  const { data } = await supabase.from('media_plan_lines').select('campaign_label, ad_set_type, start_date, end_date, budget_total').eq('client_id', clientId).eq('network', 'google').eq('month', month)
  const tokens = actionTokens(b)
  const lines = (data ?? []).filter((l) => l.ad_set_type === adSetType && tokens.some((t) => plain(String(l.campaign_label)).includes(t)))
  const line = lines.sort((x, y) => Number(y.budget_total) - Number(x.budget_total))[0]
  if (!line) return null
  const start = line.start_date ?? b.start_date
  const end = line.end_date ?? b.end_date ?? start
  const days = Math.max(1, Math.round((Date.parse(end) - Date.parse(start)) / 864e5) + 1)
  return { value: Math.round(Number(line.budget_total) / days), why: `media plan „${line.campaign_label}“: ${Number(line.budget_total)} € za ${days} dana` }
}
