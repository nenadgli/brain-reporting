import { supabase } from './supabase'
import type { Brief } from './creatives'
import { actionTokens } from './briefFill'

// "Dupliraj prošlu akciju": a new action planned as a copy of a past one. The past action is read from the account
// (past_actions: campaigns, asset groups and ad sets that ran for a limited time), the new one keeps its structure
// and changes only what changes from action to action: names, dates, budgets, landing page, texts and images.
// The plan is one row in action_plans; today the team carries it out with the files Brain makes, later the Ads APIs
// create the same items directly, always Paused.

export type PastChild = { kind: 'asset_group' | 'ad_group' | 'ad_set'; name: string; start: string; end: string; spend: number; ads: string[] | null }
export type PastRow = {
  network: 'google' | 'meta'; campaign: string; type: string | null; start: string; end: string; days: number; spend: number
  always_on: boolean; campaign_id: string | null; daily_budget: number | null; bidding: string | null; target_roas: number | null
  status: string | null; final_url: string | null; children: PastChild[]
}
// One thing the past action had: an asset group / ad group / ad set (with its campaign), or a campaign without children.
export type PastUnit = { row: PastRow; child: PastChild | null; start: string; end: string; spend: number }
export type PastAction = { key: string; start: string; end: string; units: PastUnit[]; spend: number; score: number }

// new_child: a new asset group / ad set in the same campaign (the campaign keeps running between actions);
// copy_campaign: a copy of the whole campaign under a new name.
export type Op = 'new_child' | 'copy_campaign'
export type PlanItem = {
  key: string; include: boolean; network: 'google' | 'meta'; op: Op
  ct: string; kind: 'pmax' | 'search' | 'demand_gen' | 'display' | 'video' | 'app' | 'meta'
  source_campaign: string; source_campaign_id: string | null; source_child: string | null; source_spend: number; source_days: number
  campaign: string; child: string; start: string; end: string
  budget: number | null; budget_kind: 'daily' | 'lifetime'; budget_why: string
  final_url: string; url_why: string
  bidding: string | null; target_roas: number | null
}

export const KIND_LABEL: Record<PlanItem['kind'], string> = {
  pmax: 'PMax', search: 'Search', demand_gen: 'Demand Gen', display: 'Display', video: 'YouTube', app: 'App', meta: 'Meta',
}

const plain = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
const day = (d: string) => Date.parse(`${d}T00:00:00Z`)
const daysBetween = (a: string, b: string) => Math.round((day(b) - day(a)) / 864e5) + 1

// Every asset group, ad group or ad set of a past campaign is its own unit with its own dates, so a campaign that
// served two actions (Short Sales: "Vikend akcija" and "Akcija 08.-11.10.") lands in both, each with its own child.
export function groupActions(rows: PastRow[], brief: Brief | null): PastAction[] {
  const units: PastUnit[] = rows.flatMap((r): PastUnit[] => {
    const kids = r.children.filter((c) => c.name && c.spend > 0)
    return kids.length ? kids.map((c) => ({ row: r, child: c, start: c.start ?? r.start, end: c.end ?? r.end, spend: c.spend })) : [{ row: r, child: null, start: r.start, end: r.end, spend: r.spend }]
  })
  // Ad groups of a long Search campaign come and go on their own; only units that are short flights count.
  const short = units.filter((u) => daysBetween(u.start, u.end) <= 45)
  short.sort((a, b) => a.start.localeCompare(b.start))
  const actions: PastAction[] = []
  for (const u of short) {
    const a = actions.find((x) => Math.abs(day(u.start) - day(x.start)) <= 3 * 864e5)
    if (a) { a.units.push(u); if (u.end > a.end) a.end = u.end; a.spend += u.spend } else actions.push({ key: u.start, start: u.start, end: u.end, units: [u], spend: u.spend, score: 0 })
  }
  const tokens = brief ? actionTokens(brief) : []
  const most = Math.max(1, ...actions.map((a) => a.units.length))
  for (const a of actions) {
    const names = plain(a.units.map((u) => `${u.row.campaign} ${u.child?.name ?? ''}`).join(' '))
    // Same action last time (its name in the names) first, as long as it had most of the pieces a full action has
    // (an old one with one Meta campaign left in the data is a worse template than last week's complete one).
    const hits = tokens.reduce((n, t) => n + (names.includes(t) ? 1 : 0), 0)
    a.score = hits * 10 * Math.min(1, a.units.length / most) + Math.min(5, a.units.length) + Math.min(5, Math.log10(1 + a.spend))
    a.units.sort((x, y) => x.row.network.localeCompare(y.row.network) || y.spend - x.spend)
  }
  // An action of one small unit is usually noise (a test ad set); it stays in the list, just lower.
  return actions.sort((x, y) => y.start.localeCompare(x.start))
}

export function bestAction(actions: PastAction[]): PastAction | null {
  return [...actions].filter((a) => a.units.length > 1 || a.spend >= 100).sort((x, y) => y.score - x.score || y.start.localeCompare(x.start))[0] ?? actions[0] ?? null
}

export function actionLabel(a: PastAction) {
  const names = [...new Set(a.units.map((u) => u.child?.name ?? u.row.campaign))].slice(0, 3).join(', ')
  return `${shortRange(a.start, a.end)} · ${names}${a.units.length > 3 ? ` +${a.units.length - 3}` : ''} · ${a.units.length} ${a.units.length === 1 ? 'stavka' : 'stavki'} · ${Math.round(a.spend).toLocaleString('sr-RS')} €`
}

export function shortRange(s: string, e: string) {
  const f = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`
  return s === e ? f(s) : `${f(s)}–${f(e)}`
}

// ---------- names ----------

const SUFFIX = /\s*\([^()]*\)\s*$/
const core = (name: string) => name.replace(SUFFIX, '').replace(/^(LB|LFT19)_/, '').trim()
const suffix = (name: string) => name.match(SUFFIX)?.[0] ?? ''
// Meta names use underscores ("Akcija_-20%(Mkt:RS;…)"), Google names spaces ("Short Sales (Mkt:RS;…)").
const styled = (text: string, like: string) => (/_/.test(like) && !/\s/.test(core(like)) ? text.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '_') : text)

// The team writes action dates into Google asset group names as "08.-11.10." (or "01.06.-14.06.").
export function teamRange(s: string, e: string) {
  const d = (x: string) => x.slice(8, 10)
  const m = (x: string) => x.slice(5, 7)
  if (s === e) return `${d(s)}.${m(s)}.`
  return m(s) === m(e) ? `${d(s)}.-${d(e)}.${m(e)}.` : `${d(s)}.${m(s)}.-${d(e)}.${m(e)}.`
}
const DATES = /\d{1,2}\.\s?(\d{1,2}\.)?\s?-\s?\d{1,2}\.\d{1,2}\.?/

// A short name for the new action from the brief ("Mid Season Sale do -50%" -> "Mid Season Sale").
export function actionName(b: Brief): string {
  return (b.headline ?? b.title).replace(/\b(brief|akcija za|newsletter)\b/gi, '').replace(/\b(do|i do|up to)\s*-?\s*\d+\s*%/gi, '').replace(/\d{1,2}\.\d{1,2}\.?(\d{2,4})?/g, '')
    .replace(/[|:;,()"“”„]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 5).join(' ')
}

// Prefixes as the campaign forms use them: LB_ on Google, LFT19_ on Meta.
function renameCampaign(old: string, name: string, network: 'google' | 'meta') {
  return `${network === 'google' ? 'LB_' : 'LFT19_'}${styled(name, old)}${suffix(old)}`
}

// The new asset group / ad set name: the old one with the old action's words replaced by the new action's name and
// the dates moved; Google asset groups take the team's "Name dd.-dd.mm." form.
function renameChild(old: string, campaign: string, name: string, s: string, e: string, network: 'google' | 'meta') {
  const sfx = suffix(old)
  const body = core(old)
  if (network === 'google') return `${name} ${teamRange(s, e)}${sfx ? ` ${sfx.trim()}` : ''}`
  const words = body.split(/_+/)
  const cw = core(campaign).split(/_+/).map(plain)
  let n = 0
  while (n < words.length - 1 && n < cw.length && plain(words[n]) === cw[n]) n++
  // No word shared with the campaign: the action's own words are the leading ones ("Akcija_20%_na_racun_traffic").
  const keep = n ? words.slice(n) : words.filter((w) => /^(traffic|awareness|conversion|conversions|remarketing|rmk|engagement|reach)$/i.test(w))
  return [styled(name, '_'), ...keep].join('_').replace(DATES, '') + sfx
}

// ---------- the plan ----------

function kindOf(r: PastRow): PlanItem['kind'] {
  if (r.network === 'meta') return 'meta'
  const ct = r.campaign.match(/Ct:([^;)]+)/)?.[1] ?? ''
  const t = `${ct} ${r.type ?? ''}`
  if (/pmax|performance_max/i.test(t)) return 'pmax'
  if (/demand/i.test(t)) return 'demand_gen'
  if (/display/i.test(t)) return 'display'
  if (/video|youtube/i.test(t)) return 'video'
  if (/app|multi_channel/i.test(t)) return 'app'
  return 'search'
}

export function buildItems(action: PastAction, name: string, start: string, end: string): PlanItem[] {
  // A campaign that served other actions too, or one that runs all the time, gets a new child; a campaign made just
  // for the past action is copied whole.
  const servedOthers = (u: PastUnit) => u.row.always_on || u.row.children.some((c) => c.name && c.name !== u.child?.name && Math.abs(day(c.start) - day(u.start)) > 3 * 864e5)
  const seen = new Set<string>()
  const items: PlanItem[] = []
  for (const u of action.units) {
    const op: Op = u.child && servedOthers(u) ? 'new_child' : 'copy_campaign'
    // A copied campaign is one item with its children inside; its other children are not separate items.
    if (op === 'copy_campaign' && seen.has(`${u.row.network}|${u.row.campaign}`)) continue
    seen.add(`${u.row.network}|${u.row.campaign}`)
    const campaign = op === 'new_child' ? u.row.campaign : renameCampaign(u.row.campaign, name, u.row.network)
    const child = u.child ? renameChild(u.child.name, u.row.campaign, name, start, end, u.row.network) : ''
    items.push({
      key: `${u.row.network}|${u.row.campaign}|${u.child?.name ?? ''}`, include: true, network: u.row.network, op, kind: kindOf(u.row),
      ct: u.row.campaign.match(/Ct:([^;)]+)/)?.[1] ?? u.row.type ?? '',
      source_campaign: u.row.campaign, source_campaign_id: u.row.campaign_id, source_child: u.child?.name ?? null,
      source_spend: u.spend, source_days: daysBetween(u.start, u.end),
      campaign, child, start, end, budget: null, budget_kind: u.row.network === 'meta' ? 'lifetime' : 'daily', budget_why: '',
      final_url: u.row.final_url ?? '', url_why: u.row.final_url ? 'kao prošli put; proveri da li vodi na stranu nove akcije' : '',
      bidding: u.row.bidding, target_roas: u.row.target_roas,
    })
  }
  // Two old ad sets can get the same new name; the second gets "_2".
  const names = new Map<string, number>()
  for (const it of items) {
    const k = `${it.campaign}|${it.child}`
    const n = (names.get(k) ?? 0) + 1
    names.set(k, n)
    if (n > 1 && it.child) it.child = SUFFIX.test(it.child) ? it.child.replace(SUFFIX, (m) => `_${n}${m}`) : `${it.child}_${n}`
  }
  return items
}

// Which media plan line pays for the item: the network and type (PMax, Demand Gen; Meta conversion, remarketing,
// traffic, awareness), then the new action's name or dates in the line.
const META_LINE: [RegExp, RegExp][] = [
  [/Ph:Bof|remarket/i, /remarket/i],
  [/Ct:Traffic|traffic/i, /traffic/i],
  [/Ct:Awareness|awareness/i, /awareness/i],
  [/Ct:Conversion|conversion|ADV/i, /conversion/i],
]
const GOOGLE_TYPE: Partial<Record<PlanItem['kind'], string>> = { pmax: 'PERFORMANCE_MAX', search: 'SEARCH', demand_gen: 'DEMAND_GEN', display: 'DISPLAY', video: 'VIDEO' }

type Line = { network: string; ad_set_type: string | null; campaign_label: string; start_date: string | null; end_date: string | null; budget_total: number }

export async function fillBudgets(clientId: string, brief: Brief, items: PlanItem[]): Promise<PlanItem[]> {
  const month = (brief.start_date ?? items[0]?.start ?? '').slice(0, 7)
  const { data } = month ? await supabase.from('media_plan_lines').select('network, ad_set_type, campaign_label, start_date, end_date, budget_total').eq('client_id', clientId).eq('month', `${month}-01`) : { data: [] }
  const lines = (data ?? []) as Line[]
  const tokens = actionTokens(brief)
  const used = new Set<Line>()
  return items.map((it) => {
    const days = daysBetween(it.start, it.end)
    const fits = (l: Line) => {
      if (l.network !== it.network) return false
      if (it.network === 'google') return l.ad_set_type === GOOGLE_TYPE[it.kind]
      const kind = META_LINE.find(([src]) => src.test(it.source_campaign) || src.test(it.source_child ?? ''))
      return kind ? kind[1].test(l.campaign_label) : true
    }
    const score = (l: Line) => tokens.reduce((n, t) => n + (plain(l.campaign_label).includes(t) ? 2 : 0), 0) + (l.start_date && Math.abs(day(l.start_date) - day(it.start)) <= 2 * 864e5 ? 3 : 0)
    const line = lines.filter((l) => fits(l) && !used.has(l) && score(l) > 0).sort((a, b) => score(b) - score(a) || Number(b.budget_total) - Number(a.budget_total))[0]
    if (line) {
      used.add(line)
      const total = Number(line.budget_total)
      const lineDays = line.start_date && line.end_date ? daysBetween(line.start_date, line.end_date) : days
      const value = it.budget_kind === 'daily' ? Math.round(total / lineDays) : total
      return { ...it, budget: value, budget_why: `media plan „${line.campaign_label}“: ${total.toLocaleString('sr-RS')} € za ${lineDays} dana` }
    }
    // Not in the media plan: the past action's spend for the new number of days.
    const perDay = it.source_spend / Math.max(1, it.source_days)
    const value = Math.round(it.budget_kind === 'daily' ? perDay : perDay * days)
    return { ...it, budget: value || null, budget_why: value ? `nema reda u media planu; kao prošli put (${Math.round(it.source_spend).toLocaleString('sr-RS')} € za ${it.source_days} dana)` : 'upiši budžet' }
  })
}

// ---------- the plan as a file the team works from (and the API will run from) ----------

const OP_LABEL = (it: PlanItem) => it.op === 'copy_campaign' ? 'kopija kampanje' : it.network === 'meta' ? 'nov ad set u postojećoj kampanji' : it.kind === 'pmax' ? 'nova asset grupa u postojećoj kampanji' : 'nova ad grupa u postojećoj kampanji'
export const opLabel = OP_LABEL

export function planCsv(items: PlanItem[], urlTags: string): string {
  const head = ['Mreža', 'Tip', 'Šta se pravi', 'Kopira se iz kampanje', 'Kopira se iz grupe / ad seta', 'Kampanja', 'Asset grupa / ad set', 'Početak', 'Kraj', 'Budžet (€)', 'Vrsta budžeta', 'Odakle budžet', 'Final URL', 'URL tagovi (Meta)', 'Status']
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
  const rows = items.filter((i) => i.include).map((i) => [
    i.network === 'google' ? 'Google' : 'Meta', KIND_LABEL[i.kind], OP_LABEL(i), i.source_campaign, i.source_child ?? '', i.campaign, i.child,
    i.start, i.end, i.budget ?? '', i.budget_kind === 'daily' ? 'dnevni' : 'ukupni', i.budget_why, i.final_url, i.network === 'meta' ? urlTags : '', 'Paused',
  ])
  return '﻿' + [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n'
}
