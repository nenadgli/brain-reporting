import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

type Proposal = {
  id: string
  client_id: string
  month: string
  title: string
  assumption: string | null
  summary: string[]
  checks: { text: string; done: boolean }[]
  status: string
  clients: { name: string } | null
}

type Line = {
  id: string
  sort: number
  network: string
  flight_type: string | null
  ad_set_type: string | null
  campaign_label: string
  start_date: string | null
  end_date: string | null
  last_year_spend: number | null
  proposed_budget: number
  rationale: string | null
}

type HistoryRow = {
  month: string
  network: string
  channel: string | null
  campaign_label: string | null
  start_date: string | null
  end_date: string | null
  reported_spend: number | null
  reported_revenue: number | null
}

const MONTH_NAMES = ['Januar', 'Februar', 'Mart', 'April', 'Maj', 'Jun', 'Jul', 'Avgust', 'Septembar', 'Oktobar', 'Novembar', 'Decembar']
const NETWORK_LABEL: Record<string, string> = { google: 'Google Ads', meta: 'Meta Ads', programmatic: 'Programmatic', tiktok: 'TikTok' }
const NETWORK_ORDER = ['google', 'meta', 'programmatic', 'tiktok']

const fmtInt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmtRoas = (n: number) => n.toLocaleString('sr-RS', { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const monthLabel = (m: string) => `${MONTH_NAMES[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`
const shortDate = (d: string) => `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.`
const dateRange = (s: string | null, e: string | null) => (!s ? '—' : !e || s === e ? shortDate(s) : `${shortDate(s)} – ${shortDate(e)}`)

function roasColor(roas: number): string {
  if (roas < 2) return 'var(--color-rust)'
  if (roas >= 15) return 'var(--color-indigo-dark)'
  return 'var(--color-ink)'
}

export default function PlanProposal() {
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [proposalId, setProposalId] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [history, setHistory] = useState<HistoryRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [transferring, setTransferring] = useState(false)

  useEffect(() => {
    supabase
      .from('media_plan_proposals')
      .select('id, client_id, month, title, assumption, summary, checks, status, clients(name)')
      .order('month', { ascending: false })
      .then(({ data, error: err }) => {
        if (err) {
          setError('Nije moguće učitati predloge.')
          setLoading(false)
          return
        }
        const list = (data ?? []) as unknown as Proposal[]
        setProposals(list)
        if (list.length > 0) setProposalId(list[0].id)
        else setLoading(false)
      })
  }, [])

  const proposal = proposals.find((p) => p.id === proposalId) ?? null

  useEffect(() => {
    if (!proposal) return
    async function load(p: Proposal) {
      setLoading(true)
      setError(null)
      // The same calendar month in the two previous years, for comparison.
      const y = Number(p.month.slice(0, 4))
      const mm = p.month.slice(5)
      const prevMonths = [`${y - 1}-${mm}`, `${y - 2}-${mm}`]
      const [lRes, hRes] = await Promise.all([
        supabase.from('media_plan_proposal_lines').select('*').eq('proposal_id', p.id).order('sort'),
        supabase
          .from('media_plan_history')
          .select('month, network, channel, campaign_label, start_date, end_date, reported_spend, reported_revenue')
          .eq('client_id', p.client_id)
          .eq('section', 'ecomm')
          .in('month', prevMonths)
          .gt('reported_spend', 0),
      ])
      if (lRes.error || hRes.error) {
        setError('Nije moguće učitati linije predloga.')
        setLoading(false)
        return
      }
      setLines((lRes.data ?? []) as Line[])
      setHistory((hRes.data ?? []) as HistoryRow[])
      setLoading(false)
    }
    load(proposal)
  }, [proposalId])

  const totals = useMemo(() => {
    const byNetwork: Record<string, { proposed: number; lastYear: number }> = {}
    for (const l of lines) {
      const t = (byNetwork[l.network] ??= { proposed: 0, lastYear: 0 })
      t.proposed += Number(l.proposed_budget) || 0
      t.lastYear += Number(l.last_year_spend) || 0
    }
    const all = Object.values(byNetwork).reduce((a, t) => ({ proposed: a.proposed + t.proposed, lastYear: a.lastYear + t.lastYear }), { proposed: 0, lastYear: 0 })
    return { byNetwork, all }
  }, [lines])

  const historyByMonth = useMemo(() => {
    const groups: Record<string, HistoryRow[]> = {}
    for (const h of history) (groups[h.month] ??= []).push(h)
    for (const k of Object.keys(groups)) groups[k].sort((a, b) => (Number(b.reported_spend) || 0) - (Number(a.reported_spend) || 0))
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a))
  }, [history])

  async function saveBudget(line: Line, value: string) {
    const n = Number(value.replace(/\./g, '').replace(',', '.'))
    if (!Number.isFinite(n) || n < 0 || n === Number(line.proposed_budget)) return
    const { error: err } = await supabase.from('media_plan_proposal_lines').update({ proposed_budget: n }).eq('id', line.id)
    if (err) {
      setMessage({ kind: 'err', text: `Budžet nije sačuvan: ${err.message}` })
      return
    }
    setLines((prev) => prev.map((l) => (l.id === line.id ? { ...l, proposed_budget: n } : l)))
  }

  async function toggleCheck(index: number) {
    if (!proposal) return
    const checks = proposal.checks.map((c, i) => (i === index ? { ...c, done: !c.done } : c))
    const { error: err } = await supabase.from('media_plan_proposals').update({ checks }).eq('id', proposal.id)
    if (err) {
      setMessage({ kind: 'err', text: `Promena nije sačuvana: ${err.message}` })
      return
    }
    setProposals((prev) => prev.map((p) => (p.id === proposal.id ? { ...p, checks } : p)))
  }

  // Copies the dated Meta/Google lines into media_plan_lines, so Budget Pacing tracks the month.
  async function transferToMediaPlan() {
    if (!proposal) return
    const rows = lines
      .filter((l) => (l.network === 'meta' || l.network === 'google') && l.start_date && Number(l.proposed_budget) > 0)
      .map((l) => ({
        client_id: proposal.client_id,
        month: proposal.month,
        network: l.network,
        flight_type: l.flight_type,
        ad_set_type: l.ad_set_type,
        campaign_label: l.campaign_label,
        start_date: l.start_date,
        end_date: l.end_date,
        budget_regular: Number(l.proposed_budget),
        budget_flash: 0,
        budget_total: Number(l.proposed_budget),
      }))
    const { count } = await supabase
      .from('media_plan_lines')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', proposal.client_id)
      .eq('month', proposal.month)
    const ask =
      count && count > 0
        ? `Za ${monthLabel(proposal.month)} već postoji media plan (${count} linija). Zameniti ga sa ${rows.length} linija iz predloga?`
        : `Prebaciti ${rows.length} Meta i Google linija u media plan za ${monthLabel(proposal.month)}?`
    if (!window.confirm(ask)) return
    setTransferring(true)
    setMessage(null)
    try {
      if (count && count > 0) {
        const { error: delErr } = await supabase.from('media_plan_lines').delete().eq('client_id', proposal.client_id).eq('month', proposal.month)
        if (delErr) throw delErr
      }
      const { error: insErr } = await supabase.from('media_plan_lines').insert(rows)
      if (insErr) throw insErr
      await supabase.from('media_plan_proposals').update({ status: 'prebačen u plan' }).eq('id', proposal.id)
      setProposals((prev) => prev.map((p) => (p.id === proposal.id ? { ...p, status: 'prebačen u plan' } : p)))
      setMessage({ kind: 'ok', text: `Prebačeno ${rows.length} linija. Budget Pacing sada prati ${monthLabel(proposal.month)}.` })
    } catch (e) {
      setMessage({ kind: 'err', text: `Prebacivanje nije uspelo: ${(e as Error).message}` })
    } finally {
      setTransferring(false)
    }
  }

  if (error) return <p className="text-[var(--color-rust)]">{error}</p>
  if (!loading && proposals.length === 0) return <p className="text-sm text-[var(--color-ink-soft)]">Još nema predloga media plana.</p>

  const prevYearLabel = proposal ? monthLabel(`${Number(proposal.month.slice(0, 4)) - 1}${proposal.month.slice(4)}`) : ''

  return (
    <div>
      <header className="mb-8 flex items-end justify-between border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Predlog media plana &middot; iz istorije planova i Windsor podataka</p>
          <h1 className="font-display mt-1 text-4xl font-medium">{proposal?.clients?.name ?? '…'}</h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">
            {proposal ? `${proposal.title} · status: ${proposal.status}` : 'Učitavanje…'}
          </p>
        </div>
        {proposals.length > 1 && (
          <label className="text-sm">
            <span className="mr-2 text-[var(--color-ink-soft)]">Predlog</span>
            <select value={proposalId} onChange={(e) => setProposalId(e.target.value)} className="rounded border border-[var(--color-line)] bg-white px-3 py-1.5">
              {proposals.map((p) => (
                <option key={p.id} value={p.id}>{`${p.clients?.name ?? ''} · ${monthLabel(p.month)}`}</option>
              ))}
            </select>
          </label>
        )}
      </header>

      {message && (
        <p className={`mb-6 rounded px-4 py-2 text-sm ${message.kind === 'ok' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-red-50 text-[var(--color-rust)]'}`}>
          {message.text}
        </p>
      )}

      {!loading && proposal && (
        <>
          <section className="mb-10 grid grid-cols-5 gap-3">
            <div className="kpi-card kpi-dark">
              <p className="kpi-label">Ukupno</p>
              <p className="kpi-value">{fmtInt(totals.all.proposed)}</p>
            </div>
            {NETWORK_ORDER.map((n) => (
              <div key={n} className="kpi-card">
                <p className="kpi-label">{NETWORK_LABEL[n]}</p>
                <p className="kpi-value">{fmtInt(totals.byNetwork[n]?.proposed ?? 0)}</p>
              </div>
            ))}
          </section>

          <section className="mb-10">
            <h2 className="font-display mb-3 text-lg font-medium">Sažetak</h2>
            <ul className="list-disc space-y-2 pl-5 text-sm">
              {proposal.summary.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
            {proposal.assumption && <p className="mt-3 text-xs text-[var(--color-ink-soft)]">{proposal.assumption}</p>}
          </section>

          <section className="mb-10">
            <div className="mb-3 flex items-end justify-between">
              <h2 className="font-display text-lg font-medium">Raspodela budžeta</h2>
              <button
                type="button"
                onClick={transferToMediaPlan}
                disabled={transferring}
                className="rounded bg-[var(--color-indigo)] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              >
                {transferring ? 'Prebacujem…' : 'Prebaci u media plan'}
              </button>
            </div>
            <p className="mb-3 text-xs text-[var(--color-ink-soft)]">
              Budžet u koloni „Predlog“ možeš da menjaš direktno, a čuva se kad napustiš polje. „{prevYearLabel}“ je stvarna potrošnja iz PPC izveštaja.
            </p>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                  <th className="py-2 pr-3 font-normal">Linija</th>
                  <th className="py-2 pr-3 font-normal">Datumi</th>
                  <th className="py-2 pr-3 text-right font-normal">{prevYearLabel}</th>
                  <th className="py-2 pr-3 text-right font-normal">Predlog</th>
                  <th className="py-2 pr-3 text-right font-normal">Promena</th>
                  <th className="py-2 font-normal">Obrazloženje</th>
                </tr>
              </thead>
              <tbody>
                {NETWORK_ORDER.filter((n) => totals.byNetwork[n]).map((n) => {
                  const t = totals.byNetwork[n]
                  return [
                    <tr key={`h-${n}`} className="border-b border-[var(--color-line)] bg-slate-50">
                      <td className="py-2 pr-3 font-medium" colSpan={2}>{NETWORK_LABEL[n]}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(t.lastYear)}</td>
                      <td className="py-2 pr-3 text-right font-mono font-medium">{fmtInt(t.proposed)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtDelta(t.proposed - t.lastYear)}</td>
                      <td />
                    </tr>,
                    ...lines
                      .filter((l) => l.network === n)
                      .map((l) => {
                        const delta = Number(l.proposed_budget) - (Number(l.last_year_spend) || 0)
                        return (
                          <tr key={l.id} className="border-b border-[var(--color-line)]">
                            <td className="py-2 pr-3">{l.campaign_label}</td>
                            <td className="whitespace-nowrap py-2 pr-3 text-[var(--color-ink-soft)]">{dateRange(l.start_date, l.end_date)}</td>
                            <td className="py-2 pr-3 text-right font-mono text-[var(--color-ink-soft)]">{l.last_year_spend != null ? fmtInt(Number(l.last_year_spend)) : '—'}</td>
                            <td className="py-2 pr-3 text-right">
                              <input
                                key={`${l.id}-${l.proposed_budget}`}
                                defaultValue={fmtInt(Number(l.proposed_budget))}
                                onBlur={(e) => saveBudget(l, e.target.value)}
                                inputMode="numeric"
                                className="w-24 rounded border border-[var(--color-line)] px-2 py-1 text-right font-mono"
                              />
                            </td>
                            <td className="py-2 pr-3 text-right font-mono" style={{ color: delta < 0 ? 'var(--color-rust)' : delta > 0 ? 'var(--color-indigo-dark)' : undefined }}>
                              {fmtDelta(delta)}
                            </td>
                            <td className="py-2 text-xs text-[var(--color-ink-soft)]">{l.rationale ?? ''}</td>
                          </tr>
                        )
                      }),
                  ]
                })}
                <tr className="border-t-2 border-[var(--color-ink)] font-medium">
                  <td className="py-2 pr-3" colSpan={2}>Ukupno</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmtInt(totals.all.lastYear)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmtInt(totals.all.proposed)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmtDelta(totals.all.proposed - totals.all.lastYear)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </section>

          {proposal.checks.length > 0 && (
            <section className="mb-10">
              <h2 className="font-display mb-3 text-lg font-medium">Pre puštanja</h2>
              <ul className="space-y-2 text-sm">
                {proposal.checks.map((c, i) => (
                  <li key={i}>
                    <label className="flex cursor-pointer items-start gap-2">
                      <input type="checkbox" checked={c.done} onChange={() => toggleCheck(i)} className="mt-1" />
                      <span className={c.done ? 'text-[var(--color-ink-soft)] line-through' : ''}>{c.text}</span>
                    </label>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mb-10">
            <h2 className="font-display mb-1 text-lg font-medium">Isti mesec prethodnih godina</h2>
            <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
              Ecomm linije iz media plana sa rezultatima koje je PPC tim upisao. ROAS = prihod / potrošnja; crveno ispod 2, zeleno od 15 naviše.
            </p>
            {historyByMonth.length === 0 && <p className="text-sm text-[var(--color-ink-soft)]">Nema istorije za ovaj mesec.</p>}
            {historyByMonth.map(([m, rows]) => {
              const spend = rows.reduce((s, r) => s + (Number(r.reported_spend) || 0), 0)
              const rev = rows.reduce((s, r) => s + (Number(r.reported_revenue) || 0), 0)
              return (
                <details key={m} className="mb-4 rounded border border-[var(--color-line)] bg-white">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
                    {monthLabel(m)} · potrošnja {fmtInt(spend)} · prihod {fmtInt(rev)} · ROAS {spend > 0 ? fmtRoas(rev / spend) : '—'}
                  </summary>
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                        <th className="px-4 py-2 font-normal">Mreža</th>
                        <th className="py-2 pr-3 font-normal">Linija</th>
                        <th className="py-2 pr-3 font-normal">Datumi</th>
                        <th className="py-2 pr-3 text-right font-normal">Potrošnja</th>
                        <th className="py-2 pr-3 text-right font-normal">Prihod</th>
                        <th className="py-2 pr-4 text-right font-normal">ROAS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const s = Number(r.reported_spend) || 0
                        const v = Number(r.reported_revenue) || 0
                        const roas = s > 0 ? v / s : 0
                        return (
                          <tr key={i} className="border-b border-[var(--color-line)]">
                            <td className="px-4 py-2 text-[var(--color-ink-soft)]">{r.channel ?? NETWORK_LABEL[r.network] ?? r.network}</td>
                            <td className="py-2 pr-3">{r.campaign_label ?? '—'}</td>
                            <td className="whitespace-nowrap py-2 pr-3 text-[var(--color-ink-soft)]">{dateRange(r.start_date, r.end_date)}</td>
                            <td className="py-2 pr-3 text-right font-mono">{fmtInt(s)}</td>
                            <td className="py-2 pr-3 text-right font-mono">{fmtInt(v)}</td>
                            <td className="py-2 pr-4 text-right font-mono font-medium" style={{ color: roasColor(roas) }}>{fmtRoas(roas)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </details>
              )
            })}
          </section>
        </>
      )}
    </div>
  )
}

function fmtDelta(n: number): string {
  if (Math.abs(n) < 0.5) return '0'
  return `${n > 0 ? '+' : '−'}${fmtInt(Math.abs(n))}`
}
