import { createClient } from 'jsr:@supabase/supabase-js@2'
import Anthropic from 'npm:@anthropic-ai/sdk'

// Jutarnji pregled (phase 1). For each client with review_settings:
// 1. review_candidates() computes every number (pacing, anomalies, tracking, search terms),
// 2. this function adds the Productive action calendar check,
// 3. Claude classifies search terms and words each finding (never computes numbers),
// 4. findings are ranked, capped and stored for the team to approve, reject or snooze.
// Nothing is changed in any ad account.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const FEEDHUB_URL = 'https://bagpjjejeuteojpsufto.supabase.co/functions/v1/export-campaign-briefs'
const MODEL = 'claude-opus-5-5'
const sb = createClient(SUPABASE_URL, SERVICE)
const anthropic = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY')! })

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

const SEVERITY_ORDER: Record<string, number> = { hitno: 0, visoko: 1, srednje: 2, info: 3 }
const today = () => new Date().toISOString().slice(0, 10)
const addDays = (iso: string, n: number) => new Date(Date.parse(iso) + n * 864e5).toISOString().slice(0, 10)
const pad = (n: number) => String(n).padStart(2, '0')

type Candidate = { check_type: string; fingerprint: string; severity: string; impact_eur: number | null; evidence: Record<string, unknown> }
type Finding = Candidate & { title: string; detail: string; proposal: string }

async function secret(name: string) {
  const { data } = await sb.from('integration_secrets').select('value').eq('name', name).maybeSingle()
  return data?.value as string | undefined
}

// ---- Productive action calendar ----
// Asset groups are named after the action dates ("Akcija 08.-11.10.", "BTS - Akcija 28.-31.08.").
function dateTags(start: string, end: string | null): string[] {
  const [, sm, sd] = start.split('-').map(Number)
  if (!end || end === start) return [`${pad(sd)}.${pad(sm)}.`, `${sd}.${sm}.`]
  const [, em, ed] = end.split('-').map(Number)
  return sm === em
    ? [`${pad(sd)}.-${pad(ed)}.${pad(em)}.`, `${sd}.-${ed}.${em}.`, `${pad(sd)}-${pad(ed)}.${pad(em)}`]
    : [`${pad(sd)}.${pad(sm)}.-${pad(ed)}.${pad(em)}.`, `${sd}.${sm}.-${ed}.${em}.`]
}

async function calendarCandidates(clientId: string, projectId: string, leadDays: number, runDate: string): Promise<Candidate[]> {
  const key = await secret('feedhub_briefs_key')
  if (!key) return []
  const r = await fetch(FEEDHUB_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body: JSON.stringify({ action: 'briefs', project_id: projectId, since_days: 90, limit: 60 }),
    signal: AbortSignal.timeout(30000),
  })
  if (!r.ok) return []
  const briefs = ((await r.json()).briefs ?? []) as Record<string, string | null>[]
  const out: Candidate[] = []

  const { data: drafts } = await sb.from('pmax_asset_group_drafts').select('brief_task_id, asset_group_name, status').eq('client_id', clientId)
  const { data: lastAg } = await sb.from('google_asset_group_metrics').select('report_date').eq('client_id', clientId).order('report_date', { ascending: false }).limit(1)
  const agDate = lastAg?.[0]?.report_date as string | undefined

  for (const b of briefs) {
    if (!b.start_date) continue
    const name = b.headline ?? b.title
    // Starts soon and nothing is prepared in Brain.
    if (b.start_date >= runDate && b.start_date <= addDays(runDate, leadDays)) {
      const has = (drafts ?? []).some((d) => d.brief_task_id === b.task_id && d.status !== 'rejected')
      if (!has) {
        const daysTo = Math.round((Date.parse(b.start_date) - Date.parse(runDate)) / 864e5)
        out.push({
          check_type: 'brief_prep', fingerprint: `brief_prep:${b.task_id}`,
          severity: daysTo <= 1 ? 'visoko' : 'srednje', impact_eur: null,
          evidence: { task_id: b.task_id, task_url: b.task_url, action: name, start_date: b.start_date, end_date: b.end_date,
                      days_to_start: daysTo, discount: b.discount, applies_to: b.applies_to, brain_draft: false },
        })
      }
    }
    // Ended, but an asset group named after it still spends.
    if (b.end_date && agDate && b.end_date < agDate && b.end_date >= addDays(runDate, -14)) {
      const tags = dateTags(b.start_date, b.end_date)
      const draftNames = (drafts ?? []).filter((d) => d.brief_task_id === b.task_id).map((d) => d.asset_group_name)
      const { data: rows } = await sb.from('google_asset_group_metrics')
        .select('campaign, asset_group_name, spend, report_date')
        .eq('client_id', clientId).gt('report_date', b.end_date).gt('spend', 0)
      const hits = new Map<string, { campaign: string; asset_group: string; spend: number; days: Set<string> }>()
      for (const row of rows ?? []) {
        const n = String(row.asset_group_name ?? '')
        if (!tags.some((t) => n.includes(t)) && !draftNames.includes(n)) continue
        const k = `${row.campaign}|${n}`
        const h = hits.get(k) ?? { campaign: row.campaign, asset_group: n, spend: 0, days: new Set<string>() }
        h.spend += Number(row.spend) || 0
        h.days.add(row.report_date)
        hits.set(k, h)
      }
      for (const h of hits.values()) {
        out.push({
          check_type: 'brief_ended', fingerprint: `brief_ended:${b.task_id}:${h.asset_group}`,
          severity: 'visoko', impact_eur: Math.round(h.spend),
          evidence: { task_id: b.task_id, task_url: b.task_url, action: name, start_date: b.start_date, end_date: b.end_date,
                      campaign: h.campaign, asset_group: h.asset_group, spend_after_end: Math.round(h.spend * 100) / 100,
                      days_after_end: h.days.size, data_until: agDate },
        })
      }
    }
  }
  return out
}

// ---- Account limits and monthly campaign budgets (from the daily settings snapshot) ----
async function budgetCandidates(clientId: string): Promise<Candidate[]> {
  const out: Candidate[] = []
  // Meta account spending limit: when it runs out, every campaign on the account stops.
  const { data: lim } = await sb.from('meta_account_limits').select('account_id, account_name, spend_cap, amount_spent, snapshot_date')
    .eq('client_id', clientId).order('snapshot_date', { ascending: false }).limit(5)
  const lastSnap = lim?.[0]?.snapshot_date
  const since = new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10)
  const { data: fb } = await sb.from('facebook_ads_metrics').select('report_date, spend').eq('client_id', clientId).gte('report_date', since)
  const days = new Set((fb ?? []).map((r) => r.report_date)).size || 1
  const avgDaily = (fb ?? []).reduce((n, r) => n + (Number(r.spend) || 0), 0) / days
  for (const a of (lim ?? []).filter((x) => x.snapshot_date === lastSnap)) {
    const cap = Number(a.spend_cap), spent = Number(a.amount_spent)
    if (!cap) continue
    const remaining = Math.max(0, cap - spent)
    const daysLeft = avgDaily > 0 ? Math.floor(remaining / avgDaily) : null
    if (spent / cap < 0.9 && (daysLeft == null || daysLeft >= 7)) continue
    out.push({
      check_type: 'meta_cap', fingerprint: `meta_cap:${a.account_id}:${Math.round(cap)}`,
      severity: daysLeft != null && daysLeft < 3 ? 'hitno' : 'visoko', impact_eur: null,
      evidence: { account: a.account_name ?? a.account_id, spend_cap: Math.round(cap), amount_spent: Math.round(spent),
                  remaining: Math.round(remaining), used_pct: Math.round(spent / cap * 100),
                  avg_daily_spend: Math.round(avgDaily), days_left: daysLeft, snapshot_date: a.snapshot_date },
    })
  }
  // Campaigns off their monthly budget (only where the team entered one in Budžeti).
  const { data: plan } = await sb.rpc('budget_plan', { p_client_id: clientId })
  const off = ((plan ?? []) as Record<string, unknown>[]).filter((r) => r.monthly_budget != null && ['prekoraceno', 'prebrzo', 'presporo'].includes(String(r.status)))
  if (off.length) {
    const items = off.map((r) => ({ network: r.network, campaign: r.campaign, status: r.status, monthly_budget: Math.round(Number(r.monthly_budget)),
      spent_mtd: Math.round(Number(r.spent_mtd)), projected_month: Math.round(Number(r.projected_month)), recommended_daily: r.recommended_daily }))
    out.push({
      check_type: 'campaign_budgets', fingerprint: `campaign_budgets:${String(off[0].data_date)}`,
      severity: off.some((r) => r.status === 'prekoraceno') ? 'visoko' : 'srednje',
      impact_eur: Math.round(items.reduce((n, i) => n + Math.abs(i.projected_month - i.monthly_budget), 0)),
      evidence: { date: off[0].data_date, days_left: off[0].days_left, items },
    })
  }
  return out
}

// ---- Claude: classify search terms, word the other findings ----
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    terms: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          term: { type: 'string' },
          kind: { type: 'string', enum: ['konkurent', 'nebitno', 'relevantno'] },
          action: { type: 'string', enum: ['iskljuci_svuda', 'iskljuci_iz_brend_kampanja', 'zadrzi'] },
          why: { type: 'string', description: 'jedna kratka recenica' },
        },
        required: ['term', 'kind', 'action', 'why'],
        additionalProperties: false,
      },
    },
    placements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          placement: { type: 'string' },
          action: { type: 'string', enum: ['iskljuci', 'zadrzi'] },
          why: { type: 'string', description: 'jedna kratka recenica' },
        },
        required: ['placement', 'action', 'why'],
        additionalProperties: false,
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fingerprint: { type: 'string' },
          keep: { type: 'boolean', description: 'false ako nalaz ocigledno nije problem (npr. planirani kraj flighta)' },
          severity: { type: 'string', enum: ['hitno', 'visoko', 'srednje', 'info'] },
          detail: { type: 'string', description: '2-3 recenice: sta se desilo, verovatan uzrok i zasto je bitno' },
          proposal: { type: 'string', description: 'konkretna akcija u 1-2 recenice' },
        },
        required: ['fingerprint', 'keep', 'severity', 'detail', 'proposal'],
        additionalProperties: false,
      },
    },
  },
  required: ['terms', 'placements', 'findings'],
  additionalProperties: false,
}

const SYSTEM =
  'Ti si iskusan PPC specijalista u agenciji Loft19 i pises jutarnji pregled naloga za kolege. ' +
  'Pišeš na srpskom, latinicom sa svim dijakritičkim znacima (č, ć, š, ž, đ), kratko i konkretno, bez uvoda i bez fraza. ' +
  'Koristi ISKLJUCIVO brojeve iz dokaza (evidence) tog istog nalaza; ne racunaj nove brojeve, ne prenosi brojeve iz drugih nalaza i ne izmisljaj podatke. ' +
  'Svaki broj koji napises automatski se proverava; tekst sa brojem kog nema u dokazu se odbacuje. ' +
  'Datume pisi kao 13.10., iznose kao u dokazu sa oznakom valute klijenta. Ne koristi engleske reci kao baseline; pisi "uobicajeno (prosek istog dana u nedelji)". ' +
  'Nista se ne menja u nalogu automatski; predlog je za coveka koji odobrava.'

function buildPrompt(clientName: string, params: Record<string, unknown>, dataDate: string, stale: boolean, terms: Candidate[], others: Candidate[], placements: Candidate[] = [], feedback: string[] = []) {
  return [
    `Klijent: ${clientName}. Valuta naloga: ${CUR}. Podaci zakljucno sa ${dataDate}.${stale ? ' UPOZORENJE: jutrosnji sync podataka nije uspeo, podaci mogu biti nepotpuni.' : ''}`,
    `Pravila klijenta: konkurenti ${JSON.stringify(params.competitors)}; brendovi koje klijent prodaje ${JSON.stringify(params.brands_sold)}.`,
    ...(feedback.length ? [
      '',
      'KOMENTARI TIMA ZA OVOG KLIJENTA (odluke o ranijim nalazima i zatvoreni taskovi, najnoviji prvi). Primeni ih: ako je tim odbio isti ili slican nalaz i objasnio zasto, stavi keep=false ili to uzmi u obzir u predlogu; pravila iz komentara vaze dok ih novi komentar ne promeni.',
      ...feedback,
    ] : []),
    '',
    'ZADATAK 1, search termini koji su trosili bez konverzije. Za svaki termin odredi:',
    '- kind: konkurent (druga prodavnica ili brend koji klijent ne prodaje), nebitno (nema veze sa ponudom), relevantno (brend koji klijent prodaje ili kategorija iz ponude).',
    '- action: konkurent koji se pojavljuje u brend kampanjama drugih brendova -> iskljuci_iz_brend_kampanja; nebitno -> iskljuci_svuda; relevantno -> zadrzi.',
    '- Ako nisi siguran da li klijent prodaje brend, stavi relevantno i zadrzi, i to reci u why.',
    JSON.stringify(terms.map((t) => t.evidence)),
    '',
    'ZADATAK 3, plasmani (Display, Demand Gen, YouTube) koji su trosili 30 dana bez konverzije. Za svaki odredi action:',
    '- iskljuci: igrice, aplikacije i kanali za decu, alati (VPN, baterija, skeneri, kalkulatori), sadrzaj bez veze sa ponudom klijenta, sumnjivi sajtovi sa neuobicajeno visokim CTR-om (slucajni klikovi).',
    '- zadrzi: relevantni sajtovi i kanali (moda, lifestyle, vesti, publika klijenta) ili kada nisi siguran; to reci u why.',
    placements.length ? JSON.stringify(placements.map((p) => p.evidence)) : '[] (nema plasmana ove nedelje)',
    '',
    'ZADATAK 2, ostali nalazi. Naslov vec postoji (title); za svaki napisi detail i proposal i proceni severity.',
    '- Pacing: poredi sa planom po flightovima (plan_to_date), ne linearno; linear_to_date pomeni samo ako pomaze. Predlog koristi daily_adjustment (iznos dnevno za always-on kampanje) i napomenu o predstojecim flightovima (upcoming_flights). Kad je mode=projection: plan se ne trosi ravnomerno (akcije, nedeljni plan iz media plana); projected_month je procena do kraja meseca po proseku poslednjih 7 dana (last7_daily). Mesecni plan se ne sme preci bez zahteva klijenta; premala potrosnja izdvojenog budzeta za akciju takodje nije prihvatljiva.',
    '- roas_low: ROAS kampanje za poslednjih days dana je ispod minimuma njene grupe (min_roas, cilj target_roas). Kad je roas_source=ga4, ROAS je iz GA4 prihoda (tako tim izvestava klijenta), a roas_platform je ROAS iz platforme; pomeni oba ako se mnogo razlikuju. Svrha grupe je u purpose. Tim menja tROAS za 10-20% i ceka nekoliko dana; PMax se ne dira dok uci (2 nedelje) osim ako su rezultati katastrofalni.',
    '- Grupe kampanja: polje mode u dokazu. mode=upozorenja znaci da tim zeli samo upozorenje, bez predloga izmene budzeta ili podesavanja; tada je proposal provera, ne izmena.',
    '- spend_stopped: vise kampanja je palo na 0. Za svaku stavku pogledaj last_spend_date, days_without_spend, planned_flights_that_day i flights_ended_last_3_days: ako se flight upravo zavrsio, gasenje je verovatno planirano; ako planirani flight jos traje, a kampanja ne trosi vise od jednog dana, to je problem. Reci za koje kampanje je sta. keep=false samo ako su sve planirane.',
    '- spend_anomaly: kampanja je znacajno porasla ili pala; koristi planned_flights_that_day i flights_ended_last_3_days da objasnis.',
    '- Tracking i pad konverzija: proveri da li to moze biti kasnjenje podataka za poslednji dan; predlozi proveru u nalogu pre bilo kakve izmene.',
    '- meta_cap: Meta nalog ima limit potrošnje (spend_cap); kad se dostigne, sve kampanje na nalogu staju. Predlog: povećati limit u Billing podešavanjima ili javiti klijentu.',
    '- campaign_budgets: kampanje odstupaju od mesečnog budžeta koji je tim uneo; predlog koristi recommended_daily (dnevni budžet da se ostatak potroši ravnomerno).',
    '- ads_policy: oglasi sa statusom DISAPPROVED ili APPROVED_LIMITED (topics je razlog). Predlog: u aktivnoj kampanji ispraviti oglas i poslati na review, u staroj kampanji ukloniti oglas; redovno da se izbegne suspenzija naloga.',
    '- recommendations: optimization score naloga i preporuke Google-a. Ne preporucuj slepo prihvatanje: preporuke za broad match i display expansion uglavnom odbaciti, budzetske razmotriti samo ako kampanja gubi prikazivanja zbog budzeta.',
    '- ga4_tracking: u GA4 je porastao udeo saobracaja bez izvora (direct/unassigned) ili je pao broj placenih sesija po kliku; verovatno UTM, gclid ili consent problem. Predlog: proveriti sa tracking timom.',
    '- Kalendar akcija: brief_prep = akcija pocinje uskoro, a u Brain-u nema nacrta; brief_ended = akcija je zavrsena, a asset grupa jos trosi.',
    '- Proizvodi (product_*): brojevi su po proizvodu za trziste feeda (market). product_spend_no_sale = troseno u Google Ads bez kupovine u GA4; product_meta_no_sale = isto za Metu (katalog), predlozi iskljucenje iz product seta; product_no_ads i product_gone_spending racunaju Google Ads i Metu zajedno (google_after, meta_after); predlozi proveru cene, velicina i stranice i izdvajanje custom labelom. product_no_ads = prodaje se bez oglasa; predlozi izdvajanje (bestseller). product_gone_spending = nema na stanju, a oglasi trose; Merchant Center kasni. product_price_drop = posle poskupljenja ili kraja akcije pala prodaja (per_day_before, per_day_after). feed_wave = feed nije preuzet, izgleda pokvareno ili se mnogo promenio. Pomeni 2-3 najveca proizvoda po imenu.',
    '- keep=false samo kad je ocigledno da nalaz nije problem.',
    JSON.stringify(others.map((o) => ({ fingerprint: o.fingerprint, check_type: o.check_type, severity: o.severity, title: titleFor(o), evidence: o.evidence }))),
  ].join('\n')
}

// The team's comments from the last 90 days: on findings (approved, rejected, postponed, done) and on
// closed PPC tasks. The model reads them as the client's rules.
async function teamFeedback(clientId: string): Promise<string[]> {
  const since = new Date(Date.now() - 90 * 864e5).toISOString()
  const [{ data: f }, { data: t }] = await Promise.all([
    sb.from('review_findings').select('check_type, title, status, decision_reason, decided_at')
      .eq('client_id', clientId).not('decision_reason', 'is', null).gte('decided_at', since).order('decided_at', { ascending: false }).limit(40),
    sb.from('ppc_task_reviews').select('task, comment, created_at').eq('client_id', clientId).gte('created_at', since).order('created_at', { ascending: false }).limit(15),
  ])
  return [
    ...(f ?? []).filter((x) => String(x.decision_reason ?? '').trim()).map((x) => `- [${x.check_type}, ${x.status}] "${x.title}": ${String(x.decision_reason).trim()}`),
    ...(t ?? []).map((x) => `- [zatvoren task ${x.task}, ${String(x.created_at).slice(0, 10)}]: ${String(x.comment).trim()}`),
  ]
}

// deno-lint-ignore no-explicit-any
async function askClaude(prompt: string): Promise<{ out: any; model: string }> {
  const resp = await anthropic.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: prompt }],
  // deno-lint-ignore no-explicit-any
  } as any)
  if (resp.stop_reason === 'refusal') throw new Error('Model je odbio zahtev')
  const text = resp.content.find((c: { type: string }) => c.type === 'text') as { text: string } | undefined
  if (!text) throw new Error('Model nije vratio odgovor')
  return { out: JSON.parse(text.text), model: resp.model }
}

const fmt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmt1 = (n: unknown) => Number(n).toLocaleString('sr-RS', { maximumFractionDigits: 1 })
// Accounts report in their own currency (review_settings.params.currency); set per run.
let CUR = 'EUR'
const eur = (n: unknown) => `${fmt(Number(n))} ${CUR}`
const dm = (iso: unknown) => { const v = String(iso ?? ''); return v.length >= 10 ? `${Number(v.slice(8, 10))}.${Number(v.slice(5, 7))}.` : v }
// "AOn (Mkt:RS;Ct:PMax)" -> "AOn RS PMax", "Remarketinga(Mkt:RS;Ct:Conversions;Ph:Bof)" -> "Remarketinga RS Conversions"
const short = (c: unknown) => {
  const v = String(c ?? '')
  const base = v.replace(/\(.*$/, '').replace(/[_\s]+$/, '')
  const ct = v.match(/Ct:([^;)]+)/)?.[1]
  const mkt = v.match(/Mkt:([^;)]+)/)?.[1]
  // The market tells apart same-named campaigns in multi-country accounts (Replay DE/UK/IT).
  return [base, mkt, ct].filter(Boolean).join(' ')
}
const NET: Record<string, string> = { google: 'Google', meta: 'Meta' }
// 1 proizvod, 2-4 proizvoda, 5+ proizvoda (11-14 always proizvoda).
const proizvod = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'proizvod' : 'proizvoda')
// Serbian count agreement: 1 kampanja, 2-4 kampanje, 5+ kampanja (11-14 always kampanja).
// Accusative after "za": 1 kampanju, 2-4 kampanje, 5+ kampanja.
const kampanjuAcc = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? 'kampanju' : kampanja(n))
const kampanja = (n: number) => (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'kampanje' : 'kampanja')

// Titles are built here, from the evidence, so the headline numbers are always right.
// deno-lint-ignore no-explicit-any
function titleFor(c: Candidate): string {
  // deno-lint-ignore no-explicit-any
  const e = c.evidence as any
  switch (c.check_type) {
    case 'pacing':
      if (e.mode === 'projection') return `${NET[e.network]}: procena do kraja meseca ${eur(e.projected_month)} od ${eur(e.plan_month)} plana (${Math.round(e.ratio * 100)}%)`
      return `${NET[e.network]}: potrošeno ${eur(e.spent_to_date)} od ${eur(e.plan_to_date)} planiranih do ${dm(e.data_date)} (${Math.round(e.ratio * 100)}% plana po flightovima)`
    case 'roas_low':
      return `${NET[e.network]} ${short(e.campaign)}: ROAS ${fmt1(e.roas)}${e.roas_source === 'ga4' ? ' (GA4)' : ''} za ${e.days} dana, minimum za ${e.group} je ${fmt1(e.min_roas)}`
    case 'spend_stopped':
      return `${e.items.length} ${kampanja(e.items.length)} bez troška ${dm(e.date)}: ${e.items.slice(0, 3).map((i: { network: string; campaign: string }) => `${NET[i.network]} ${short(i.campaign)}`).join(', ')}${e.items.length > 3 ? ' i druge' : ''}`
    case 'spend_anomaly':
      return `${NET[e.network]} ${short(e.campaign)}: ${eur(e.spend)} ${dm(e.date)} naspram uobičajenih ${eur(e.baseline_same_weekday)} (${e.change_pct > 0 ? '+' : ''}${e.change_pct}%)`
    case 'tracking':
      return `${NET[e.network]}: ${eur(e.spend)} troška i 0 konverzija ${dm(e.date)}`
    case 'conv_drop':
      return `${NET[e.network]} konverzije ${dm(e.date)}: ${fmt1(e.conversions)} naspram uobičajenih ${fmt1(e.baseline_conversions)} (${e.change_pct}%)`
    case 'meta_cap':
      return `Meta limit potrošnje „${e.account}“: iskorišćeno ${e.used_pct}% (${eur(e.amount_spent)} od ${eur(e.spend_cap)})${e.days_left != null ? `, dovoljno za još oko ${e.days_left} dana` : ''}`
    case 'campaign_budgets':
      return `${e.items.length} ${kampanja(e.items.length)} odstupa od mesečnog budžeta: ${e.items.slice(0, 3).map((i: { campaign: string }) => short(i.campaign)).join(', ')}${e.items.length > 3 ? ' i druge' : ''}`
    case 'ads_policy':
      return e.disapproved > 0
        ? `${e.disapproved} ${e.disapproved === 1 ? 'odbijen oglas' : 'odbijenih oglasa'}${e.limited ? ` i ${e.limited} sa ograničenim odobrenjem` : ''}`
        : `${e.limited} ${e.limited === 1 ? 'oglas ima' : 'oglasa imaju'} ograničeno odobrenje (Approved, limited)`
    case 'recommendations':
      return `${e.account_score_pct >= e.target_pct ? `Optimization score naloga je malo ispod cilja od ${e.target_pct}%` : `Optimization score naloga ${e.account_score_pct}% (cilj ${e.target_pct}%)`}${e.budget_recommendations?.length ? `, Google predlaže veći budžet za ${e.budget_recommendations.length} ${kampanjuAcc(e.budget_recommendations.length)}` : ''}`
    case 'ga4_tracking':
      return [
        (e.signals as string[]).includes('unknown_up') ? `GA4: saobraćaj bez izvora ${String(e.unknown_share_pct).replace('.', ',')}% sesija (uobičajeno ${String(e.unknown_share_base_pct).replace('.', ',')}%)` : '',
        (e.signals as string[]).includes('google_paid_gap') ? `google/cpc sesija po kliku ${String(e.google_sessions_per_click).replace('.', ',')} (uobičajeno ${String(e.google_sessions_per_click_base).replace('.', ',')})` : '',
        (e.signals as string[]).includes('meta_paid_gap') ? `Meta paid sesija po kliku ${String(e.meta_sessions_per_click).replace('.', ',')} (uobičajeno ${String(e.meta_sessions_per_click_base).replace('.', ',')})` : '',
      ].filter(Boolean).join('; ')
    case 'brief_prep':
      return `Akcija „${e.action}“ počinje ${dm(e.start_date)}, a u Brain-u nema pripremljene asset grupe`
    case 'brief_ended':
      return `„${e.asset_group}“ troši i posle kraja akcije ${dm(e.end_date)}: ${eur(e.spend_after_end)}`
    case 'product_spend_no_sale':
      return `${e.market}: ${e.count} ${proizvod(e.count)} bez ijedne prodaje, a ${eur(e.total_spend)} troška u Google Ads-u za 14 dana`
    case 'product_meta_no_sale':
      return `${e.market}: ${e.count} ${proizvod(e.count)} bez ijedne prodaje, a ${eur(e.total_spend)} troška na Meti za 14 dana`
    case 'product_no_ads':
      return `${e.market}: ${e.count} ${proizvod(e.count)} sa prodajom (${fmt(e.total_purchases)} kupovina, ${eur(e.total_revenue)}), a skoro bez oglasa`
    case 'product_gone_spending':
      return `${e.market}: ${e.count} ${proizvod(e.count)} van stanja, a oglasi su i dalje trošili (${eur(e.total_spend_after)})`
    case 'product_price_drop':
      return `${e.market}: pad prodaje posle poskupljenja ili kraja akcije (${e.count} ${proizvod(e.count)})`
    case 'feed_wave':
      return e.failed ? `${e.market}: feed nije mogao da se preuzme` : e.suspicious ? `${e.market}: feed izgleda pokvareno (naglo manje proizvoda)`
        : `${e.market}: velika promena u feedu za 24 h (${fmt(e.price_changes)} promena cene, ${fmt(e.removed)} nestalo, ${fmt(e.added)} novih)`
    default:
      return c.check_type
  }
}

// Plain fallbacks when the model's text does not pass the number check.
// deno-lint-ignore no-explicit-any
function fallbackFor(c: Candidate): { detail: string; proposal: string } {
  // deno-lint-ignore no-explicit-any
  const e = c.evidence as any
  switch (c.check_type) {
    case 'spend_stopped':
      return {
        detail: e.items.map((i: Record<string, unknown>) => `${NET[String(i.network)]} ${short(i.campaign)}: poslednji trošak ${i.last_spend_date ? dm(i.last_spend_date) : 'nepoznat'}`).join('; ') + '.',
        proposal: 'Proveriti u nalogu status, budžet i plaćanje za ove kampanje; za one čiji je flight završen, gašenje je očekivano.',
      }
    case 'meta_cap':
      return { detail: `Preostalo ${eur(e.remaining)} uz prosečnu potrošnju od ${eur(e.avg_daily_spend)} dnevno.`, proposal: 'Povećati limit potrošnje naloga u Meta Billing podešavanjima ili dogovoriti sa klijentom.' }
    case 'campaign_budgets':
      return { detail: e.items.map((i: Record<string, unknown>) => `${short(i.campaign)}: projekcija ${eur(i.projected_month)} za budžet ${eur(i.monthly_budget)}`).join('; ') + '.', proposal: 'Podesiti dnevne budžete prema predlogu na stranici Budžeti (Editor CSV).' }
    case 'ads_policy':
      return { detail: 'Lista oglasa i razloga je ispod.', proposal: 'U aktivnim kampanjama ispraviti oglase i poslati na review; u starim kampanjama ukloniti odbijene oglase.' }
    case 'recommendations':
      return { detail: 'Preporuke po kampanjama su ispod.', proposal: 'Proći preporuke u Google Ads-u: prihvatiti korisne, odbaciti broad match i display expansion.' }
    case 'product_spend_no_sale':
      return { detail: 'Lista proizvoda sa troškom, klikovima i pregledima je ispod (GA4 kupovine i Google Ads konverzije su 0).', proposal: 'Proveriti cenu, veličine i stranicu proizvoda; proizvode bez šanse izdvojiti custom labelom i isključiti ili im smanjiti ciljani ROAS.' }
    case 'product_meta_no_sale':
      return { detail: 'Lista proizvoda sa Meta troškom i klikovima je ispod (GA4 kupovine i Meta kupovine su 0).', proposal: 'Isključiti ih iz kataloških setova (product set) ili im smanjiti udeo; proveriti cenu, veličine i stranicu proizvoda.' }
    case 'product_no_ads':
      return { detail: 'Lista proizvoda sa kupovinama i prihodom iz GA4 je ispod.', proposal: 'Izdvojiti ih custom labelom (npr. bestseller) u posebnu asset grupu ili Shopping grupu sa većim budžetom.' }
    case 'product_gone_spending':
      return { detail: 'Proizvodi su nestali iz feeda, a Google Ads je posle toga trošio na njih.', proposal: 'Proveriti Merchant Center (dostupnost se ažurira sa kašnjenjem) i da li je nestanak sa stanja privremen.' }
    case 'product_price_drop':
      return { detail: 'Prosečne dnevne kupovine pre i posle promene cene su ispod.', proposal: 'Proveriti sa klijentom da li je promena cene namerna; razmotriti vraćanje akcije ili manji budžet za te proizvode.' }
    case 'feed_wave':
      return { detail: e.error ? String(e.error) : 'Zbir promena iz provera feeda u poslednja 24 sata.', proposal: 'Proveriti feed i Merchant Center pre nego što promene stignu u kampanje.' }
    case 'ga4_tracking':
      return { detail: 'Poređenje poslednjih 7 dana sa prethodne 4 nedelje.', proposal: 'Proveriti UTM parametre, auto-tagging (gclid) i consent podešavanja sa tracking timom.' }
    case 'pacing':
      if (e.mode === 'projection') return { detail: `Potrošeno ${eur(e.spent_to_date)}, poslednjih 7 dana prosečno ${eur(e.last7_daily)} dnevno; ostalo je ${e.remaining_days} dana.`, proposal: `Proveriti sa nedeljnim planom iz media plana; ako odstupanje nije planirano, dnevni budžet pomeriti za ${eur(e.daily_adjustment)}.` }
      return { detail: `Plan za mesec je ${eur(e.plan_month)}; ostalo je ${e.remaining_days} dana.`, proposal: `Dnevni budžet always-on kampanja pomeriti za ${eur(e.daily_adjustment)}.` }
    case 'roas_low':
      return { detail: `Trošak ${eur(e.spend)}, prihod u GA4 ${eur(e.revenue_ga4)}, prihod na platformi ${eur(e.revenue_platform)} (ROAS ${fmt1(e.roas_platform)}).`, proposal: e.mode === 'upozorenja' ? 'Samo upozorenje: proveriti uzrok pre bilo kakve izmene.' : 'Proveriti ciljanje, kreative i landing stranu; ako nije akcija u toku, smanjiti budžet ili tROAS cilj u koracima od 10–20%.' }
    default:
      return { detail: '', proposal: 'Proveriti u nalogu pre bilo kakve izmene.' }
  }
}

function evidenceNumbers(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v)
  else if (typeof v === 'string') for (const m of v.match(/\d+(?:\.\d+)?/g) ?? []) out.push(Number(m))
  else if (Array.isArray(v)) v.forEach((x) => evidenceNumbers(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => evidenceNumbers(x, out))
  return out
}

// Every number in the model's text must come from this finding's own evidence.
function numbersOk(text: string, nums: number[]): boolean {
  for (const raw of text.match(/\d[\d.,]*/g) ?? []) {
    const t = raw.replace(/[.,]+$/, '')
    if (/^\d{1,2}\.\d{1,2}$/.test(t) && Number(t.split('.')[1]) <= 12) continue // a date like 13.10
    const options = [Number(t.replace(/\./g, '').replace(',', '.')), Number(t.replace(/,/g, ''))].filter((x) => Number.isFinite(x))
    if (options.some((x) => Number.isInteger(x) && x <= 10)) continue // counts like "2 dana"
    const ok = options.some((x) => nums.some((n) => Math.abs(Math.abs(n) - x) <= Math.max(0.6, Math.abs(n) * 0.005)))
    if (!ok) return false
  }
  return true
}

// Several campaigns dropping to zero on the same day usually share one cause: one finding.
function groupStopped(cands: Candidate[]): Candidate[] {
  const stopped = cands.filter((c) => c.check_type === 'spend_anomaly' && Number(c.evidence.spend) === 0)
  if (stopped.length < 2) return cands
  const rest = cands.filter((c) => !stopped.includes(c))
  const items = stopped.map((c) => ({ fingerprint: c.fingerprint, ...c.evidence }))
  return [...rest, {
    check_type: 'spend_stopped',
    fingerprint: `stopped:${String(stopped[0].evidence.date)}`,
    severity: 'visoko',
    impact_eur: stopped.reduce((n, c) => n + (c.impact_eur ?? 0), 0),
    evidence: { date: stopped[0].evidence.date, items },
  }]
}

// "1 konkurentski termin je potrošio", "3 konkurentska termina su potrošila", "7 konkurentskih termina je potrošilo".
function termCount(n: number, action: string): string {
  const adj: Record<string, [string, string, string]> = {
    iskljuci_iz_brend_kampanja: ['konkurentski', 'konkurentska', 'konkurentskih'],
    iskljuci_svuda: ['nebitan', 'nebitna', 'nebitnih'],
    zadrzi: ['relevantan', 'relevantna', 'relevantnih'],
  }
  const [one, few, many] = adj[action] ?? adj.zadrzi
  if (n % 10 === 1 && n % 100 !== 11) return `${n} ${one} termin je potrošio`
  if (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return `${n} ${few} termina su potrošila`
  return `${n} ${many} termina je potrošilo`
}

// Placements to exclude are one finding (one approval = one exclusion list); the rest is info.
function placementFindings(pls: Candidate[], classes: { placement: string; action: string; why: string }[]): Finding[] {
  const by = new Map(classes.map((c) => [c.placement, c]))
  const groups: Record<string, { items: Record<string, unknown>[]; spend: number }> = {}
  for (const p of pls) {
    const e = p.evidence as Record<string, unknown>
    const c = by.get(String(e.placement)) ?? { action: 'zadrzi', why: 'nije klasifikovano' }
    const g = (groups[c.action] ??= { items: [], spend: 0 })
    g.items.push({ ...e, action: c.action, why: c.why })
    g.spend += Number(e.spend) || 0
  }
  const out: Finding[] = []
  for (const [action, g] of Object.entries(groups)) {
    g.items.sort((a, b) => Number(b.spend) - Number(a.spend))
    const n = g.items.length
    const top = g.items.slice(0, 3).map((i) => `${i.name ?? i.placement} (${fmt1(i.spend)} ${CUR})`).join(', ')
    out.push({
      check_type: 'placements',
      fingerprint: `pl_group:${action}:${String(g.items[0].snapshot_date ?? '')}`,
      severity: action === 'iskljuci' ? 'srednje' : 'info',
      impact_eur: Math.round(g.spend),
      title: action === 'iskljuci'
        ? `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'plasman za isključivanje je potrošio' : 'plasmana za isključivanje potrošilo je'} ${fmt(g.spend)} ${CUR} za 30 dana bez konverzije`
        : `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'plasman bez konverzije ostaje' : 'plasmana bez konverzije ostaje'} (${fmt(g.spend)} ${CUR}), relevantni su`,
      detail: `Najveći: ${top}.`,
      proposal: action === 'iskljuci'
        ? 'Dodati ih kao isključene plasmane (na nivou naloga ili kampanja u kojima su se pojavili); lista se preuzima kao CSV posle odobrenja.'
        : 'Ne isključivati; pratiti još nedelju dana.',
      evidence: { action, period: g.items[0].period, items: g.items },
    })
  }
  return out
}

// Search terms are grouped per proposed action, so one approval covers one negative list.
function termFindings(terms: Candidate[], classes: { term: string; kind: string; action: string; why: string }[]): Finding[] {
  const byTerm = new Map(classes.map((c) => [c.term.toLowerCase(), c]))
  const groups: Record<string, { items: Record<string, unknown>[]; spend: number }> = {}
  for (const t of terms) {
    const e = t.evidence as Record<string, unknown>
    const c = byTerm.get(String(e.term)) ?? { kind: 'relevantno', action: 'zadrzi', why: 'nije klasifikovano' }
    const g = (groups[c.action] ??= { items: [], spend: 0 })
    g.items.push({ ...e, kind: c.kind, why: c.why })
    g.spend += Number(e.spend) || 0
  }
  const out: Finding[] = []
  const days = (terms[0]?.evidence as Record<string, unknown> | undefined)?.days ?? 30
  const label: Record<string, [string, string, string]> = {
    iskljuci_iz_brend_kampanja: ['visoko', 'konkurentskih termina', 'Dodaj ih kao negativne (exact) u brend kampanje u kojima su se pojavili.'],
    iskljuci_svuda: ['srednje', 'nebitnih termina', 'Dodaj ih kao negativne (exact) na nivou kampanja u kojima su se pojavili.'],
    zadrzi: ['info', 'relevantnih termina', 'Ne isključivati; proveriti ponudu, landing stranu i cenu za ove upite.'],
  }
  for (const [action, g] of Object.entries(groups)) {
    const [severity, , proposal] = label[action] ?? label.zadrzi
    g.items.sort((a, b) => Number(b.spend) - Number(a.spend))
    const top = g.items.slice(0, 4).map((i) => `${i.term} (${fmt1(i.spend)} ${CUR})`).join(', ')
    out.push({
      check_type: 'search_terms',
      fingerprint: `st_group:${action}`,
      severity,
      impact_eur: Math.round(g.spend),
      title: `${termCount(g.items.length, action)} ${fmt(g.spend)} ${CUR} za ${days} dana bez ijedne konverzije`,
      detail: `Najveći: ${top}.${action === 'iskljuci_iz_brend_kampanja' ? ' Konkurentski upiti se prikazuju u brend kampanjama drugih brendova, što liči na široko podudaranje.' : ''}`,
      proposal,
      evidence: { action, days, terms: g.items },
    })
  }
  return out
}

// Checks that run once a week; their findings stay open all week.
const WEEKLY_TYPES = ['ads_policy', 'recommendations', 'placements', 'ga4_tracking']
// Product and feed findings (clients with a product feed) come on top of the daily cap.
const PRODUCT_TYPES = ['product_spend_no_sale', 'product_meta_no_sale', 'product_no_ads', 'product_gone_spending', 'product_price_drop', 'feed_wave']

// The campaign group a campaign belongs to (review_settings.params.campaign_groups, first match wins).
// mode: predlozi (findings and ready changes) | upozorenja (findings only) | ne_dirati (left out).
type Group = { name: string | null; mode: string; network?: string; pattern?: string }
function campaignGroup(params: Record<string, unknown>, network: string, campaign: string): Group {
  for (const g of (params.campaign_groups ?? []) as Group[]) {
    if (g.network && g.network !== network) continue
    try { if (g.pattern && new RegExp(g.pattern).test(campaign)) return g } catch { /* a bad pattern never matches */ }
  }
  return { name: null, mode: 'predlozi' }
}
const reEscape = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const ACTIVE_CHANGE = ['predlog', 'odobreno', 'izvezeno', 'poslato']

// Ready changes that follow the team's rules, after the review:
// - competitors are never targeted: the competitor's name becomes one phrase negative in every campaign where a
//   search term with it showed up in the last 30 days (whole words only, brands the client sells excluded);
// - a whole-term negative is no longer needed once the competitor's name is a phrase negative in that campaign;
// - campaigns whose group is "samo upozorenja" or "ne dirati" get no ready changes.
// The heavy part is one LIKE query (competitor_search_terms); matching and grouping happen here.
async function teamRuleChanges(clientId: string, params: Record<string, unknown>) {
  const sold = new Set(((params.brands_sold ?? []) as string[]).map((b) => b.toLowerCase()))
  const comps = [...new Set(((params.competitors ?? []) as string[]).map((c) => c.toLowerCase().trim()).filter((c) => c && !sold.has(c)))]
  const wordRe = (w: string) => new RegExp(`(^|[^a-z0-9])${reEscape(w)}($|[^a-z0-9])`)
  let added = 0
  if (comps.length) {
    // The API returns at most 1000 rows per call; the function's result is ordered, so it is read in pages.
    const rows: { campaign: string; term: string; spend: number; clicks: number }[] = []
    for (let from = 0; from < 50000; from += 1000) {
      const { data, error } = await sb.rpc('competitor_search_terms', { p_client_id: clientId, p_names: comps, p_days: 30 }).range(from, from + 999)
      if (error) throw error
      rows.push(...((data ?? []) as typeof rows))
      if ((data ?? []).length < 1000) break
    }
    const res = comps.map((c) => [c, wordRe(c)] as const)
    const agg = new Map<string, { campaign: string; competitor: string; spend: number; clicks: number; terms: { term: string; spend: number }[] }>()
    for (const r of rows) {
      if (campaignGroup(params, 'google', r.campaign).mode !== 'predlozi') continue
      for (const [c, re] of res) {
        if (!re.test(r.term)) continue
        const k = `${r.campaign}|${c}`
        const a = agg.get(k) ?? { campaign: r.campaign, competitor: c, spend: 0, clicks: 0, terms: [] }
        a.spend += Number(r.spend) || 0
        a.clicks += Number(r.clicks) || 0
        a.terms.push({ term: r.term, spend: Number(r.spend) || 0 })
        agg.set(k, a)
      }
    }
    const { data: existing } = await sb.from('ppc_changes').select('id, fingerprint, status, decided_at, match_type').eq('client_id', clientId).eq('kind', 'negative_keyword')
    const byFp = new Map((existing ?? []).map((e) => [e.fingerprint, e]))
    const blocked = new Set((existing ?? []).filter((e) => ACTIVE_CHANGE.includes(e.status) || (e.status === 'odbijeno' && Date.parse(e.decided_at ?? '') > Date.now() - 90 * 864e5)).map((e) => e.fingerprint))
    const proposals = [...agg.values()].map((a) => {
      const top = a.terms.sort((x, y) => y.spend - x.spend)
      return {
        client_id: clientId, task: 'search_terms', kind: 'negative_keyword', network: 'google', campaign: a.campaign,
        target: a.competitor, match_type: 'Phrase',
        reason: `Konkurent „${a.competitor}“: tim ne gađa konkurente · ${top.length} termina, potrošeno ${a.spend.toFixed(2)} za 30 dana, ${a.clicks} klikova`,
        details: { spend: Math.round(a.spend * 100) / 100, clicks: a.clicks, terms: top.slice(0, 5).map((t) => t.term), kind: 'konkurent', source: 'lista_konkurenata' },
        fingerprint: `neg:${a.campaign}:${a.competitor}`,
      }
    })
    // A search term equal to the competitor's name may already be proposed as an exact negative (same fingerprint):
    // while it is only proposed, it becomes the phrase negative.
    for (const r of proposals) {
      const e = byFp.get(r.fingerprint)
      if (e && e.status === 'predlog' && e.match_type !== 'Phrase') {
        await sb.from('ppc_changes').update({ match_type: 'Phrase', reason: r.reason, details: r.details }).eq('id', e.id)
        added++
      }
    }
    const fresh = proposals.filter((r) => !blocked.has(r.fingerprint))
    for (let i = 0; i < fresh.length; i += 200) {
      const { error: insErr } = await sb.from('ppc_changes').insert(fresh.slice(i, i + 200))
      if (insErr) throw insErr
    }
    added += fresh.length
  }
  // Clean up what is still only proposed.
  const { data: open } = await sb.from('ppc_changes').select('id, kind, campaign, network, target, status, details').eq('client_id', clientId).in('status', ACTIVE_CHANGE)
  const compNeg = (open ?? []).filter((c) => c.kind === 'negative_keyword' && (c.details as { source?: string })?.source === 'lista_konkurenata')
  const replaced: string[] = []
  const warnOnly: string[] = []
  for (const c of (open ?? []).filter((x) => x.status === 'predlog')) {
    if (c.campaign && campaignGroup(params, c.network, c.campaign).mode !== 'predlozi') { warnOnly.push(c.id); continue }
    if (c.kind === 'negative_keyword' && (c.details as { source?: string })?.source !== 'lista_konkurenata'
        && compNeg.some((p) => p.campaign === c.campaign && wordRe(String(p.target).toLowerCase()).test(String(c.target).toLowerCase()))) replaced.push(c.id)
  }
  const now = new Date().toISOString()
  if (replaced.length) await sb.from('ppc_changes').update({ status: 'odbijeno', decided_at: now, comment: 'Automatski: zamenjeno negativnom rečju konkurenta (phrase) u istoj kampanji.' }).in('id', replaced)
  if (warnOnly.length) await sb.from('ppc_changes').update({ status: 'odbijeno', decided_at: now, comment: 'Automatski: grupa kampanja je „samo upozorenja“ ili „ne dirati“, bez gotovih izmena.' }).in('id', warnOnly)
  return { added, replaced: replaced.length, warn_only: warnOnly.length }
}

async function reviewClient(clientId: string, clientName: string, params: Record<string, unknown>, forceWeekly = false) {
  const runDate = today()
  const weekly = forceWeekly || new Date(runDate + 'T00:00:00Z').getUTCDay() === Number(params.weekly_weekday ?? 1)
  CUR = String(params.currency ?? 'EUR')
  const { data: run, error: runErr } = await sb.from('review_runs')
    .upsert({ client_id: clientId, run_date: runDate, status: 'running', started_at: new Date().toISOString(), error: null }, { onConflict: 'client_id,run_date' })
    .select('id').single()
  if (runErr) throw runErr

  try {
    // Yesterday's open daily findings are superseded by today's run; weekly ones by next week's.
    const typeList = `(${WEEKLY_TYPES.join(',')})`
    await sb.from('review_findings').update({ status: 'isteklo' }).eq('client_id', clientId).eq('status', 'novo')
      .lt('run_date', runDate).not('check_type', 'in', typeList)
    await sb.from('review_findings').update({ status: 'isteklo' }).eq('client_id', clientId).eq('status', 'novo')
      .lt('run_date', addDays(runDate, -6)).in('check_type', WEEKLY_TYPES)
    // A rerun today replaces today's undecided findings (the weekly ones only when the weekly check reruns).
    let clear = sb.from('review_findings').delete().eq('run_id', run.id).eq('status', 'novo')
    if (!weekly) clear = clear.not('check_type', 'in', typeList)
    await clear

    const { data: cands, error } = await sb.rpc('review_candidates', { p_client_id: clientId })
    if (error) throw error
    let candidates = (cands ?? []) as Candidate[]
    // Meta-only and Google-only clients both exist: use whichever networks the client has.
    const latest = async (table: string) => {
      const { data } = await sb.from(table).select('report_date').eq('client_id', clientId).order('report_date', { ascending: false }).limit(1)
      return data?.[0]?.report_date as string | undefined
    }
    const days = (await Promise.all([latest('google_ads_metrics'), latest('facebook_ads_metrics')])).filter(Boolean) as string[]
    const dataDate = days.sort().at(-1) ?? ''
    // Data freshness: if this morning's sync did not land, day-level checks would be false alarms.
    // last_synced_at is set by every successful sync, even for an account with no spend.
    const { data: srcs } = await sb.from('data_sources').select('last_synced_at').eq('client_id', clientId).in('provider', ['google_ads', 'facebook'])
    const loads = (srcs ?? []).map((x) => String(x.last_synced_at ?? '')).sort()
    const lastLoad = loads.length ? loads[0] || undefined : undefined
    // The queue says whether today's main Google/Meta pulls actually finished for this client.
    const { data: jobs } = await sb.from('sync_queue').select('status').eq('run_date', runDate)
      .in('fn', ['google-ads-sync', 'facebook-ads-sync']).eq('body->>client_id', clientId)
    const unfinished = (jobs ?? []).some((j) => j.status !== 'done')
    const stale = !lastLoad || lastLoad.slice(0, 10) < runDate || unfinished
    if (stale) candidates = candidates.filter((c) => !['spend_anomaly', 'tracking', 'conv_drop'].includes(c.check_type))

    // Accounts that normally see under one conversion a day: a day with zero is not news.
    // A drop must also show on the day before: the last day's conversions keep arriving for days.
    candidates = candidates.filter((c) => {
      const e = c.evidence as Record<string, number | null>
      if (c.check_type === 'tracking') return Number(e.baseline_conversions ?? 0) >= 1
      if (c.check_type === 'conv_drop') {
        const base = Number(e.baseline_conversions ?? 0)
        return e.conversions_day_before == null || Number(e.conversions_day_before) < base * (1 - Number(params.conv_drop ?? 0.4) / 2)
      }
      return true
    })
    candidates.push(...await budgetCandidates(clientId))
    const { data: pc, error: pe } = await sb.rpc('product_candidates', { p_client_id: clientId })
    if (pe) throw pe
    candidates.push(...((pc ?? []) as Candidate[]))
    if (weekly) {
      const { data: wc, error: we } = await sb.rpc('weekly_candidates', { p_client_id: clientId })
      if (we) throw we
      candidates.push(...((wc ?? []) as Candidate[]))
    }
    if (params.productive_project_id) {
      candidates.push(...await calendarCandidates(clientId, String(params.productive_project_id), Number(params.brief_lead_days ?? 3), runDate))
    }

    // Skip what the team already decided within the cooldown.
    const since = new Date(Date.now() - Number(params.cooldown_days ?? 14) * 864e5).toISOString()
    const { data: decided } = await sb.from('review_findings').select('fingerprint, check_type, evidence, status')
      .eq('client_id', clientId).in('status', ['odobreno', 'odbijeno', 'odlozeno', 'izvrseno']).gte('decided_at', since)
    const decidedFp = new Set((decided ?? []).map((d) => d.fingerprint))
    const decidedTerms = new Set((decided ?? []).filter((d) => d.check_type === 'search_terms')
      .flatMap((d) => ((d.evidence as { terms?: { term: string }[] }).terms ?? []).map((t) => t.term)))
    for (const d of decided ?? []) {
      if (d.check_type === 'spend_stopped') for (const i of ((d.evidence as { items?: { fingerprint: string }[] }).items ?? [])) decidedFp.add(i.fingerprint)
    }
    const decidedPlacements = new Set((decided ?? []).filter((d) => d.check_type === 'placements')
      .flatMap((d) => ((d.evidence as { items?: { placement: string }[] }).items ?? []).map((i) => i.placement)))
    candidates = candidates.filter((c) => c.check_type === 'search_term' ? !decidedTerms.has(String(c.evidence.term))
      : c.check_type === 'placement' ? !decidedPlacements.has(String(c.evidence.placement))
      : !decidedFp.has(c.fingerprint))
    candidates = groupStopped(candidates)
    for (const c of candidates) {
      if (c.check_type === 'pacing') c.evidence.daily_adjustment = Math.round(-Number(c.evidence.gap) / Math.max(1, Number(c.evidence.remaining_days)))
    }

    // Big accounts can have hundreds of wasted terms; the biggest 80 keep one call fast and readable.
    const terms = candidates.filter((c) => c.check_type === 'search_term')
      .sort((a, b) => Number(b.evidence.spend) - Number(a.evidence.spend)).slice(0, 80)
    const placements = candidates.filter((c) => c.check_type === 'placement')
      .sort((a, b) => Number(b.evidence.spend) - Number(a.evidence.spend)).slice(0, 80)
    const others = candidates.filter((c) => c.check_type !== 'search_term' && c.check_type !== 'placement')
    let findings: Finding[] = []
    let model = ''
    if (stale) {
      findings.push({
        check_type: 'data', fingerprint: `data_stale:${runDate}`, severity: 'hitno', impact_eur: null,
        title: 'Jutarnji sync podataka nije stigao; dnevne provere su preskočene',
        detail: `Najstariji poslednji sync (Google/Meta nalozi): ${lastLoad ?? 'nepoznato'}. Bez svežih podataka provere troška i konverzija bi davale lažne alarme.`,
        proposal: 'Proveriti sync u Brain-u (sync_queue) i ponovo pokrenuti pregled kad podaci stignu.',
        evidence: { last_load: lastLoad ?? null },
      })
    }
    if (terms.length || others.length || placements.length) {
      const { out, model: m } = await askClaude(buildPrompt(clientName, params, dataDate, stale, terms, others, placements, await teamFeedback(clientId)))
      model = m
      const worded = new Map((out.findings ?? []).map((f: Record<string, unknown>) => [f.fingerprint, f]))
      for (const c of others) {
        const w = worded.get(c.fingerprint) as Record<string, unknown> | undefined
        if (w && w.keep === false) continue
        const nums = evidenceNumbers(c.evidence)
        const fb = fallbackFor(c)
        const detail = typeof w?.detail === 'string' && numbersOk(w.detail, nums) ? w.detail : fb.detail
        const proposal = typeof w?.proposal === 'string' && numbersOk(w.proposal, nums) ? w.proposal : fb.proposal
        findings.push({
          ...c,
          severity: (w?.severity as string) ?? c.severity,
          title: titleFor(c),
          detail,
          proposal,
          evidence: { ...c.evidence, text_checked: detail === w?.detail && proposal === w?.proposal },
        })
      }
      if (terms.length) findings.push(...termFindings(terms, out.terms ?? []))
      if (placements.length) findings.push(...placementFindings(placements, out.placements ?? []))
    }

    findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || ((b.impact_eur ?? 0) - (a.impact_eur ?? 0)))
    // The daily cap keeps the morning list short; the weekly checks come on top, once a week.
    const daily = findings.filter((f) => !WEEKLY_TYPES.includes(f.check_type) && !PRODUCT_TYPES.includes(f.check_type)).slice(0, Number(params.max_findings ?? 7))
    findings = [...daily, ...findings.filter((f) => PRODUCT_TYPES.includes(f.check_type)), ...findings.filter((f) => WEEKLY_TYPES.includes(f.check_type))]

    if (findings.length) {
      const { error: insErr } = await sb.from('review_findings').insert(findings.map((f, i) => ({
        run_id: run.id, client_id: clientId, run_date: runDate, check_type: f.check_type, fingerprint: f.fingerprint,
        severity: f.severity, impact_eur: f.impact_eur, title: f.title, detail: f.detail, proposal: f.proposal,
        evidence: f.evidence, rank: i + 1,
      })))
      if (insErr) throw insErr
    }
    // The team's rules for ready changes; a failure here never fails the review itself.
    let rules: unknown = null
    if (params.competitors || params.campaign_groups) {
      try { rules = await teamRuleChanges(clientId, params) } catch (e) { rules = { error: (e as Error).message } }
    }
    await sb.from('review_runs').update({
      status: 'done', finished_at: new Date().toISOString(), data_date: dataDate || null,
      candidates: candidates.length, findings: findings.length, model: model || null,
    }).eq('id', run.id)
    return { client: clientName, candidates: candidates.length, findings: findings.length, stale, weekly, rules }
  } catch (e) {
    await sb.from('review_runs').update({ status: 'failed', error: (e as Error).message, finished_at: new Date().toISOString() }).eq('id', run.id)
    throw e
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    // Cron sends the internal key; the "Pokreni ponovo" button sends an agency user's session.
    const internal = req.headers.get('x-internal-key')
    if (internal) {
      if (internal !== await secret('review_cron_key')) return json({ error: 'Pogrešan interni ključ' }, 403)
    } else {
      const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
      const { data: u, error: ue } = await sb.auth.getUser(jwt)
      if (ue || !u?.user) return json({ error: 'Niste ulogovani' }, 401)
      const { data: au } = await sb.from('app_users').select('agency_id, client_id').eq('id', u.user.id).maybeSingle()
      if (!au?.agency_id || au.client_id) return json({ error: 'Samo korisnici agencije' }, 403)
    }
    const body = await req.json().catch(() => ({}))
    let q = sb.from('review_settings').select('client_id, params, clients(name)').eq('enabled', true)
    if (body.client_id) q = q.eq('client_id', body.client_id)
    const { data: settings, error } = await q
    if (error) throw error
    const results = []
    for (const s of settings ?? []) {
      try {
        results.push(await reviewClient(s.client_id, (s.clients as unknown as { name: string })?.name ?? '', s.params as Record<string, unknown>, body.weekly === true))
      } catch (e) {
        results.push({ client_id: s.client_id, error: (e as Error).message })
      }
    }
    return json({ ok: true, results })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
