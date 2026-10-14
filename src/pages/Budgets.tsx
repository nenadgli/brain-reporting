import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { downloadText } from '../lib/creatives'

// Replaces the "Budgets & Optimization" sheets and the monthly "Potrošnja - All clients" sheet:
// the team types monthly budgets per campaign, Brain fills in spend and the daily budget that
// spends the rest evenly. Exports are files for Google Ads Editor; nothing is changed in any account.

type Client = { id: string; name: string }
type Row = {
  network: 'google' | 'meta'
  campaign: string
  campaign_type: string | null
  monthly_budget: number | null
  spent_mtd: number
  remaining: number | null
  data_date: string
  days_left: number
  recommended_daily: number | null
  avg_daily_7d: number
  spend_last_day: number
  projected_month: number
  roas_30d: number | null
  conversions_30d: number | null
  cpa_30d: number | null
  status: 'bez_budzeta' | 'prekoraceno' | 'prebrzo' | 'presporo' | 'u_planu'
}
type Setting = { campaign: string; campaign_status: string | null; daily_budget: number | null; budget_shared: boolean | null; bidding_strategy_type: string | null; target_roas: number | null; target_cpa: number | null; snapshot_date: string }
type SpendRow = {
  client_id: string
  client_name: string
  currency: string
  data_date: string
  days_left: number
  google_regular: number
  google_app: number
  meta_ecomm: number
  meta_social: number
  meta_app: number
  total: number
  projected_total: number
}

const STATUS: Record<Row['status'], { label: string; cls: string }> = {
  bez_budzeta: { label: 'nema budžeta', cls: 'text-[var(--color-ink-soft)]' },
  prekoraceno: { label: 'prekoračeno', cls: 'bg-red-50 text-[var(--color-rust)]' },
  prebrzo: { label: 'troši prebrzo', cls: 'bg-amber-50 text-amber-800' },
  presporo: { label: 'troši presporo', cls: 'bg-amber-50 text-amber-800' },
  u_planu: { label: 'u planu', cls: 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' },
}
// Bidding on value only makes sense where conversion value is the goal.
const TROAS_TYPES = ['PERFORMANCE_MAX', 'SHOPPING', 'SEARCH']

const n0 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('sr-RS', { maximumFractionDigits: 0 }))
const n2 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('sr-RS', { maximumFractionDigits: 2 }))
const monthStart = (offset: number) => {
  const d = new Date()
  const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1))
  return m.toISOString().slice(0, 10)
}
const monthLabel = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('sr-Latn-RS', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const esc = (s: string) => (/[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s)
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export default function Budgets() {
  const [mode, setMode] = useState<'campaigns' | 'spend'>('campaigns')
  const [clients, setClients] = useState<Client[]>([])
  const [currencies, setCurrencies] = useState<Record<string, string>>({})
  const [clientId, setClientId] = useState('')
  const [month, setMonth] = useState(monthStart(0))
  const [rows, setRows] = useState<Row[]>([])
  const [edits, setEdits] = useState<Record<string, string>>({})
  const [settings, setSettings] = useState<Record<string, Setting>>({})
  const [spend, setSpend] = useState<SpendRow[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    supabase.from('clients').select('id, name').order('name').then(({ data }) => {
      setClients((data ?? []) as Client[])
      if (data?.length) setClientId(data[0].id)
    })
    supabase.from('review_settings').select('client_id, params').then(({ data }) => {
      const m: Record<string, string> = {}
      for (const r of data ?? []) m[r.client_id] = String((r.params as { currency?: string })?.currency ?? 'EUR')
      setCurrencies(m)
    })
  }, [])

  async function loadPlan() {
    if (!clientId) return
    setLoading(true)
    const { data, error } = await supabase.rpc('budget_plan', { p_client_id: clientId, p_month: month })
    setLoading(false)
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    setRows((data ?? []) as Row[])
    setEdits({})
    // Current daily budgets and bidding targets from this morning's account snapshot.
    const { data: last } = await supabase.from('google_campaign_settings').select('snapshot_date').eq('client_id', clientId).order('snapshot_date', { ascending: false }).limit(1)
    const snap = last?.[0]?.snapshot_date
    const m: Record<string, Setting> = {}
    if (snap) {
      const { data: st } = await supabase.from('google_campaign_settings')
        .select('campaign, campaign_status, daily_budget, budget_shared, bidding_strategy_type, target_roas, target_cpa, snapshot_date')
        .eq('client_id', clientId).eq('snapshot_date', snap)
      for (const x of (st ?? []) as Setting[]) m[x.campaign] = x
    }
    setSettings(m)
  }
  async function loadSpend() {
    setLoading(true)
    const { data, error } = await supabase.rpc('monthly_spend_report', { p_month: month })
    setLoading(false)
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    setSpend((data ?? []) as SpendRow[])
  }
  useEffect(() => { if (mode === 'campaigns') loadPlan(); else loadSpend() }, [mode, clientId, month]) // eslint-disable-line react-hooks/exhaustive-deps

  const key = (r: Pick<Row, 'network' | 'campaign'>) => `${r.network}|${r.campaign}`
  const cur = currencies[clientId] ?? 'EUR'
  const client = clients.find((c) => c.id === clientId)
  const dirty = Object.keys(edits).length

  async function save() {
    const out = []
    for (const [k, v] of Object.entries(edits)) {
      const [network, ...rest] = k.split('|')
      const amount = Number(v.replace(/\s/g, '').replace(',', '.'))
      if (v.trim() === '') continue
      if (!Number.isFinite(amount) || amount < 0) { setMessage({ kind: 'err', text: `Neispravan iznos za ${rest.join('|')}` }); return }
      out.push({ client_id: clientId, month, network, campaign: rest.join('|'), monthly_budget: amount, updated_at: new Date().toISOString() })
    }
    if (!out.length) return
    const { error } = await supabase.from('campaign_budgets').upsert(out, { onConflict: 'client_id,month,network,campaign' })
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    setMessage({ kind: 'ok', text: `Sačuvano ${out.length} budžeta.` })
    loadPlan()
  }

  async function copyPrevious() {
    const prev = new Date(month + 'T00:00:00Z')
    prev.setUTCMonth(prev.getUTCMonth() - 1)
    const prevMonth = prev.toISOString().slice(0, 10)
    const { data, error } = await supabase.from('campaign_budgets').select('network, campaign, monthly_budget').eq('client_id', clientId).eq('month', prevMonth)
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    if (!data?.length) { setMessage({ kind: 'err', text: `Za ${monthLabel(prevMonth)} nema unetih budžeta.` }); return }
    const next = { ...edits }
    for (const b of data) if (!rows.find((r) => key(r) === key(b as Row))?.monthly_budget) next[key(b as Row)] = String(b.monthly_budget)
    setEdits(next)
    setMessage({ kind: 'ok', text: `Preuzeto iz ${monthLabel(prevMonth)}; proveri pa klikni „Sačuvaj“.` })
  }

  // Google Ads Editor: the Budget column sets the campaign's daily budget, matched by campaign name.
  function exportEditor() {
    // Shared budgets are set on the budget, not the campaign, so they stay manual.
    const all = rows.filter((r) => r.network === 'google' && r.recommended_daily != null)
    const shared = all.filter((r) => settings[r.campaign]?.budget_shared)
    const list = all.filter((r) => !settings[r.campaign]?.budget_shared)
    if (!list.length) { setMessage({ kind: 'err', text: 'Nema Google kampanja sa unetim mesečnim budžetom.' }); return }
    const lines = ['Campaign,Budget', ...list.map((r) => `${esc(r.campaign)},${Number(r.recommended_daily).toFixed(2)}`)]
    downloadText(`dnevni-budzeti_${slug(client?.name ?? 'klijent')}_${rows[0]?.data_date ?? month}.csv`, lines.join('\r\n') + '\r\n')
    setMessage({ kind: 'ok', text: `Preuzet CSV za ${list.length} kampanja${shared.length ? `; ${shared.length} sa deljenim budžetom (${shared.map((r) => r.campaign).join(', ')}) treba podesiti ručno` : ''}. U Editoru: Import → From file → proveri izmene budžeta → Post.` })
  }
  function exportMeta() {
    const list = rows.filter((r) => r.network === 'meta' && r.recommended_daily != null)
    if (!list.length) { setMessage({ kind: 'err', text: 'Nema Meta kampanja sa unetim mesečnim budžetom.' }); return }
    const lines = ['Campaign,Monthly budget,Spent,Recommended daily budget', ...list.map((r) => [esc(r.campaign), r.monthly_budget, r.spent_mtd, Number(r.recommended_daily).toFixed(2)].join(','))]
    downloadText(`meta-budzeti_${slug(client?.name ?? 'klijent')}_${rows[0]?.data_date ?? month}.csv`, lines.join('\r\n') + '\r\n')
  }
  function exportSpend() {
    const head = ['Klijent', 'Valuta', 'Google Regular', 'Google App', 'Meta Ecomm', 'Meta Social', 'Meta App', 'Ukupno', 'Projekcija do kraja meseca', 'Podaci zaključno sa']
    const lines = [head.join(','), ...spend.map((s) => [esc(s.client_name), s.currency, s.google_regular, s.google_app, s.meta_ecomm, s.meta_social, s.meta_app, s.total, s.projected_total, s.data_date].join(','))]
    downloadText(`potrosnja-svi-klijenti_${month.slice(0, 7)}.csv`, lines.join('\r\n') + '\r\n')
  }

  // A recommendation worth acting on: more than 10% away from today's daily budget.
  const changed = (r: Row) => {
    const now = settings[r.campaign]?.daily_budget
    return r.network === 'google' && r.recommended_daily != null && now != null && Math.abs(Number(r.recommended_daily) / Number(now) - 1) > 0.1
  }

  const totals = useMemo(() => {
    const t: Record<string, { budget: number; spent: number; projected: number }> = {}
    for (const r of rows) {
      const x = (t[r.network] ??= { budget: 0, spent: 0, projected: 0 })
      x.budget += Number(r.monthly_budget ?? 0)
      x.spent += Number(r.spent_mtd)
      x.projected += Number(r.projected_month)
    }
    return t
  }, [rows])

  const inputCls = 'rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'
  const months = [-1, 0, 1].map(monthStart)

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Provera i optimizacija budžeta · samo predlozi i fajlovi za Editor</p>
          <h1 className="font-display mt-1 text-4xl font-medium">Budžeti</h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--color-ink-soft)]">
            Unesi mesečni budžet po kampanji; Brain popunjava potrošnju od 1. u mesecu i računa dnevni budžet da se ostatak potroši ravnomerno do kraja meseca.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div className="flex overflow-hidden rounded border border-[var(--color-line)]">
            {([['campaigns', 'Po kampanjama'], ['spend', 'Potrošnja svih klijenata']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setMode(k)} className={`px-3 py-1.5 ${mode === k ? 'bg-[var(--color-indigo)] text-white' : 'bg-white'}`}>{l}</button>
            ))}
          </div>
          {mode === 'campaigns' && (
            <label><span className="mb-1 block text-[var(--color-ink-soft)]">Klijent</span>
              <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={inputCls}>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select></label>
          )}
          <label><span className="mb-1 block text-[var(--color-ink-soft)]">Mesec</span>
            <select value={month} onChange={(e) => setMonth(e.target.value)} className={inputCls}>
              {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select></label>
        </div>
      </header>

      {message && (
        <p className={`mb-6 rounded px-4 py-2 text-sm ${message.kind === 'ok' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-red-50 text-[var(--color-rust)]'}`}>{message.text}</p>
      )}
      {loading && <p className="mb-4 text-sm text-[var(--color-ink-soft)]">Učitavam…</p>}

      {mode === 'campaigns' && !loading && (
        <>
          <section className="mb-6 grid grid-cols-2 gap-4 md:grid-cols-4">
            {(['google', 'meta'] as const).filter((n) => totals[n]).map((n) => (
              <div key={n} className="rounded border border-[var(--color-line)] bg-white p-4 md:col-span-2">
                <p className="text-xs text-[var(--color-ink-soft)]">{n === 'google' ? 'Google' : 'Meta'} · budžet / potrošeno / projekcija ({cur})</p>
                <p className="font-display mt-1 text-2xl">{n0(totals[n].budget)} / {n0(totals[n].spent)} / {n0(totals[n].projected)}</p>
              </div>
            ))}
          </section>
          <div className="mb-4 flex flex-wrap gap-2 text-sm">
            <button onClick={save} disabled={!dirty} className="rounded bg-[var(--color-indigo)] px-4 py-1.5 font-medium text-white disabled:opacity-40">Sačuvaj budžete{dirty ? ` (${dirty})` : ''}</button>
            <button onClick={copyPrevious} className="rounded border border-[var(--color-line)] bg-white px-4 py-1.5">Preuzmi budžete iz prošlog meseca</button>
            <button onClick={exportEditor} className="rounded border border-[var(--color-indigo)] px-4 py-1.5 text-[var(--color-indigo-dark)]">Google dnevni budžeti → Editor CSV</button>
            <button onClick={exportMeta} className="rounded border border-[var(--color-line)] bg-white px-4 py-1.5">Meta dnevni budžeti CSV</button>
          </div>
          {rows.length > 0 && (
            <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
              Potrošnja zaključno sa {rows[0].data_date}; do kraja meseca ostaje {rows[0].days_left} dana. Predlog dnevnog budžeta = (mesečni budžet − potrošeno) / preostali dani. ROAS 30d je referenca za tROAS; za sezonu niže potražnje ide nešto viši, za Black Friday nešto niži.
            </p>
          )}
          {(['google', 'meta'] as const).map((net) => {
            const list = rows.filter((r) => r.network === net)
            if (!list.length) return null
            return (
              <section key={net} className="mb-8 overflow-x-auto rounded border border-[var(--color-line)] bg-white">
                <table className="w-full text-xs">
                  <thead className="bg-[var(--color-paper)] text-left text-[var(--color-ink-soft)]">
                    <tr>
                      <th className="px-3 py-2">{net === 'google' ? 'Google kampanja' : 'Meta kampanja'}</th>
                      <th className="px-2 text-right">Mesečni budžet</th>
                      <th className="px-2 text-right">Potrošeno</th>
                      <th className="px-2 text-right">Ostalo</th>
                      {net === 'google' && <th className="px-2 text-right">Dnevni sada</th>}
                      <th className="px-2 text-right">Predlog dnevnog</th>
                      <th className="px-2 text-right">Prosek 7d</th>
                      <th className="px-2 text-right">Projekcija</th>
                      <th className="px-2 text-right">ROAS 30d</th>
                      {net === 'google' && <th className="px-2 text-right">tROAS sada</th>}
                      <th className="px-2 text-right">Konv. 30d</th>
                      <th className="px-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((r) => {
                      const k = key(r)
                      return (
                        <tr key={k} className="border-t border-[var(--color-line)]">
                          <td className="px-3 py-1.5">
                            {r.campaign}
                            {r.campaign_type && <span className="ml-1 text-[var(--color-ink-soft)]">· {r.campaign_type.toLowerCase().replace(/_/g, ' ')}</span>}
                          </td>
                          <td className="px-2 text-right">
                            <input value={edits[k] ?? (r.monthly_budget == null ? '' : String(r.monthly_budget))}
                              onChange={(e) => setEdits({ ...edits, [k]: e.target.value })}
                              className="w-24 rounded border border-[var(--color-line)] px-2 py-0.5 text-right" placeholder="—" />
                          </td>
                          <td className="px-2 text-right">{n0(r.spent_mtd)}</td>
                          <td className="px-2 text-right">{n0(r.remaining)}</td>
                          {net === 'google' && (
                            <td className="px-2 text-right">
                              {n2(settings[r.campaign]?.daily_budget)}
                              {settings[r.campaign]?.budget_shared && <span className="ml-1 text-[var(--color-ink-soft)]" title="Deljeni budžet">(deljen)</span>}
                            </td>
                          )}
                          <td className={`px-2 text-right font-medium ${changed(r) ? 'text-[var(--color-indigo-dark)]' : ''}`}>{n2(r.recommended_daily)}</td>
                          <td className="px-2 text-right">{n2(r.avg_daily_7d)}</td>
                          <td className="px-2 text-right">{n0(r.projected_month)}</td>
                          <td className="px-2 text-right" title={net === 'google' && TROAS_TYPES.includes(r.campaign_type ?? '') && r.roas_30d ? `tROAS referenca: ${Math.round(Number(r.roas_30d) * 100)}%` : undefined}>
                            {r.roas_30d == null ? '—' : `${n2(r.roas_30d)}`}
                          </td>
                          {net === 'google' && (
                            <td className="px-2 text-right" title={settings[r.campaign]?.bidding_strategy_type ?? undefined}>
                              {settings[r.campaign]?.target_roas != null ? `${Math.round(Number(settings[r.campaign]!.target_roas) * 100)}%`
                                : settings[r.campaign]?.target_cpa != null ? `tCPA ${n2(settings[r.campaign]!.target_cpa)}` : '—'}
                            </td>
                          )}
                          <td className="px-2 text-right">{n0(r.conversions_30d)}</td>
                          <td className="px-2"><span className={`rounded px-2 py-0.5 ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </section>
            )
          })}
          {!rows.length && <p className="text-sm text-[var(--color-ink-soft)]">Nema kampanja sa potrošnjom u ovom mesecu.</p>}
        </>
      )}

      {mode === 'spend' && !loading && (
        <>
          <div className="mb-4 flex items-center gap-3 text-sm">
            <button onClick={exportSpend} disabled={!spend.length} className="rounded bg-[var(--color-indigo)] px-4 py-1.5 font-medium text-white disabled:opacity-40">Preuzmi CSV</button>
            <span className="text-xs text-[var(--color-ink-soft)]">Podela kao u tabeli za Dubravka: Meta Social (kampanje Social_…), Meta App, Meta Ecomm (ostalo); Google App i Regular. Iznosi su u valuti naloga.</span>
          </div>
          <section className="overflow-x-auto rounded border border-[var(--color-line)] bg-white">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-paper)] text-left text-[var(--color-ink-soft)]">
                <tr>
                  <th className="px-3 py-2">Klijent</th>
                  {['Google Regular', 'Google App', 'Meta Ecomm', 'Meta Social', 'Meta App', 'Ukupno', 'Projekcija meseca'].map((h) => <th key={h} className="px-2 text-right">{h}</th>)}
                  <th className="px-2">Zaključno sa</th>
                </tr>
              </thead>
              <tbody>
                {spend.map((s) => (
                  <tr key={s.client_id} className="border-t border-[var(--color-line)]">
                    <td className="px-3 py-1.5">{s.client_name} <span className="text-[var(--color-ink-soft)]">· {s.currency}</span></td>
                    {[s.google_regular, s.google_app, s.meta_ecomm, s.meta_social, s.meta_app].map((v, i) => <td key={i} className="px-2 text-right">{n0(v)}</td>)}
                    <td className="px-2 text-right font-medium">{n0(s.total)}</td>
                    <td className="px-2 text-right">{s.days_left > 0 ? n0(s.projected_total) : '—'}</td>
                    <td className="px-2">{s.data_date}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  )
}
