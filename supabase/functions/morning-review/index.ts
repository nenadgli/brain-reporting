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
  required: ['terms', 'findings'],
  additionalProperties: false,
}

const SYSTEM =
  'Ti si iskusan PPC specijalista u agenciji Loft19 i pises jutarnji pregled naloga za kolege. ' +
  'Pišeš na srpskom, latinicom sa svim dijakritičkim znacima (č, ć, š, ž, đ), kratko i konkretno, bez uvoda i bez fraza. ' +
  'Koristi ISKLJUCIVO brojeve iz dokaza (evidence) tog istog nalaza; ne racunaj nove brojeve, ne prenosi brojeve iz drugih nalaza i ne izmisljaj podatke. ' +
  'Svaki broj koji napises automatski se proverava; tekst sa brojem kog nema u dokazu se odbacuje. ' +
  'Datume pisi kao 13.10., iznose kao u dokazu sa oznakom EUR. Ne koristi engleske reci kao baseline; pisi "uobicajeno (prosek istog dana u nedelji)". ' +
  'Nista se ne menja u nalogu automatski; predlog je za coveka koji odobrava.'

function buildPrompt(clientName: string, params: Record<string, unknown>, dataDate: string, stale: boolean, terms: Candidate[], others: Candidate[]) {
  return [
    `Klijent: ${clientName}. Podaci zakljucno sa ${dataDate}.${stale ? ' UPOZORENJE: jutrosnji sync podataka nije uspeo, podaci mogu biti nepotpuni.' : ''}`,
    `Pravila klijenta: konkurenti ${JSON.stringify(params.competitors)}; brendovi koje klijent prodaje ${JSON.stringify(params.brands_sold)}.`,
    '',
    'ZADATAK 1, search termini koji su trosili bez konverzije. Za svaki termin odredi:',
    '- kind: konkurent (druga prodavnica ili brend koji klijent ne prodaje), nebitno (nema veze sa ponudom), relevantno (brend koji klijent prodaje ili kategorija iz ponude).',
    '- action: konkurent koji se pojavljuje u brend kampanjama drugih brendova -> iskljuci_iz_brend_kampanja; nebitno -> iskljuci_svuda; relevantno -> zadrzi.',
    '- Ako nisi siguran da li klijent prodaje brend, stavi relevantno i zadrzi, i to reci u why.',
    JSON.stringify(terms.map((t) => t.evidence)),
    '',
    'ZADATAK 2, ostali nalazi. Naslov vec postoji (title); za svaki napisi detail i proposal i proceni severity.',
    '- Pacing: poredi sa planom po flightovima (plan_to_date), ne linearno; linear_to_date pomeni samo ako pomaze. Predlog koristi daily_adjustment (EUR dnevno za always-on kampanje) i napomenu o predstojecim flightovima (upcoming_flights).',
    '- spend_stopped: vise kampanja je palo na 0. Za svaku stavku pogledaj last_spend_date, days_without_spend, planned_flights_that_day i flights_ended_last_3_days: ako se flight upravo zavrsio, gasenje je verovatno planirano; ako planirani flight jos traje, a kampanja ne trosi vise od jednog dana, to je problem. Reci za koje kampanje je sta. keep=false samo ako su sve planirane.',
    '- spend_anomaly: kampanja je znacajno porasla ili pala; koristi planned_flights_that_day i flights_ended_last_3_days da objasnis.',
    '- Tracking i pad konverzija: proveri da li to moze biti kasnjenje podataka za poslednji dan; predlozi proveru u nalogu pre bilo kakve izmene.',
    '- Kalendar akcija: brief_prep = akcija pocinje uskoro, a u Brain-u nema nacrta; brief_ended = akcija je zavrsena, a asset grupa jos trosi.',
    '- keep=false samo kad je ocigledno da nalaz nije problem.',
    JSON.stringify(others.map((o) => ({ fingerprint: o.fingerprint, check_type: o.check_type, severity: o.severity, title: titleFor(o), evidence: o.evidence }))),
  ].join('\n')
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
const eur = (n: unknown) => `${fmt(Number(n))} EUR`
const dm = (iso: unknown) => { const v = String(iso ?? ''); return v.length >= 10 ? `${Number(v.slice(8, 10))}.${Number(v.slice(5, 7))}.` : v }
// "AOn (Mkt:RS;Ct:PMax)" -> "AOn PMax", "Remarketinga(Mkt:RS;Ct:Conversions;Ph:Bof)" -> "Remarketinga Conversions"
const short = (c: unknown) => {
  const v = String(c ?? '')
  const base = v.replace(/\(.*$/, '').replace(/[_\s]+$/, '')
  const ct = v.match(/Ct:([^;)]+)/)?.[1]
  return ct ? `${base} ${ct}` : base
}
const NET: Record<string, string> = { google: 'Google', meta: 'Meta' }
// Serbian count agreement: 1 kampanja, 2-4 kampanje, 5+ kampanja (11-14 always kampanja).
const kampanja = (n: number) => (n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'kampanje' : 'kampanja')

// Titles are built here, from the evidence, so the headline numbers are always right.
// deno-lint-ignore no-explicit-any
function titleFor(c: Candidate): string {
  // deno-lint-ignore no-explicit-any
  const e = c.evidence as any
  switch (c.check_type) {
    case 'pacing':
      return `${NET[e.network]}: potrošeno ${eur(e.spent_to_date)} od ${eur(e.plan_to_date)} planiranih do ${dm(e.data_date)} (${Math.round(e.ratio * 100)}% plana po flightovima)`
    case 'spend_stopped':
      return `${e.items.length} ${kampanja(e.items.length)} bez troška ${dm(e.date)}: ${e.items.slice(0, 3).map((i: { network: string; campaign: string }) => `${NET[i.network]} ${short(i.campaign)}`).join(', ')}${e.items.length > 3 ? ' i druge' : ''}`
    case 'spend_anomaly':
      return `${NET[e.network]} ${short(e.campaign)}: ${eur(e.spend)} ${dm(e.date)} naspram uobičajenih ${eur(e.baseline_same_weekday)} (${e.change_pct > 0 ? '+' : ''}${e.change_pct}%)`
    case 'tracking':
      return `${NET[e.network]}: ${eur(e.spend)} troška i 0 konverzija ${dm(e.date)}`
    case 'conv_drop':
      return `${NET[e.network]} konverzije ${dm(e.date)}: ${fmt1(e.conversions)} naspram uobičajenih ${fmt1(e.baseline_conversions)} (${e.change_pct}%)`
    case 'brief_prep':
      return `Akcija „${e.action}“ počinje ${dm(e.start_date)}, a u Brain-u nema pripremljene asset grupe`
    case 'brief_ended':
      return `„${e.asset_group}“ troši i posle kraja akcije ${dm(e.end_date)}: ${eur(e.spend_after_end)}`
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
    case 'pacing':
      return { detail: `Plan za mesec je ${eur(e.plan_month)}; ostalo je ${e.remaining_days} dana.`, proposal: `Dnevni budžet always-on kampanja pomeriti za ${eur(e.daily_adjustment)}.` }
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
    const [severity, what, proposal] = label[action] ?? label.zadrzi
    g.items.sort((a, b) => Number(b.spend) - Number(a.spend))
    const top = g.items.slice(0, 4).map((i) => `${i.term} (${fmt1(i.spend)} EUR)`).join(', ')
    out.push({
      check_type: 'search_terms',
      fingerprint: `st_group:${action}`,
      severity,
      impact_eur: Math.round(g.spend),
      title: `${g.items.length} ${what} potrošilo je ${fmt(g.spend)} EUR za ${days} dana bez ijedne konverzije`,
      detail: `Najveći: ${top}.${action === 'iskljuci_iz_brend_kampanja' ? ' Konkurentski upiti se prikazuju u brend kampanjama drugih brendova, što liči na široko podudaranje.' : ''}`,
      proposal,
      evidence: { action, days, terms: g.items },
    })
  }
  return out
}

async function reviewClient(clientId: string, clientName: string, params: Record<string, unknown>) {
  const runDate = today()
  const { data: run, error: runErr } = await sb.from('review_runs')
    .upsert({ client_id: clientId, run_date: runDate, status: 'running', started_at: new Date().toISOString(), error: null }, { onConflict: 'client_id,run_date' })
    .select('id').single()
  if (runErr) throw runErr

  try {
    // Yesterday's open findings are superseded by today's run.
    await sb.from('review_findings').update({ status: 'isteklo' }).eq('client_id', clientId).eq('status', 'novo').lt('run_date', runDate)
    // A rerun today replaces today's undecided findings.
    await sb.from('review_findings').delete().eq('run_id', run.id).eq('status', 'novo')

    const { data: cands, error } = await sb.rpc('review_candidates', { p_client_id: clientId })
    if (error) throw error
    let candidates = (cands ?? []) as Candidate[]
    const { data: lastDay } = await sb.from('google_ads_metrics').select('report_date').eq('client_id', clientId).order('report_date', { ascending: false }).limit(1)
    const dataDate = String(lastDay?.[0]?.report_date ?? '')

    // Data freshness: if this morning's sync did not land, day-level checks would be false alarms.
    const { data: fresh } = await sb.from('google_ads_metrics').select('created_at').eq('client_id', clientId).order('created_at', { ascending: false }).limit(1)
    const lastLoad = fresh?.[0]?.created_at as string | undefined
    const stale = !lastLoad || lastLoad.slice(0, 10) < runDate
    if (stale) candidates = candidates.filter((c) => !['spend_anomaly', 'tracking', 'conv_drop'].includes(c.check_type))

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
    candidates = candidates.filter((c) => c.check_type === 'search_term' ? !decidedTerms.has(String(c.evidence.term)) : !decidedFp.has(c.fingerprint))
    candidates = groupStopped(candidates)
    for (const c of candidates) {
      if (c.check_type === 'pacing') c.evidence.daily_adjustment = Math.round(-Number(c.evidence.gap) / Math.max(1, Number(c.evidence.remaining_days)))
    }

    const terms = candidates.filter((c) => c.check_type === 'search_term')
    const others = candidates.filter((c) => c.check_type !== 'search_term')
    let findings: Finding[] = []
    let model = ''
    if (stale) {
      findings.push({
        check_type: 'data', fingerprint: `data_stale:${runDate}`, severity: 'hitno', impact_eur: null,
        title: 'Jutarnji sync podataka nije stigao; dnevne provere su preskočene',
        detail: `Poslednje učitavanje Google podataka: ${lastLoad ?? 'nepoznato'}. Bez svežih podataka provere troška i konverzija bi davale lažne alarme.`,
        proposal: 'Proveriti sync u Brain-u (sync_queue) i ponovo pokrenuti pregled kad podaci stignu.',
        evidence: { last_load: lastLoad ?? null },
      })
    }
    if (terms.length || others.length) {
      const { out, model: m } = await askClaude(buildPrompt(clientName, params, dataDate, stale, terms, others))
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
    }

    findings.sort((a, b) => (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]) || ((b.impact_eur ?? 0) - (a.impact_eur ?? 0)))
    findings = findings.slice(0, Number(params.max_findings ?? 7))

    if (findings.length) {
      const { error: insErr } = await sb.from('review_findings').insert(findings.map((f, i) => ({
        run_id: run.id, client_id: clientId, run_date: runDate, check_type: f.check_type, fingerprint: f.fingerprint,
        severity: f.severity, impact_eur: f.impact_eur, title: f.title, detail: f.detail, proposal: f.proposal,
        evidence: f.evidence, rank: i + 1,
      })))
      if (insErr) throw insErr
    }
    await sb.from('review_runs').update({
      status: 'done', finished_at: new Date().toISOString(), data_date: dataDate || null,
      candidates: candidates.length, findings: findings.length, model: model || null,
    }).eq('id', run.id)
    return { client: clientName, candidates: candidates.length, findings: findings.length, stale }
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
        results.push(await reviewClient(s.client_id, (s.clients as unknown as { name: string })?.name ?? '', s.params as Record<string, unknown>))
      } catch (e) {
        results.push({ client_id: s.client_id, error: (e as Error).message })
      }
    }
    return json({ ok: true, results })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
