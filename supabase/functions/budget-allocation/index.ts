import { createClient } from 'jsr:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

// Mesečna alokacija budžeta. Brain splits next month's total per network (media plan or the team's
// number) across campaigns from the last 30 days' spend, ROAS and budget-limited impression share.
// Every amount is computed here; Claude only writes the one-sentence reason per campaign and a
// summary, and every number it writes is checked against that campaign's own numbers.
// action "inputs": default totals and the campaign numbers. action "propose": stores a draft
// proposal. The team edits and approves it in Budžeti; nothing is changed in any ad account.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MODEL = 'claude-opus-5-5'
const sb = createClient(SUPABASE_URL, SERVICE)
const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

type Input = {
  network: 'google' | 'meta'; campaign: string; campaign_type: string | null; daily_budget: number | null
  spend_last_month: number; spend_ly_month: number; spend_30d: number; value_30d: number; conversions_30d: number
  roas_30d: number | null; cpa_30d: number | null; spend_7d: number; lost_is_budget: number | null
}
type Reason = 'ne_trosi' | 'ograniceno_budzetom' | 'jak_roas' | 'slab_roas' | 'bez_konverzija' | 'gornji_levak' | 'brend' | 'stabilno'
type Line = {
  network: 'google' | 'meta'; campaign: string; campaign_type: string | null
  spend_30d: number; spend_last_month: number; spend_ly_month: number; roas_30d: number | null; cpa_30d: number | null
  conversions_30d: number; lost_is_budget_pct: number | null; daily_budget_now: number | null
  group_roas: number | null; base: number; proposed: number; proposed_daily: number; change_pct: number | null; reason: Reason; why: string
}

const NETWORKS = ['google', 'meta'] as const
// Awareness and consideration campaigns are not judged on ROAS.
const UPPER_FUNNEL = /VIDEO|DISPLAY|DEMAND_GEN|REACH|AWARENESS|ENGAGEMENT|VIDEO_VIEWS|TRAFFIC|LINK_CLICKS|POST_ENGAGEMENT/i
// Brand search always shows a high ROAS and is capped by brand demand, not by budget.
const isBrand = (r: Pick<Input, 'network' | 'campaign'>) => r.network === 'google' && /brand/i.test(r.campaign)
// ROAS is compared within the same campaign type (Search with Search, PMax with PMax).
const groupOf = (r: Input) => `${r.network}|${r.campaign_type ?? ''}`
const num = (v: unknown) => Number(v ?? 0) || 0
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
const fmt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmt2 = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 2 })

async function inputs(clientId: string, month: string): Promise<Input[]> {
  const { data, error } = await sb.rpc('allocation_inputs', { p_client_id: clientId, p_month: month })
  if (error) throw error
  return ((data ?? []) as Input[]).map((r) => ({
    ...r, daily_budget: r.daily_budget == null ? null : num(r.daily_budget), spend_last_month: num(r.spend_last_month), spend_ly_month: num(r.spend_ly_month),
    spend_30d: num(r.spend_30d), value_30d: num(r.value_30d), conversions_30d: num(r.conversions_30d),
    roas_30d: r.roas_30d == null ? null : num(r.roas_30d), cpa_30d: r.cpa_30d == null ? null : num(r.cpa_30d),
    spend_7d: num(r.spend_7d), lost_is_budget: r.lost_is_budget == null ? null : num(r.lost_is_budget),
  }))
}

// Month totals: the media plan for that month, else the last approved allocation, else the last
// 30 days' spend scaled to the month.
async function defaultTotals(clientId: string, month: string, rows: Input[]) {
  const out: Record<string, { amount: number; source: 'media_plan' | 'prethodna_alokacija' | 'potrosnja_30d' }> = {}
  const { data: plan } = await sb.from('media_plan_lines').select('network, budget_total').eq('client_id', clientId).eq('month', month)
  const { data: prev } = await sb.from('allocation_proposals').select('totals').eq('client_id', clientId).eq('status', 'approved').lt('month', month).order('month', { ascending: false }).limit(1)
  for (const n of NETWORKS) {
    const p = (plan ?? []).filter((x) => x.network === n).reduce((s, x) => s + num(x.budget_total), 0)
    const a = num((prev?.[0]?.totals as Record<string, unknown> | undefined)?.[n])
    const s = rows.filter((r) => r.network === n).reduce((t, r) => t + r.spend_30d, 0) * daysIn(month) / 30
    if (p > 0) out[n] = { amount: Math.round(p), source: 'media_plan' }
    else if (a > 0) out[n] = { amount: Math.round(a), source: 'prethodna_alokacija' }
    else if (s > 0) out[n] = { amount: Math.round(s / 10) * 10, source: 'potrosnja_30d' }
  }
  return out
}

// Average ROAS per campaign type over campaigns that still spend, without brand and awareness
// campaigns; only where at least two campaigns share the type.
function groupAverages(rows: Input[]): Record<string, number> {
  const g: Record<string, { n: number; spend: number; value: number }> = {}
  for (const r of rows) {
    if (r.spend_7d <= 0 || UPPER_FUNNEL.test(r.campaign_type ?? '') || isBrand(r)) continue
    const x = (g[groupOf(r)] ??= { n: 0, spend: 0, value: 0 })
    x.n++; x.spend += r.spend_30d; x.value += r.value_30d
  }
  const out: Record<string, number> = {}
  for (const [k, x] of Object.entries(g)) if (x.n >= 2 && x.spend > 0 && x.value > 0) out[k] = Math.round(x.value / x.spend * 100) / 100
  return out
}

function allocate(rows: Input[], network: 'google' | 'meta', total: number, month: string): Line[] {
  const list = rows.filter((r) => r.network === network)
  const days = daysIn(month)
  const groupRoas = groupAverages(rows)
  const spend = list.filter((r) => r.spend_7d > 0).reduce((t, r) => t + r.spend_30d, 0)

  const draft = list.map((r) => {
    // Half the last 30 days, half the last 7 days, so a campaign that slowed down or sped up counts.
    const base = r.spend_30d > 0 ? (r.spend_30d / 30 + r.spend_7d / 7) / 2 * days : r.spend_last_month
    const avg = groupRoas[groupOf(r)] ?? null
    let reason: Reason = 'stabilno', factor = 1
    if (r.spend_7d <= 0) { reason = 'ne_trosi'; factor = 0 }
    else if (UPPER_FUNNEL.test(r.campaign_type ?? '')) reason = 'gornji_levak'
    else if (isBrand(r)) {
      reason = 'brend'
      if ((r.lost_is_budget ?? 0) >= 0.1) { reason = 'ograniceno_budzetom'; factor = 1.2 }
    }
    else if (avg != null && r.conversions_30d <= 0 && r.spend_30d >= Math.max(50, spend * 0.03)) { reason = 'bez_konverzija'; factor = 0.7 }
    else if (avg != null && r.roas_30d != null) {
      const rel = r.roas_30d / avg
      if (rel >= 1.3 && (r.lost_is_budget ?? 0) >= 0.1) { reason = 'ograniceno_budzetom'; factor = 1.2 }
      else if (rel >= 1.3) { reason = 'jak_roas'; factor = 1.1 }
      else if (rel <= 0.5) { reason = 'slab_roas'; factor = 0.8 }
    }
    return { r, base, reason, weight: base * factor, avg }
  })

  const weights = draft.reduce((s, d) => s + d.weight, 0)
  // Round to 10 for budgets that size, to 1 for small ones; the remainder goes to the largest line.
  const step = total >= 2000 ? 10 : 1
  const lines: Line[] = draft.map((d) => {
    const proposed = weights > 0 ? Math.round((total * d.weight / weights) / step) * step : 0
    return {
      network, campaign: d.r.campaign, campaign_type: d.r.campaign_type,
      spend_30d: d.r.spend_30d, spend_last_month: d.r.spend_last_month, spend_ly_month: d.r.spend_ly_month,
      roas_30d: d.r.roas_30d, cpa_30d: d.r.cpa_30d, conversions_30d: d.r.conversions_30d,
      lost_is_budget_pct: d.r.lost_is_budget == null ? null : Math.round(d.r.lost_is_budget * 100),
      daily_budget_now: d.r.daily_budget, group_roas: d.avg, base: Math.round(d.base), proposed, proposed_daily: 0,
      change_pct: null, reason: d.reason, why: '',
    }
  })
  const diff = total - lines.reduce((s, l) => s + l.proposed, 0)
  const top = lines.filter((l) => l.proposed > 0).sort((a, b) => b.proposed - a.proposed)[0]
  if (top) top.proposed = Math.round((top.proposed + diff) * 100) / 100
  for (const l of lines) {
    l.proposed_daily = Math.round(l.proposed / days * 100) / 100
    l.change_pct = l.base > 0 ? Math.round((l.proposed / l.base - 1) * 100) : null
  }
  return lines.sort((a, b) => b.proposed - a.proposed || b.spend_30d - a.spend_30d)
}

function lineNumbers(l: Line): number[] {
  return [l.spend_30d, l.spend_last_month, l.spend_ly_month, l.roas_30d, l.cpa_30d, l.conversions_30d, l.lost_is_budget_pct,
    l.daily_budget_now, l.group_roas, l.base, l.proposed, l.proposed_daily, l.change_pct].filter((x): x is number => x != null)
}

function fallbackWhy(l: Line, cur: string): string {
  const roas = l.roas_30d == null ? '' : `ROAS ${fmt2(l.roas_30d)}`
  switch (l.reason) {
    case 'ne_trosi': return 'Nije trošila poslednjih 7 dana; bez budžeta dok se ne uključi.'
    case 'ograniceno_budzetom': return `${l.lost_is_budget_pct}% prikazivanja se gubi zbog budžeta uz dobar ROAS; veći udeo u budžetu.`
    case 'jak_roas': return `${roas} iznad proseka istog tipa kampanja (${fmt2(l.group_roas ?? 0)}); nešto veći udeo u budžetu.`
    case 'slab_roas': return `${roas} znatno ispod proseka istog tipa kampanja (${fmt2(l.group_roas ?? 0)}); manji udeo u budžetu.`
    case 'brend': return 'Brend kampanja; udeo u budžetu prati dosadašnju potrošnju jer je ograničena potražnjom za brendom.'
    case 'bez_konverzija': return `Potrošeno ${fmt(l.spend_30d)} ${cur} za 30 dana bez konverzija; manji udeo u budžetu.`
    case 'gornji_levak': return 'Kampanja za doseg i razmatranje; udeo u budžetu prati dosadašnju potrošnju.'
    default: return 'Rezultati blizu proseka istog tipa kampanja; udeo u budžetu prati dosadašnju potrošnju.'
  }
}

// Every number in the model's text must come from that campaign's own numbers.
function numbersOk(text: string, nums: number[]): boolean {
  for (const raw of text.match(/\d[\d.,]*/g) ?? []) {
    const t = raw.replace(/[.,]+$/, '')
    const options = [Number(t.replace(/\./g, '').replace(',', '.')), Number(t.replace(/,/g, ''))].filter((x) => Number.isFinite(x))
    if (options.some((x) => Number.isInteger(x) && x <= 10)) continue
    const ok = options.some((x) => nums.some((n) => Math.abs(Math.abs(n) - x) <= Math.max(0.6, Math.abs(n) * 0.005)))
    if (!ok) return false
  }
  return true
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    lines: { type: 'array', items: { type: 'object', properties: { i: { type: 'integer' }, why: { type: 'string' } }, required: ['i', 'why'], additionalProperties: false } },
    summary: { type: 'string' },
  },
  required: ['lines', 'summary'],
  additionalProperties: false,
}
const SYSTEM =
  'Ti si iskusan PPC specijalista u agenciji Loft19 i obrazlažeš predlog mesečne raspodele budžeta po kampanjama za kolege. ' +
  'Pišeš na srpskom, latinicom sa svim dijakritičkim znacima (č, ć, š, ž, đ), kratko i konkretno, bez uvoda. ' +
  'Iznose je izračunao sistem; ti ih ne menjaš i ne računaš nove brojeve. Koristi ISKLJUČIVO brojeve iz podataka te iste kampanje. ' +
  'Svaki broj koji napišeš automatski se proverava; tekst sa brojem kog nema u podacima se odbacuje. Ništa se ne menja u nalogu automatski.'

async function explain(clientName: string, month: string, cur: string, lines: Line[], totals: Record<string, number>) {
  const prompt = [
    `Klijent: ${clientName}. Mesec: ${month.slice(0, 7)}. Valuta: ${cur}. Ukupno po mreži: ${JSON.stringify(totals)}.`,
    'Polja: base = dosadašnja potrošnja svedena na mesec (pola poslednjih 30, pola poslednjih 7 dana), group_roas = prosečan ROAS istog tipa kampanja bez brend kampanja, proposed = predlog za mesec, change_pct = promena u odnosu na base (uključuje i promenu ukupnog budžeta mreže, zato razlog opisuj kao veći ili manji udeo u budžetu, a ne kao povećanje ili smanjenje), reason = pravilo koje je odredilo predlog, lost_is_budget_pct = % izgubljenih prikazivanja zbog budžeta (Search).',
    'Za svaku kampanju (i = indeks) napiši jednu kratku rečenicu zašto je predlog takav. Zatim summary: 2-3 rečenice o celoj raspodeli (gde ide više, gde manje, šta proveriti pre odobravanja).',
    JSON.stringify(lines.map((l, i) => ({ i, ...l, why: undefined }))),
  ].join('\n')
  const resp = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  // deno-lint-ignore no-explicit-any
  } as any)
  if (resp.stop_reason === 'refusal') throw new Error('Model je odbio zahtev')
  const text = resp.content.find((c: { type: string }) => c.type === 'text') as { text: string } | undefined
  if (!text) throw new Error('Model nije vratio odgovor')
  return JSON.parse(text.text) as { lines: { i: number; why: string }[]; summary: string }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
    const { data: u, error: ue } = await sb.auth.getUser(jwt)
    if (ue || !u?.user) return json({ error: 'Niste ulogovani' }, 401)
    const { data: au } = await sb.from('app_users').select('agency_id, client_id').eq('id', u.user.id).maybeSingle()
    if (!au?.agency_id || au.client_id) return json({ error: 'Samo korisnici agencije' }, 403)

    const body = await req.json().catch(() => ({}))
    const clientId = String(body.client_id ?? '')
    const month = String(body.month ?? '').slice(0, 7) + '-01'
    if (!/^\d{4}-\d{2}-01$/.test(month)) return json({ error: 'Neispravan mesec' }, 400)
    const { data: client } = await sb.from('clients').select('id, name, agency_id').eq('id', clientId).maybeSingle()
    if (!client || client.agency_id !== au.agency_id) return json({ error: 'Klijent nije pronađen' }, 404)
    const { data: rs } = await sb.from('review_settings').select('params').eq('client_id', clientId).maybeSingle()
    const cur = String((rs?.params as { currency?: string } | undefined)?.currency ?? 'EUR')

    const rows = await inputs(clientId, month)
    if (body.action === 'inputs') return json({ ok: true, currency: cur, totals: await defaultTotals(clientId, month, rows), campaigns: rows })

    if (body.action !== 'propose') return json({ error: 'Nepoznata akcija' }, 400)
    const totals: Record<string, number> = {}
    for (const n of NETWORKS) {
      const v = Number(body.totals?.[n])
      if (Number.isFinite(v) && v > 0) totals[n] = Math.round(v * 100) / 100
    }
    if (!Object.keys(totals).length) return json({ error: 'Unesi ukupan budžet bar za jednu mrežu' }, 400)

    const lines: Line[] = []
    for (const n of NETWORKS) {
      if (!totals[n]) continue
      const part = allocate(rows, n, totals[n], month)
      if (!part.some((l) => l.proposed > 0)) return json({ error: `Za ${n === 'google' ? 'Google' : 'Meta'} nema kampanja koje su trošile poslednjih 7 dana` }, 400)
      lines.push(...part)
    }

    for (const l of lines) l.why = fallbackWhy(l, cur)
    let summary = ''
    let model: string | null = null
    try {
      const out = await explain(client.name, month, cur, lines, totals)
      model = MODEL
      for (const w of out.lines ?? []) {
        const l = lines[w.i]
        if (l && typeof w.why === 'string' && w.why.trim() && numbersOk(w.why, lineNumbers(l))) l.why = w.why.trim()
      }
      const all = [...lines.flatMap((l) => lineNumbers(l)), ...Object.values(totals)]
      if (typeof out.summary === 'string' && numbersOk(out.summary, all)) summary = out.summary.trim()
    } catch (e) {
      console.error('explain failed', (e as Error).message)
    }
    if (!summary) {
      const up = lines.filter((l) => (l.change_pct ?? 0) >= 10).length
      const down = lines.filter((l) => l.proposed > 0 && (l.change_pct ?? 0) <= -10).length
      const off = lines.filter((l) => l.reason === 'ne_trosi').length
      summary = `Raspodela prati dosadašnju potrošnju i ROAS: ${up} kampanja dobija bar 10% više nego što sada troši, ${down} bar 10% manje${off ? `, ${off} bez budžeta jer ne troši` : ''}. Proveriti akcije iz Productive-a za mesec pre odobravanja.`
    }

    const { data: saved, error: se } = await sb.from('allocation_proposals')
      .insert({ client_id: clientId, month, totals, lines, summary, status: 'draft', created_by: u.user.id })
      .select('id, created_at').single()
    if (se) throw se
    return json({ ok: true, id: saved.id, created_at: saved.created_at, month, currency: cur, totals, summary, lines, model })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
