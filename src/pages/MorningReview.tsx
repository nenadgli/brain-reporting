import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { downloadText } from '../lib/creatives'

type Params = Record<string, unknown> & { currency?: string }
type ClientOpt = { client_id: string; params: Params; clients: { name: string } | null }
type Run = {
  id: string
  run_date: string
  data_date: string | null
  status: 'running' | 'done' | 'failed'
  error: string | null
  candidates: number | null
  findings: number | null
  team_notes: TeamNotes
  finished_at: string | null
}
type TeamNotes = { minutes_team?: string; minutes_tool?: string; only_tool?: string; missed?: string }
type Status = 'novo' | 'odobreno' | 'odbijeno' | 'odlozeno' | 'izvrseno' | 'isteklo'
type Finding = {
  id: string
  check_type: string
  severity: 'hitno' | 'visoko' | 'srednje' | 'info'
  impact_eur: number | null
  title: string
  detail: string | null
  proposal: string | null
  evidence: Record<string, unknown>
  rank: number | null
  status: Status
  decision_reason: string | null
  decided_at: string | null
}
type Term = { term: string; spend: number; clicks: number; campaigns: string[]; kind?: string; why?: string }

const SEVERITY: Record<Finding['severity'], { label: string; cls: string }> = {
  hitno: { label: 'Hitno', cls: 'bg-red-600 text-white' },
  visoko: { label: 'Visoko', cls: 'bg-[var(--color-rust)] text-white' },
  srednje: { label: 'Srednje', cls: 'bg-amber-100 text-amber-900' },
  info: { label: 'Info', cls: 'bg-slate-100 text-slate-700' },
}
const CHECK_LABEL: Record<string, string> = {
  pacing: 'Trošenje prema planu',
  spend_anomaly: 'Odstupanje troška',
  spend_stopped: 'Kampanje bez troška',
  tracking: 'Tracking',
  conv_drop: 'Pad konverzija',
  search_terms: 'Search termini',
  brief_prep: 'Akcija uskoro',
  brief_ended: 'Akcija završena',
  data: 'Podaci',
  meta_cap: 'Meta limit naloga',
  campaign_budgets: 'Mesečni budžeti',
}
const STATUS_LABEL: Record<Status, string> = {
  novo: 'Čeka odluku', odobreno: 'Odobreno', odbijeno: 'Odbijeno', odlozeno: 'Odloženo', izvrseno: 'Urađeno', isteklo: 'Isteklo',
}

const fmtInt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const shortDate = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`

function Evidence({ f, cur }: { f: Finding; cur: string }) {
  const e = f.evidence
  if (f.check_type === 'search_terms') {
    const terms = (e.terms as Term[]) ?? []
    return (
      <table className="mt-2 w-full text-xs">
        <thead className="text-left text-[var(--color-ink-soft)]">
          <tr><th className="py-1 pr-3">Termin</th><th className="pr-3 text-right">Trošak ({cur})</th><th className="pr-3 text-right">Klikovi</th><th className="pr-3 text-right">Kampanja</th><th>Zašto</th></tr>
        </thead>
        <tbody>
          {terms.map((t) => (
            <tr key={t.term} className="border-t border-[var(--color-line)]">
              <td className="py-1 pr-3 font-medium">{t.term}</td>
              <td className="pr-3 text-right">{t.spend}</td>
              <td className="pr-3 text-right">{t.clicks}</td>
              <td className="pr-3 text-right" title={t.campaigns.join('\n')}>{t.campaigns.length}</td>
              <td className="text-[var(--color-ink-soft)]">{t.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (f.check_type === 'spend_stopped') {
    const items = (e.items as Record<string, unknown>[]) ?? []
    return (
      <table className="mt-2 w-full text-xs">
        <thead className="text-left text-[var(--color-ink-soft)]">
          <tr><th className="py-1 pr-3">Kampanja</th><th className="pr-3 text-right">Uobičajeno ({cur})</th><th className="pr-3">Poslednji trošak</th><th>Flight u planu</th></tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={String(i.campaign)} className="border-t border-[var(--color-line)]">
              <td className="py-1 pr-3">{String(i.network)} · {String(i.campaign)}</td>
              <td className="pr-3 text-right">{fmtInt(Number(i.baseline_same_weekday))}</td>
              <td className="pr-3">{i.last_spend_date ? shortDate(String(i.last_spend_date)) : '—'}</td>
              <td className="text-[var(--color-ink-soft)]">
                {[...((i.planned_flights_that_day as string[]) ?? []).map((l) => `traje: ${l}`),
                  ...((i.flights_ended_last_3_days as { label: string; end: string }[]) ?? []).map((l) => `završen ${shortDate(l.end)}: ${l.label}`)].join('; ') || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (f.check_type === 'campaign_budgets') {
    const items = (e.items as Record<string, unknown>[]) ?? []
    const label: Record<string, string> = { prekoraceno: 'prekoračeno', prebrzo: 'prebrzo', presporo: 'presporo' }
    return (
      <table className="mt-2 w-full text-xs">
        <thead className="text-left text-[var(--color-ink-soft)]">
          <tr><th className="py-1 pr-3">Kampanja</th><th className="pr-3 text-right">Budžet ({cur})</th><th className="pr-3 text-right">Potrošeno</th><th className="pr-3 text-right">Projekcija</th><th className="pr-3 text-right">Predlog dnevnog</th><th>Status</th></tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={`${i.network}|${i.campaign}`} className="border-t border-[var(--color-line)]">
              <td className="py-1 pr-3">{String(i.network)} · {String(i.campaign)}</td>
              <td className="pr-3 text-right">{fmtInt(Number(i.monthly_budget))}</td>
              <td className="pr-3 text-right">{fmtInt(Number(i.spent_mtd))}</td>
              <td className="pr-3 text-right">{fmtInt(Number(i.projected_month))}</td>
              <td className="pr-3 text-right">{i.recommended_daily == null ? '—' : Number(i.recommended_daily).toLocaleString('sr-RS', { maximumFractionDigits: 2 })}</td>
              <td>{label[String(i.status)] ?? String(i.status)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    )
  }
  if (f.check_type === 'pacing') {
    const rows: [string, unknown][] = [
      ['Plan za mesec', e.plan_month], ['Plan do sada (po flightovima)', e.plan_to_date], ['Potrošeno do sada', e.spent_to_date],
      ['Linearno do sada (za poređenje)', e.linear_to_date], ['Razlika', e.gap], ['Preostalo dana', e.remaining_days],
    ]
    return (
      <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1 text-xs md:grid-cols-3">
        {rows.map(([k, v]) => (
          <div key={k}><dt className="inline text-[var(--color-ink-soft)]">{k}: </dt><dd className="inline font-medium">{typeof v === 'number' ? fmtInt(v) : String(v ?? '—')}</dd></div>
        ))}
      </dl>
    )
  }
  const flat = Object.entries(e).filter(([k, v]) => v !== null && typeof v !== 'object' && k !== 'text_checked')
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 text-xs md:grid-cols-2">
      {flat.map(([k, v]) => (
        <div key={k}><dt className="inline text-[var(--color-ink-soft)]">{k}: </dt><dd className="inline">{k === 'task_url' ? <a href={String(v)} target="_blank" rel="noreferrer" className="underline">Productive</a> : String(v)}</dd></div>
      ))}
    </dl>
  )
}

const LIST_FIELDS: [string, string, string][] = [
  ['protected_terms', 'Zaštićeni termini', 'brend klijenta; nikad se ne predlažu za isključivanje'],
  ['brands_sold', 'Brendovi koje klijent prodaje', 'termini sa ovim brendovima su relevantni'],
  ['competitors', 'Konkurenti', 'druge prodavnice i brendovi koje klijent ne prodaje'],
  ['exclude_campaign_patterns', 'Kampanje koje se ne gledaju (regex)', 'npr. ^Social_ za kampanje social tima'],
]
const NUM_FIELDS: [string, string][] = [
  ['pacing_tolerance', 'Dozvoljeno odstupanje od plana (0.15 = 15%)'],
  ['spend_anomaly', 'Prag promene troška kampanje (0.5 = 50%)'],
  ['spend_anomaly_min_eur', 'Najmanji dnevni trošak kampanje za alarm'],
  ['tracking_min_spend_eur', 'Najmanji dnevni trošak za proveru trackinga'],
  ['conv_drop', 'Pad konverzija za alarm (0.4 = 40%)'],
  ['conv_drop_min_baseline', 'Najmanje uobičajenih konverzija dnevno'],
  ['waste_min_spend_eur', 'Search termin bez konverzije: najmanji trošak'],
  ['waste_days', 'Search termini: broj dana'],
  ['max_findings', 'Najviše nalaza dnevno'],
  ['cooldown_days', 'Odlučene stavke ne vraćati (dana)'],
]

function SettingsPanel({ client, onSaved }: { client: ClientOpt; onSaved: (p: Params) => void }) {
  const [draft, setDraft] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  useEffect(() => {
    const p = client.params ?? {}
    const d: Record<string, string> = { currency: String(p.currency ?? 'EUR'), productive_project_id: String(p.productive_project_id ?? '') }
    for (const [k] of LIST_FIELDS) d[k] = ((p[k] as string[]) ?? []).join('\n')
    for (const [k] of NUM_FIELDS) d[k] = p[k] == null ? '' : String(p[k])
    setDraft(d)
    setMsg('')
  }, [client])

  async function save() {
    const p: Params = { ...client.params, currency: draft.currency.trim().toUpperCase() || 'EUR' }
    if (draft.productive_project_id.trim()) p.productive_project_id = draft.productive_project_id.trim()
    else delete p.productive_project_id
    for (const [k] of LIST_FIELDS) p[k] = draft[k].split('\n').map((x) => x.trim()).filter(Boolean).map((x) => (k === 'exclude_campaign_patterns' ? x : x.toLowerCase()))
    for (const [k, label] of NUM_FIELDS) {
      const n = Number(draft[k].replace(',', '.'))
      if (!Number.isFinite(n) || draft[k].trim() === '') { setMsg(`Neispravan broj: ${label}`); return }
      p[k] = n
    }
    for (const r of (p.exclude_campaign_patterns as string[])) {
      try { new RegExp(r) } catch { setMsg(`Neispravan regex: ${r}`); return }
    }
    setSaving(true)
    const { error } = await supabase.from('review_settings').update({ params: p, updated_at: new Date().toISOString() }).eq('client_id', client.client_id)
    setSaving(false)
    if (error) { setMsg(error.message); return }
    setMsg('Sačuvano. Važi od sledećeg pregleda.')
    onSaved(p)
  }

  const cls = 'w-full rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'
  return (
    <section className="mb-8 rounded border border-[var(--color-line)] bg-white p-5 text-sm">
      <div className="grid gap-4 md:grid-cols-2">
        {LIST_FIELDS.map(([k, label, hint]) => (
          <label key={k}>
            <span className="mb-1 block font-medium">{label}</span>
            <span className="mb-1 block text-xs text-[var(--color-ink-soft)]">{hint}; jedan po redu</span>
            <textarea rows={5} className={cls} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
          </label>
        ))}
      </div>
      <div className="mt-4 grid gap-3 md:grid-cols-4">
        <label><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">Valuta naloga</span>
          <input className={cls} value={draft.currency ?? ''} onChange={(e) => setDraft({ ...draft, currency: e.target.value })} /></label>
        <label><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">Productive projekat (ID, za kalendar akcija)</span>
          <input className={cls} value={draft.productive_project_id ?? ''} onChange={(e) => setDraft({ ...draft, productive_project_id: e.target.value })} /></label>
        {NUM_FIELDS.map(([k, label]) => (
          <label key={k}><span className="mb-1 block text-xs text-[var(--color-ink-soft)]">{label}</span>
            <input className={cls} value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} /></label>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button onClick={save} disabled={saving} className="rounded bg-[var(--color-indigo)] px-4 py-1.5 font-medium text-white disabled:opacity-40">{saving ? 'Čuvam…' : 'Sačuvaj podešavanja'}</button>
        {msg && <span className="text-xs text-[var(--color-ink-soft)]">{msg}</span>}
      </div>
    </section>
  )
}

export default function MorningReview() {
  const [clients, setClients] = useState<ClientOpt[]>([])
  const [clientId, setClientId] = useState('')
  const [runs, setRuns] = useState<Run[]>([])
  const [runId, setRunId] = useState('')
  const [findings, setFindings] = useState<Finding[]>([])
  const [rejecting, setRejecting] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [rerunning, setRerunning] = useState(false)
  const [notes, setNotes] = useState<TeamNotes>({})
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [overview, setOverview] = useState<Record<string, { open: number; urgent: number }>>({})
  const [showSettings, setShowSettings] = useState(false)

  useEffect(() => {
    supabase.from('review_settings').select('client_id, params, clients(name)').eq('enabled', true).then(({ data }) => {
      const list = ((data ?? []) as unknown as ClientOpt[]).sort((a, b) => (a.clients?.name ?? '').localeCompare(b.clients?.name ?? ''))
      setClients(list)
      if (list.length) setClientId(list[0].client_id)
    })
  }, [])

  // Today's open findings across all clients, so the team lead sees where to start.
  useEffect(() => {
    supabase.from('review_findings').select('client_id, severity').eq('status', 'novo').eq('run_date', new Date().toISOString().slice(0, 10)).then(({ data }) => {
      const m: Record<string, { open: number; urgent: number }> = {}
      for (const r of data ?? []) {
        const o = (m[r.client_id] ??= { open: 0, urgent: 0 })
        o.open++
        if (r.severity === 'hitno' || r.severity === 'visoko') o.urgent++
      }
      setOverview(m)
    })
  }, [findings])

  async function loadRuns(selectLatest = true) {
    if (!clientId) return
    const { data } = await supabase.from('review_runs')
      .select('id, run_date, data_date, status, error, candidates, findings, team_notes, finished_at')
      .eq('client_id', clientId).order('run_date', { ascending: false }).limit(15)
    const list = (data ?? []) as Run[]
    setRuns(list)
    if (selectLatest || !list.some((r) => r.id === runId)) setRunId(list[0]?.id ?? '')
  }
  useEffect(() => { loadRuns() }, [clientId])

  const run = runs.find((r) => r.id === runId) ?? null
  useEffect(() => { setNotes(run?.team_notes ?? {}) }, [run?.id])

  async function loadFindings() {
    if (!runId) { setFindings([]); return }
    const { data } = await supabase.from('review_findings')
      .select('id, check_type, severity, impact_eur, title, detail, proposal, evidence, rank, status, decision_reason, decided_at')
      .eq('run_id', runId).order('rank')
    setFindings((data ?? []) as Finding[])
  }
  useEffect(() => { loadFindings() }, [runId])

  async function decide(f: Finding, status: Status, why?: string) {
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('review_findings').update({
      status, decision_reason: why ?? null, decided_by: u.user?.id ?? null, decided_at: new Date().toISOString(),
    }).eq('id', f.id)
    if (error) setMessage({ kind: 'err', text: `Odluka nije sačuvana: ${error.message}` })
    setRejecting(null); setReason('')
    loadFindings()
  }

  async function rerun() {
    setRerunning(true); setMessage(null)
    const { data, error } = await supabase.functions.invoke('morning-review', { body: { client_id: clientId } })
    setRerunning(false)
    const r = data?.results?.[0]
    if (error || data?.error || r?.error) {
      setMessage({ kind: 'err', text: `Pregled nije uspeo: ${data?.error ?? r?.error ?? error?.message}` })
    } else {
      setMessage({ kind: 'ok', text: `Pregled je završen: ${r?.findings ?? 0} nalaza od ${r?.candidates ?? 0} kandidata.${r?.stale ? ' Podaci nisu sveži; dnevne provere su preskočene.' : ''}` })
    }
    loadRuns()
  }

  async function saveNotes() {
    if (!run) return
    const { error } = await supabase.from('review_runs').update({ team_notes: notes }).eq('id', run.id)
    setMessage(error ? { kind: 'err', text: 'Beleška nije sačuvana.' } : { kind: 'ok', text: 'Beleška za probnu nedelju je sačuvana.' })
    loadRuns(false)
  }

  // Approved negative keywords as Editor rows: one exact negative per term per campaign it showed up in.
  const approvedNegatives = useMemo(() => {
    const rows: { campaign: string; term: string }[] = []
    for (const f of findings) {
      if (f.check_type !== 'search_terms' || f.status !== 'odobreno' || f.evidence.action === 'zadrzi') continue
      for (const t of (f.evidence.terms as Term[]) ?? []) for (const c of t.campaigns) rows.push({ campaign: c, term: t.term })
    }
    return rows
  }, [findings])

  function exportNegatives() {
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
    const lines = ['Campaign,Ad group,Keyword,Criterion Type', ...approvedNegatives.map((r) => [esc(r.campaign), '', esc(r.term), 'Negative Exact'].join(','))]
    const name = clients.find((c) => c.client_id === clientId)?.clients?.name ?? 'klijent'
    downloadText(`negativne_${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}_${run?.run_date ?? ''}.csv`, lines.join('\r\n') + '\r\n')
  }

  const client = clients.find((c) => c.client_id === clientId)
  const cur = String(client?.params?.currency ?? 'EUR')
  const open = findings.filter((f) => f.status === 'novo')
  const bySeverity = (s: Finding['severity']) => findings.filter((f) => f.severity === s).length
  const impact = findings.reduce((n, f) => n + (f.impact_eur ?? 0), 0)
  const inputCls = 'w-full rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Faza 1 · samo predlozi, ništa se ne menja u nalogu</p>
          <h1 className="font-display mt-1 text-4xl font-medium">Jutarnji pregled</h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--color-ink-soft)]">
            Svako jutro alat proveri trošenje prema planu, odstupanja, tracking, search termine i kalendar akcija. Za svaki nalaz odluči: odobri, odbij uz razlog ili odloži.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <label>
            <span className="mb-1 block text-[var(--color-ink-soft)]">Klijent</span>
            <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="rounded border border-[var(--color-line)] bg-white px-3 py-1.5">
              {clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.clients?.name}</option>)}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[var(--color-ink-soft)]">Dan</span>
            <select value={runId} onChange={(e) => setRunId(e.target.value)} className="rounded border border-[var(--color-line)] bg-white px-3 py-1.5">
              {runs.map((r) => <option key={r.id} value={r.id}>{shortDate(r.run_date)}{r.status === 'failed' ? ' (greška)' : ''}</option>)}
            </select>
          </label>
          <button onClick={rerun} disabled={rerunning || !clientId}
            className="rounded border border-[var(--color-indigo)] px-4 py-1.5 font-medium text-[var(--color-indigo-dark)] disabled:opacity-40">
            {rerunning ? 'Pregledam…' : 'Pokreni ponovo'}
          </button>
        </div>
      </header>

      {clients.length > 1 && (
        <section className="mb-6 flex flex-wrap gap-2 text-xs">
          {clients.map((c) => {
            const o = overview[c.client_id]
            return (
              <button key={c.client_id} onClick={() => setClientId(c.client_id)}
                className={`rounded border px-3 py-1 ${c.client_id === clientId ? 'border-[var(--color-indigo)] bg-[var(--color-indigo-soft)]' : 'border-[var(--color-line)] bg-white'}`}>
                {c.clients?.name}
                {o ? <span className={o.urgent ? 'ml-1 font-medium text-[var(--color-rust)]' : 'ml-1 text-[var(--color-ink-soft)]'}>{o.open}{o.urgent ? ` (${o.urgent} važno)` : ''}</span> : <span className="ml-1 text-[var(--color-ink-soft)]">0</span>}
              </button>
            )
          })}
        </section>
      )}
      <p className="mb-6 text-xs">
        <button onClick={() => setShowSettings(!showSettings)} className="text-[var(--color-indigo-dark)] underline">
          {showSettings ? 'Sakrij podešavanja klijenta' : 'Podešavanja klijenta (brend, konkurenti, pragovi, valuta)'}
        </button>
      </p>
      {showSettings && client && (
        <SettingsPanel client={client} onSaved={(p) => setClients(clients.map((c) => (c.client_id === client.client_id ? { ...c, params: p } : c)))} />
      )}

      {message && (
        <p className={`mb-6 rounded px-4 py-2 text-sm ${message.kind === 'ok' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-red-50 text-[var(--color-rust)]'}`}>{message.text}</p>
      )}

      {!run && <p className="text-sm text-[var(--color-ink-soft)]">Još nema pregleda za ovog klijenta. Klikni „Pokreni ponovo“.</p>}
      {run && (
        <>
          <section className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
            {[
              ['Čeka odluku', String(open.length)],
              ['Hitno / visoko', `${bySeverity('hitno')} / ${bySeverity('visoko')}`],
              ['Procena u igri', `${fmtInt(impact)} ${cur}`],
              ['Podaci zaključno sa', run.data_date ? shortDate(run.data_date) : '—'],
              ['Kandidata / prikazano', `${run.candidates ?? 0} / ${run.findings ?? 0}`],
            ].map(([k, v]) => (
              <div key={k} className="rounded border border-[var(--color-line)] bg-white p-4">
                <p className="text-xs text-[var(--color-ink-soft)]">{k}</p>
                <p className="font-display mt-1 text-2xl">{v}</p>
              </div>
            ))}
          </section>
          {run.status === 'failed' && <p className="mb-6 rounded bg-red-50 px-4 py-2 text-sm text-[var(--color-rust)]">Pregled nije uspeo: {run.error}</p>}
          {run.status === 'done' && findings.length === 0 && <p className="mb-6 text-sm text-[var(--color-ink-soft)]">Nema nalaza za ovaj dan.</p>}

          <section className="mb-10 space-y-4">
            {findings.map((f) => (
              <article key={f.id} className={`rounded border bg-white p-5 ${f.status === 'novo' ? 'border-[var(--color-line)]' : 'border-dashed border-[var(--color-line)] opacity-75'}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="max-w-3xl">
                    <p className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                      <span className={`rounded px-2 py-0.5 font-medium ${SEVERITY[f.severity].cls}`}>{SEVERITY[f.severity].label}</span>
                      <span className="text-[var(--color-ink-soft)]">{CHECK_LABEL[f.check_type] ?? f.check_type}</span>
                      {f.impact_eur != null && <span className="text-[var(--color-ink-soft)]">· {fmtInt(f.impact_eur)} {cur}</span>}
                    </p>
                    <h3 className="text-base font-medium">{f.title}</h3>
                    {f.detail && <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{f.detail}</p>}
                    {f.proposal && <p className="mt-2 text-sm"><span className="font-medium">Predlog: </span>{f.proposal}</p>}
                  </div>
                  <div className="flex flex-col items-end gap-2 text-xs">
                    {f.status === 'novo' ? (
                      <div className="flex gap-2">
                        <button onClick={() => decide(f, 'odobreno')} className="rounded bg-[var(--color-indigo)] px-3 py-1 font-medium text-white">Odobri</button>
                        <button onClick={() => { setRejecting(f.id); setReason('') }} className="rounded border border-[var(--color-line)] px-3 py-1 text-[var(--color-rust)]">Odbij</button>
                        <button onClick={() => decide(f, 'odlozeno')} className="rounded border border-[var(--color-line)] px-3 py-1">Odloži</button>
                      </div>
                    ) : (
                      <div className="text-right">
                        <span className="font-medium">{STATUS_LABEL[f.status]}</span>
                        {f.decision_reason && <p className="mt-0.5 max-w-60 text-[var(--color-ink-soft)]">„{f.decision_reason}“</p>}
                        {f.status === 'odobreno' && <button onClick={() => decide(f, 'izvrseno', f.decision_reason ?? undefined)} className="mt-1 underline">Označi kao urađeno</button>}
                      </div>
                    )}
                  </div>
                </div>
                {rejecting === f.id && (
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <label className="min-w-72 flex-1 text-xs">
                      <span className="mb-1 block text-[var(--color-ink-soft)]">Zašto odbijaš? Alat uči iz razloga (npr. „konkurente namerno gađamo“, „planirani kraj flighta“).</span>
                      <input value={reason} onChange={(e) => setReason(e.target.value)} className={inputCls} autoFocus />
                    </label>
                    <button onClick={() => decide(f, 'odbijeno', reason.trim())} disabled={!reason.trim()} className="rounded bg-[var(--color-rust)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-40">Odbij</button>
                    <button onClick={() => setRejecting(null)} className="px-2 py-1.5 text-xs">Otkaži</button>
                  </div>
                )}
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-[var(--color-ink-soft)]">Brojevi na koje se nalaz oslanja</summary>
                  <Evidence f={f} cur={cur} />
                </details>
              </article>
            ))}
          </section>

          {approvedNegatives.length > 0 && (
            <section className="mb-10 rounded border border-[var(--color-line)] bg-white p-5">
              <p className="text-sm font-medium">Odobrene negativne ključne reči · {approvedNegatives.length} redova</p>
              <p className="mt-1 text-xs text-[var(--color-ink-soft)]">Exact negativne na nivou kampanja u kojima se termin pojavio. U Editoru: Import → From file → proveri izmene → Post.</p>
              <button onClick={exportNegatives} className="mt-3 rounded border border-[var(--color-indigo)] px-4 py-1.5 text-sm font-medium text-[var(--color-indigo-dark)]">Izvezi CSV za Editor</button>
            </section>
          )}

          <section className="rounded border border-dashed border-[var(--color-line)] bg-white p-5">
            <p className="text-sm font-medium">Beleška za probnu nedelju</p>
            <p className="mb-4 mt-1 text-xs text-[var(--color-ink-soft)]">Popuni posle svog uobičajenog pregleda. Ovo poredimo u petak.</p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
              <label className="text-xs"><span className="mb-1 block text-[var(--color-ink-soft)]">Tvoj pregled (min)</span>
                <input value={notes.minutes_team ?? ''} onChange={(e) => setNotes({ ...notes, minutes_team: e.target.value })} inputMode="numeric" className={inputCls} /></label>
              <label className="text-xs"><span className="mb-1 block text-[var(--color-ink-soft)]">Pregled sa alatom (min)</span>
                <input value={notes.minutes_tool ?? ''} onChange={(e) => setNotes({ ...notes, minutes_tool: e.target.value })} inputMode="numeric" className={inputCls} /></label>
              <label className="text-xs md:col-span-2"><span className="mb-1 block text-[var(--color-ink-soft)]">Šta je našao samo alat</span>
                <input value={notes.only_tool ?? ''} onChange={(e) => setNotes({ ...notes, only_tool: e.target.value })} className={inputCls} /></label>
              <label className="text-xs md:col-span-4"><span className="mb-1 block text-[var(--color-ink-soft)]">Šta je alat propustio</span>
                <textarea value={notes.missed ?? ''} onChange={(e) => setNotes({ ...notes, missed: e.target.value })} rows={2} className={inputCls} /></label>
            </div>
            <button onClick={saveNotes} className="mt-4 rounded bg-[var(--color-indigo)] px-4 py-1.5 text-sm font-medium text-white">Sačuvaj belešku</button>
          </section>
        </>
      )}
    </div>
  )
}
