import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

// "Predlozi kampanja": for every Meta and Google flight line of the month's MPL, what Brain would build (campaign_proposals):
// target campaign, the ad set / asset group / ad group it copies, proposed name, dates, daily budget and the exact steps.
// PROPOSALS ONLY: approving records the team's decision; nothing is sent to Meta or Google.

type Proposal = {
  network: 'meta' | 'google'; kind: string; campaign_label: string; channel: string | null; start_date: string; end_date: string; days: number
  budget_total: number; daily_budget: number; action: string; target_campaign: string | null; template_name: string | null; template_id: string | null
  template_dates: string | null; proposed_name: string | null; proposed_campaign: string | null; existing: string | null; state: string
  notes: string[] | null; steps: { action: string; params: Record<string, unknown> }[]; decision: string | null; decision_note: string | null
  decided_by: string | null; decided_at: string | null
}

const MARKETS = ['RS', 'HR', 'BA', 'ME', 'SI', 'AL']
const KIND_LABEL: Record<string, string> = {
  conversion: 'Conversion', add_to_cart: 'Add to cart', remarketing: 'Remarketing (DPA)', traffic: 'Traffic', awareness: 'Awareness',
  pmax: 'PMax asset grupa', demand_gen: 'Demand Gen ad grupa', video: 'YouTube kampanja', other: 'Ostalo',
}
const STATE: Record<string, { label: string; cls: string }> = {
  'za izradu': { label: 'za izradu', cls: 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' },
  postoji: { label: 'već postoji', cls: 'bg-emerald-50 text-emerald-700' },
  'prošlo': { label: 'prošlo', cls: 'bg-slate-100 text-slate-500' },
  'ručno': { label: 'ručno', cls: 'bg-amber-50 text-amber-700' },
  'nema šablona': { label: 'nema šablona', cls: 'bg-red-50 text-red-700' },
  'nema kampanje': { label: 'nema kampanje', cls: 'bg-red-50 text-red-700' },
}
const DECISION: Record<string, string> = { odobreno: 'Odobreno', odbaceno: 'Odbačeno', napravljeno_rucno: 'Napravljeno ručno' }

const day = (s: string) => `${Number(s.slice(8, 10))}.${Number(s.slice(5, 7))}.`
const eur = (n: number | null) => (n == null ? '–' : `${Number(n).toLocaleString('sr-Latn-RS', { maximumFractionDigits: 0 })} €`)
const monthStart = (offset: number) => { const d = new Date(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + offset); return d.toISOString().slice(0, 10) }
const monthLabel = (iso: string) => new Date(iso).toLocaleDateString('sr-Latn-RS', { month: 'long', year: 'numeric' })

function Step({ s, i }: { s: Proposal['steps'][number]; i: number }) {
  return (
    <li className="flex gap-2 text-xs">
      <span className="w-4 shrink-0 text-right text-[var(--color-ink-soft)]">{i + 1}.</span>
      <span className="min-w-0">
        <span className="font-mono font-medium">{s.action}</span>
        <span className="text-[var(--color-ink-soft)]"> · </span>
        {Object.entries(s.params).map(([k, v], j) => (
          <span key={k} className="break-words">{j > 0 && <span className="text-[var(--color-ink-soft)]">, </span>}<span className="text-[var(--color-ink-soft)]">{k}=</span>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
        ))}
      </span>
    </li>
  )
}

export default function CampaignProposals() {
  const [market, setMarket] = useState('RS')
  const [month, setMonth] = useState(monthStart(0))
  const [clients, setClients] = useState<Record<string, string>>({})
  const [rows, setRows] = useState<Proposal[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showPast, setShowPast] = useState(false)
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [tick, setTick] = useState(0)

  useEffect(() => {
    supabase.from('clients').select('id, name').like('name', 'Fashion&Friends %').then(({ data }) => {
      const m: Record<string, string> = {}
      for (const c of (data ?? []) as { id: string; name: string }[]) m[c.name.replace('Fashion&Friends ', '')] = c.id
      setClients(m)
    })
  }, [])

  const clientId = clients[market]
  useEffect(() => {
    if (!clientId) return
    setLoading(true); setError('')
    supabase.rpc('campaign_proposals', { p_client_id: clientId, p_month: month }).then(({ data, error: e }) => {
      setLoading(false)
      if (e) { setError(e.message); return }
      setRows((data ?? []) as Proposal[])
    })
  }, [clientId, month, tick])

  // Lines of one promo (e.g. Black Friday: Meta conversion + remarketing + traffic, Google PMax + Demand Gen) together.
  const groups = useMemo(() => {
    const visible = rows.filter((r) => showPast || r.state !== 'prošlo')
    const m = new Map<string, Proposal[]>()
    for (const r of visible) {
      const key = r.action.toLowerCase()
      if (!m.has(key)) m.set(key, [])
      m.get(key)!.push(r)
    }
    return [...m.entries()].map(([, list]) => ({ action: list[0].action, start: list.reduce((a, r) => (r.start_date < a ? r.start_date : a), list[0].start_date), list }))
      .sort((a, b) => a.start.localeCompare(b.start))
  }, [rows, showPast])

  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const r of rows) c[r.state] = (c[r.state] ?? 0) + 1
    return c
  }, [rows])

  async function decide(p: Proposal, status: string | null) {
    const key = { client_id: clientId, month, network: p.network, campaign_label: p.campaign_label, plan_start: p.start_date }
    const { error: e } = status
      ? await supabase.from('campaign_proposal_decisions').upsert({ ...key, status, decided_at: new Date().toISOString() }, { onConflict: 'client_id,month,network,campaign_label,plan_start' })
      : await supabase.from('campaign_proposal_decisions').delete().match(key)
    if (e) { setError(e.message); return }
    setTick((t) => t + 1)
  }

  return (
    <div>
      <div className="mb-4">
        <p className="eyebrow-label">Kampanje · iz MPL-a</p>
        <h1 className="font-display text-2xl font-semibold">Predlozi kampanja</h1>
        <p className="mt-1 max-w-3xl text-sm text-[var(--color-ink-soft)]">
          Za svaku akciju iz MPL-a: šta bi Brain napravio u Meta i Google nalogu, po kom šablonu, sa kojim imenom, datumima i budžetom, i tačni koraci.
        </p>
      </div>
      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800">
        Samo predlozi. Ništa se ne šalje u Meta ni Google; „Odobri“ samo beleži odluku tima.
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-[var(--color-line)] bg-white p-1 text-sm">
          {MARKETS.map((m) => (
            <button key={m} onClick={() => { setMarket(m); setOpen({}) }}
              className={`rounded px-4 py-1.5 ${market === m ? 'bg-[var(--color-indigo)] text-white' : 'text-[var(--color-ink-soft)]'}`}>{m}</button>
          ))}
        </div>
        <div className="inline-flex rounded-lg border border-[var(--color-line)] bg-white p-1 text-sm">
          {[0, 1].map((o) => { const m = monthStart(o); return (
            <button key={m} onClick={() => setMonth(m)} className={`rounded px-4 py-1.5 ${month === m ? 'bg-[var(--color-indigo)] text-white' : 'text-[var(--color-ink-soft)]'}`}>{monthLabel(m)}</button>
          ) })}
        </div>
        <label className="flex items-center gap-2 text-sm text-[var(--color-ink-soft)]">
          <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /> prikaži i prošle akcije
        </label>
        <span className="ml-auto text-sm text-[var(--color-ink-soft)]">
          {Object.entries(counts).map(([k, v]) => `${STATE[k]?.label ?? k}: ${v}`).join(' · ')}
        </span>
      </div>

      {error && <p className="mb-4 text-sm text-[var(--color-rust)]">{error}</p>}
      {loading && <p className="text-sm text-[var(--color-ink-soft)]">Učitavanje…</p>}
      {!loading && !error && groups.length === 0 && <p className="text-sm text-[var(--color-ink-soft)]">Nema akcija (Flight linija) za {market} u ovom mesecu{showPast ? '' : ' koje nisu prošle'}.</p>}

      <div className="space-y-6">
        {groups.map((g) => (
          <section key={g.action}>
            <h2 className="mb-2 text-lg font-semibold">{g.action} <span className="text-sm font-normal text-[var(--color-ink-soft)]">od {day(g.start)}</span></h2>
            <div className="space-y-2">
              {g.list.map((p) => {
                const id = `${p.network}|${p.campaign_label}|${p.start_date}`
                const st = STATE[p.state] ?? { label: p.state, cls: 'bg-slate-100 text-slate-600' }
                return (
                  <div key={id} className="card px-4 py-3">
                    <div className="flex flex-wrap items-start gap-3">
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${p.network === 'meta' ? 'bg-blue-50 text-blue-700' : 'bg-orange-50 text-orange-700'}`}>{p.network === 'meta' ? 'Meta' : 'Google'}</span>
                      <div className="min-w-0 flex-1">
                        <div className="font-medium">{p.campaign_label} <span className="font-normal text-[var(--color-ink-soft)]">· {KIND_LABEL[p.kind] ?? p.kind}</span></div>
                        <div className="text-xs text-[var(--color-ink-soft)]">{day(p.start_date)}–{day(p.end_date)} · {p.days} dan{p.days === 1 ? '' : 'a'} · {eur(p.budget_total)} = {eur(p.daily_budget)}/dan</div>
                      </div>
                      <span className={`rounded px-1.5 py-0.5 text-xs ${st.cls}`}>{st.label}</span>
                      {p.decision && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-xs text-white" title={`${p.decided_by ?? ''} ${p.decided_at ? new Date(p.decided_at).toLocaleString('sr-Latn-RS') : ''}`}>{DECISION[p.decision] ?? p.decision}</span>}
                    </div>

                    {p.existing ? (
                      <p className="mt-2 text-sm">U nalogu već postoji: <span className="text-[var(--color-ink-soft)]">{p.existing}</span></p>
                    ) : (
                      <div className="mt-3 grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">
                        <div><span className="text-[var(--color-ink-soft)]">Kampanja: </span>{p.proposed_campaign ?? '–'}</div>
                        <div><span className="text-[var(--color-ink-soft)]">Novo ime: </span><span className="font-medium">{p.proposed_name ?? '–'}</span></div>
                        <div className="md:col-span-2"><span className="text-[var(--color-ink-soft)]">Šablon: </span>{p.template_name ?? '–'}{p.template_dates ? <span className="text-[var(--color-ink-soft)]"> ({p.template_dates})</span> : null}</div>
                      </div>
                    )}

                    {(p.notes?.length ?? 0) > 0 && !p.existing && (
                      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-[var(--color-ink-soft)]">{p.notes!.map((n) => <li key={n}>{n}</li>)}</ul>
                    )}

                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      {p.steps.length > 0 && !p.existing && (
                        <button onClick={() => setOpen({ ...open, [id]: !open[id] })} className="btn-ghost text-xs">{open[id] ? '▾' : '▸'} {p.steps.length} koraka</button>
                      )}
                      <span className="flex-1" />
                      {p.decision ? (
                        <button onClick={() => decide(p, null)} className="btn-ghost text-xs">Poništi odluku</button>
                      ) : p.state === 'za izradu' || p.state === 'nema šablona' || p.state === 'nema kampanje' || p.state === 'ručno' ? (<>
                        <button onClick={() => decide(p, 'odbaceno')} className="btn-secondary px-3 py-1 text-xs">Odbaci</button>
                        <button onClick={() => decide(p, 'napravljeno_rucno')} className="btn-secondary px-3 py-1 text-xs">Napravljeno ručno</button>
                        {p.state === 'za izradu' && <button onClick={() => decide(p, 'odobreno')} className="btn-primary px-3 py-1 text-xs">Odobri</button>}
                      </>) : null}
                    </div>
                    {open[id] && <ol className="mt-2 space-y-1 rounded bg-[var(--color-paper)] px-3 py-2">{p.steps.map((s, i) => <Step key={i} s={s} i={i} />)}</ol>}
                  </div>
                )
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}
