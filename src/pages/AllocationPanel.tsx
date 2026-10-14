import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { logAction } from '../lib/ppcTasks'

// "Mesečna alokacija budžeta": Brain proposes next month's budget per campaign from the month's
// total (media plan, last approved allocation or recent spend) and the last 30 days' results.
// The team edits amounts, approves, and the approved amounts become that month's campaign budgets.

type Net = 'google' | 'meta'
type Line = {
  network: Net; campaign: string; campaign_type: string | null
  spend_30d: number; spend_last_month: number; spend_ly_month: number; roas_30d: number | null; cpa_30d: number | null
  conversions_30d: number; lost_is_budget_pct: number | null; daily_budget_now: number | null
  base: number; proposed: number; proposed_daily: number; change_pct: number | null; reason: string; why: string
}
type Proposal = { id: string; month: string; totals: Partial<Record<Net, number>>; lines: Line[]; summary: string | null; status: 'draft' | 'approved' | 'rejected'; created_at: string; approved_at: string | null }
type TotalSource = { amount: number; source: 'media_plan' | 'prethodna_alokacija' | 'potrosnja_30d' }

const SOURCE_LABEL: Record<TotalSource['source'], string> = {
  media_plan: 'iz media plana', prethodna_alokacija: 'iz prošle odobrene alokacije', potrosnja_30d: 'potrošnja poslednjih 30 dana',
}
const REASON_LABEL: Record<string, string> = {
  ne_trosi: 'ne troši', ograniceno_budzetom: 'ograničeno budžetom', jak_roas: 'jak ROAS', slab_roas: 'slab ROAS',
  bez_konverzija: 'bez konverzija', gornji_levak: 'doseg', brend: 'brend', stabilno: 'stabilno',
}
const n0 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('sr-RS', { maximumFractionDigits: 0 }))
const n2 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('sr-RS', { maximumFractionDigits: 2 }))
const parse = (s: string) => Number(s.replace(/\s/g, '').replace(',', '.'))
const daysIn = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()
const lineKey = (l: Pick<Line, 'network' | 'campaign'>) => `${l.network}|${l.campaign}`

export default function AllocationPanel({ clientId, month, monthLabel, cur }: { clientId: string; month: string; monthLabel: string; cur: string }) {
  const [totals, setTotals] = useState<Record<Net, string>>({ google: '', meta: '' })
  const [sources, setSources] = useState<Partial<Record<Net, TotalSource>>>({})
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<'' | 'load' | 'propose' | 'approve'>('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  function show(p: Proposal | null) {
    setProposal(p)
    setAmounts(p ? Object.fromEntries(p.lines.map((l) => [lineKey(l), String(l.proposed)])) : {})
  }

  useEffect(() => {
    if (!clientId) return
    let alive = true
    setBusy('load'); setMessage(null); show(null)
    Promise.all([
      supabase.functions.invoke('budget-allocation', { body: { action: 'inputs', client_id: clientId, month } }),
      supabase.from('allocation_proposals').select('id, month, totals, lines, summary, status, created_at, approved_at')
        .eq('client_id', clientId).eq('month', month).neq('status', 'rejected').order('created_at', { ascending: false }).limit(1),
    ]).then(([inp, prev]) => {
      if (!alive) return
      setBusy('')
      if (inp.error || inp.data?.error) { setMessage({ kind: 'err', text: inp.data?.error ?? inp.error?.message ?? 'Greška' }); return }
      const t = (inp.data?.totals ?? {}) as Partial<Record<Net, TotalSource>>
      setSources(t)
      const p = (prev.data?.[0] ?? null) as Proposal | null
      setTotals({
        google: String(p?.totals.google ?? t.google?.amount ?? ''),
        meta: String(p?.totals.meta ?? t.meta?.amount ?? ''),
      })
      show(p)
    })
    return () => { alive = false }
  }, [clientId, month])

  async function propose() {
    const body = { action: 'propose', client_id: clientId, month, totals: { google: parse(totals.google) || 0, meta: parse(totals.meta) || 0 } }
    setBusy('propose'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('budget-allocation', { body })
    setBusy('')
    if (error || data?.error) { setMessage({ kind: 'err', text: data?.error ?? error?.message ?? 'Greška' }); return }
    show({ id: data.id, month, totals: data.totals, lines: data.lines, summary: data.summary, status: 'draft', created_at: data.created_at, approved_at: null })
    logAction(clientId, 'alokacija_budzeta', 'nacrt', `Predlog raspodele za ${monthLabel}`)
  }

  const sums = useMemo(() => {
    const s: Partial<Record<Net, number>> = {}
    for (const l of proposal?.lines ?? []) s[l.network] = (s[l.network] ?? 0) + (parse(amounts[lineKey(l)] ?? '0') || 0)
    return s
  }, [proposal, amounts])

  async function approve() {
    if (!proposal) return
    const lines: Line[] = []
    for (const l of proposal.lines) {
      const v = parse(amounts[lineKey(l)] ?? '')
      if (!Number.isFinite(v) || v < 0) { setMessage({ kind: 'err', text: `Neispravan iznos za ${l.campaign}` }); return }
      lines.push({ ...l, proposed: v, proposed_daily: Math.round(v / daysIn(month) * 100) / 100 })
    }
    setBusy('approve'); setMessage(null)
    const now = new Date().toISOString()
    const budgets = lines.filter((l) => l.proposed > 0).map((l) => ({
      client_id: clientId, month, network: l.network, campaign: l.campaign, monthly_budget: l.proposed, note: 'Mesečna alokacija', updated_at: now,
    }))
    const { error: be } = await supabase.from('campaign_budgets').upsert(budgets, { onConflict: 'client_id,month,network,campaign' })
    if (be) { setBusy(''); setMessage({ kind: 'err', text: be.message }); return }
    const { data: u } = await supabase.auth.getUser()
    const newTotals = Object.fromEntries(Object.entries(sums).map(([k, v]) => [k, Math.round(Number(v) * 100) / 100]))
    const { error } = await supabase.from('allocation_proposals')
      .update({ lines, totals: newTotals, status: 'approved', approved_by: u.user?.id ?? null, approved_at: now }).eq('id', proposal.id)
    setBusy('')
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    const edited = proposal.lines.filter((l, i) => l.proposed !== lines[i].proposed).length
    logAction(clientId, 'alokacija_budzeta', 'odobreno', `Raspodela za ${monthLabel}: ${budgets.length} kampanja${edited ? `, ${edited} ručno izmenjeno` : ''}`)
    setProposal({ ...proposal, lines, totals: newTotals, status: 'approved', approved_at: now })
    setMessage({ kind: 'ok', text: `Odobreno; ${budgets.length} mesečnih budžeta upisano za ${monthLabel}. Dnevne budžete i Editor CSV vidiš u „Po kampanjama“ za taj mesec.` })
  }

  async function reject() {
    if (!proposal) return
    const { error } = await supabase.from('allocation_proposals').update({ status: 'rejected' }).eq('id', proposal.id)
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    logAction(clientId, 'alokacija_budzeta', 'odbijeno', `Predlog raspodele za ${monthLabel}`)
    show(null)
  }

  const inputCls = 'w-32 rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-right text-sm'
  const approved = proposal?.status === 'approved'

  return (
    <div>
      <section className="mb-6 rounded border border-[var(--color-line)] bg-white p-4">
        <p className="mb-3 text-sm text-[var(--color-ink-soft)]">
          Ukupan budžet za {monthLabel} po mreži ({cur}). Brain deli iznos po kampanjama prema potrošnji i rezultatima poslednjih 30 dana; iznose možeš da menjaš pre odobravanja. Ništa se ne menja u nalogu.
        </p>
        <div className="flex flex-wrap items-end gap-4 text-sm">
          {(['google', 'meta'] as const).map((n) => (
            <label key={n}>
              <span className="mb-1 block text-[var(--color-ink-soft)]">{n === 'google' ? 'Google' : 'Meta'}{sources[n] ? ` · ${SOURCE_LABEL[sources[n]!.source]}` : ''}</span>
              <input value={totals[n]} onChange={(e) => setTotals({ ...totals, [n]: e.target.value })} className={inputCls} placeholder="0" />
            </label>
          ))}
          <button onClick={propose} disabled={!!busy} className="rounded bg-[var(--color-indigo)] px-4 py-1.5 font-medium text-white disabled:opacity-40">
            {busy === 'propose' ? 'Računam…' : proposal ? 'Predloži ponovo' : 'Predloži raspodelu'}
          </button>
        </div>
      </section>

      {message && (
        <p className={`mb-6 rounded px-4 py-2 text-sm ${message.kind === 'ok' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-red-50 text-[var(--color-rust)]'}`}>{message.text}</p>
      )}
      {busy === 'load' && <p className="mb-4 text-sm text-[var(--color-ink-soft)]">Učitavam…</p>}

      {proposal && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3 text-sm">
            <span className={`rounded px-2 py-0.5 text-xs ${approved ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-amber-50 text-amber-800'}`}>
              {approved ? `odobreno ${new Date(proposal.approved_at!).toLocaleDateString('sr-Latn-RS')}` : 'nacrt'}
            </span>
            {!approved && (
              <>
                <button onClick={approve} disabled={!!busy} className="rounded bg-[var(--color-indigo)] px-4 py-1.5 font-medium text-white disabled:opacity-40">
                  {busy === 'approve' ? 'Upisujem…' : 'Odobri i upiši u Budžete'}
                </button>
                <button onClick={reject} disabled={!!busy} className="rounded border border-[var(--color-line)] bg-white px-4 py-1.5">Odbaci</button>
              </>
            )}
          </div>
          {proposal.summary && <p className="mb-6 max-w-3xl text-sm">{proposal.summary}</p>}

          {(['google', 'meta'] as const).map((net) => {
            const list = proposal.lines.filter((l) => l.network === net)
            if (!list.length) return null
            const target = Number(proposal.totals[net] ?? 0)
            const diff = Math.round(((sums[net] ?? 0) - target) * 100) / 100
            return (
              <section key={net} className="mb-8">
                <p className="mb-2 text-sm">
                  <span className="font-medium">{net === 'google' ? 'Google' : 'Meta'}</span> · ukupno {n0(sums[net])} {cur}
                  {!approved && diff !== 0 && <span className="ml-2 rounded bg-amber-50 px-2 py-0.5 text-xs text-amber-800">{diff > 0 ? '+' : ''}{n2(diff)} u odnosu na {n0(target)}</span>}
                </p>
                <div className="overflow-x-auto rounded border border-[var(--color-line)] bg-white">
                  <table className="w-full text-xs">
                    <thead className="bg-[var(--color-paper)] text-left text-[var(--color-ink-soft)]">
                      <tr>
                        <th className="px-3 py-2">Kampanja</th>
                        <th className="px-2 text-right">Potrošnja 30d</th>
                        <th className="px-2 text-right">Isti mesec lani</th>
                        <th className="px-2 text-right">ROAS 30d</th>
                        <th className="px-2 text-right">CPA 30d</th>
                        {net === 'google' && <th className="px-2 text-right">Izgubljeno (budžet)</th>}
                        {net === 'google' && <th className="px-2 text-right">Dnevni sada</th>}
                        <th className="px-2 text-right">Predlog za mesec</th>
                        <th className="px-2 text-right">Dnevno</th>
                        <th className="px-2 text-right">Promena</th>
                        <th className="px-2">Zašto</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((l) => {
                        const k = lineKey(l)
                        const v = parse(amounts[k] ?? '0') || 0
                        return (
                          <tr key={k} className={`border-t border-[var(--color-line)] ${l.reason === 'ne_trosi' ? 'text-[var(--color-ink-soft)]' : ''}`}>
                            <td className="px-3 py-1.5">
                              {l.campaign}
                              {l.campaign_type && <span className="ml-1 text-[var(--color-ink-soft)]">· {l.campaign_type.toLowerCase().replace(/_/g, ' ')}</span>}
                            </td>
                            <td className="px-2 text-right">{n0(l.spend_30d)}</td>
                            <td className="px-2 text-right">{l.spend_ly_month ? n0(l.spend_ly_month) : '—'}</td>
                            <td className="px-2 text-right">{n2(l.roas_30d)}</td>
                            <td className="px-2 text-right">{n2(l.cpa_30d)}</td>
                            {net === 'google' && <td className="px-2 text-right">{l.lost_is_budget_pct == null ? '—' : `${l.lost_is_budget_pct}%`}</td>}
                            {net === 'google' && <td className="px-2 text-right">{n2(l.daily_budget_now)}</td>}
                            <td className="px-2 text-right">
                              {approved ? <span className="font-medium">{n0(l.proposed)}</span> : (
                                <input value={amounts[k] ?? ''} onChange={(e) => setAmounts({ ...amounts, [k]: e.target.value })}
                                  className="w-24 rounded border border-[var(--color-line)] px-2 py-0.5 text-right" />
                              )}
                            </td>
                            <td className="px-2 text-right">{n2(Math.round(v / daysIn(month) * 100) / 100)}</td>
                            <td className="px-2 text-right">{l.base > 0 ? `${Math.round((v / l.base - 1) * 100)}%` : '—'}</td>
                            <td className="px-2">
                              <span className="mr-1 rounded bg-[var(--color-paper)] px-1.5 py-0.5">{REASON_LABEL[l.reason] ?? l.reason}</span>
                              {l.why}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            )
          })}
          <p className="text-xs text-[var(--color-ink-soft)]">
            Promena je u odnosu na dosadašnju potrošnju svedenu na mesec (pola poslednjih 30, pola poslednjih 7 dana). ROAS se poredi sa prosekom istog tipa kampanja, bez brend kampanja. Pravila: kampanje koje ne troše 7 dana dobijaju 0; ROAS 30% iznad proseka +10% (+20% ako Search gubi bar 10% prikazivanja zbog budžeta); ROAS ispod pola proseka −20%; bez konverzija −30%; brend i kampanje za doseg prate potrošnju. Akcije iz Productive-a za mesec dodaj ručno.
          </p>
        </>
      )}
    </div>
  )
}
