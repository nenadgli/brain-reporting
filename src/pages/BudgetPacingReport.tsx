import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const AD_SET_LABEL: Record<string, string> = {
  SEARCH: 'Search',
  DISPLAY: 'Display',
  PERFORMANCE_MAX: 'Performance Max',
  DEMAND_GEN: 'Demand Gen',
}
const BUCKET_LABEL: Record<string, string> = { Ecomm: 'Ecomm (glavni budžet)', Loyalty: 'Loyalty (App Install)', Social: 'Social (brand awareness)' }

const fmtEUR = (n: number) => `€${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtPct = (n: number) => `${n.toLocaleString('sr-RS', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`

type GoogleRow = { ad_set_type: string | null; campaign_label: string; start_date: string; end_date: string; budget_total: number; actual_spend: number; days_total: number; days_elapsed: number; pct_time_elapsed: number }
type MetaRow = { bucket: string; budget_planned: number; actual_spend: number }

const MONTH_NAMES = ['januar', 'februar', 'mart', 'april', 'maj', 'jun', 'jul', 'avgust', 'septembar', 'oktobar', 'novembar', 'decembar']

function paceStatus(pctSpent: number, pctTime: number): { label: string; color: string } {
  if (pctTime >= 99.5) {
    if (pctSpent > 110) return { label: 'Prekoračen budžet', color: 'var(--color-rust)' }
    if (pctSpent < 90) return { label: 'Nedotrošen budžet', color: '#c9a227' }
    return { label: 'U okviru plana', color: 'var(--color-indigo)' }
  }
  const ratio = pctTime > 0 ? pctSpent / pctTime : 0
  if (ratio > 1.15) return { label: 'Troši brže od plana', color: 'var(--color-rust)' }
  if (ratio < 0.85) return { label: 'Troši sporije od plana', color: '#c9a227' }
  return { label: 'Na tragu plana', color: 'var(--color-indigo)' }
}

export default function BudgetPacingReport() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [monthValue] = useState('2026-08')
  const [googleRows, setGoogleRows] = useState<GoogleRow[]>([])
  const [metaRows, setMetaRows] = useState<MetaRow[]>([])

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)
      const monthStart = `${monthValue}-01`
      const [gRes, mRes] = await Promise.all([
        supabase.rpc('fashion_rs_google_pacing', { p_month: monthStart }),
        supabase.rpc('fashion_rs_meta_pacing', { p_month: monthStart }),
      ])
      if (gRes.error || mRes.error) {
        setError('Nije moguće učitati podatke o budžetu. Da li je media plan uvezen za ovaj mesec?')
        setLoading(false)
        return
      }
      setGoogleRows(gRes.data ?? [])
      setMetaRows(mRes.data ?? [])
      setLoading(false)
    }
    load()
  }, [monthValue])

  const [y, m] = monthValue.split('-').map(Number)
  const monthLabel = `${MONTH_NAMES[m - 1]} ${y}`

  const googleTotals = useMemo(
    () => googleRows.reduce((acc, r) => ({ budget: acc.budget + r.budget_total, actual: acc.actual + r.actual_spend }), { budget: 0, actual: 0 }),
    [googleRows]
  )
  const metaEcomm = metaRows.find((r) => r.bucket === 'Ecomm')

  if (error) return <p className="text-[var(--color-rust)]">{error}</p>
  if (loading) return <p className="text-[var(--color-ink-soft)]">Učitavanje…</p>

  return (
    <div>
      <header className="mb-8 border-b border-[var(--color-line)] pb-6">
        <p className="eyebrow-label">Praćenje budžeta naspram media plana</p>
        <h1 className="font-display mt-1 text-4xl font-medium">Fashion&amp;Friends RS</h1>
        <p className="mt-2 text-[var(--color-ink-soft)]">Period: {monthLabel} &middot; planirano vs. stvarno potrošeno</p>
      </header>

      <section className="mb-8 rounded border border-[var(--color-line)] bg-[var(--color-indigo-soft)] p-4 text-xs text-[var(--color-ink-soft)]">
        <strong>Google Ads</strong> je prikazan po flajtu (tip kampanje + period) — pouzdano, bez preklapanja.{' '}
        <strong>Meta Ads</strong> je prikazan samo na nivou celog meseca po budžetskom rasponu (Ecomm/Loyalty/Social) — flajt-po-flajt praćenje
        za Meta trenutno nije pouzdano jer se kampanje sa različitim planiranim periodima preklapaju u istom danu i ne mogu se automatski
        razdvojiti iz podataka koje sinhronizujemo. Ako nam pošalješ mapiranje flajt-imena na stvarne nazive Meta kampanja, mogu to da
        popravim.
      </section>

      {/* Google Ads pacing */}
      <section className="mb-10">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-medium">Google Ads &mdash; po flajtu</h2>
          <p className="text-sm text-[var(--color-ink-soft)]">
            Ukupno: {fmtEUR(googleTotals.actual)} / {fmtEUR(googleTotals.budget)} planirano ({fmtPct((googleTotals.actual / googleTotals.budget) * 100)})
          </p>
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
              <th className="py-2 pr-3 font-normal">Flajt</th>
              <th className="py-2 pr-3 font-normal">Tip</th>
              <th className="py-2 pr-3 font-normal">Period</th>
              <th className="py-2 pr-3 text-right font-normal">Plan</th>
              <th className="py-2 pr-3 text-right font-normal">Stvarno</th>
              <th className="py-2 pr-3 text-right font-normal">% potrošeno</th>
              <th className="py-2 pr-3 text-right font-normal">% vremena prošlo</th>
              <th className="py-2 font-normal">Status</th>
            </tr>
          </thead>
          <tbody>
            {googleRows.map((r, i) => {
              const pctSpent = r.budget_total > 0 ? (r.actual_spend / r.budget_total) * 100 : 0
              const status = paceStatus(pctSpent, r.pct_time_elapsed)
              return (
                <tr key={i} className="border-b border-[var(--color-line)]">
                  <td className="py-2 pr-3 max-w-[220px] truncate" title={r.campaign_label}>{r.campaign_label}</td>
                  <td className="py-2 pr-3 text-[var(--color-ink-soft)]">{r.ad_set_type ? AD_SET_LABEL[r.ad_set_type] ?? r.ad_set_type : '—'}</td>
                  <td className="py-2 pr-3 text-[var(--color-ink-soft)]">{r.start_date.slice(5)} – {r.end_date.slice(5)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmtEUR(r.budget_total)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmtEUR(r.actual_spend)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmtPct(pctSpent)}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmtPct(r.pct_time_elapsed)}</td>
                  <td className="py-2">
                    <span className="rounded px-1.5 py-0.5 text-xs text-white" style={{ background: status.color }}>{status.label}</span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </section>

      {/* Meta Ads pacing */}
      <section>
        <h2 className="font-display mb-4 text-lg font-medium">Meta Ads &mdash; po budžetskom rasponu (celomesečno)</h2>
        <table className="w-full max-w-2xl border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
              <th className="py-2 pr-3 font-normal">Raspon</th>
              <th className="py-2 pr-3 text-right font-normal">Plan</th>
              <th className="py-2 pr-3 text-right font-normal">Stvarno</th>
              <th className="py-2 text-right font-normal">% potrošeno</th>
            </tr>
          </thead>
          <tbody>
            {metaRows.map((r) => {
              const pct = r.budget_planned > 0 ? (r.actual_spend / r.budget_planned) * 100 : null
              return (
                <tr key={r.bucket} className="border-b border-[var(--color-line)]">
                  <td className="py-2 pr-3">{BUCKET_LABEL[r.bucket] ?? r.bucket}</td>
                  <td className="py-2 pr-3 text-right font-mono">{r.budget_planned > 0 ? fmtEUR(r.budget_planned) : '—'}</td>
                  <td className="py-2 pr-3 text-right font-mono">{fmtEUR(r.actual_spend)}</td>
                  <td className="py-2 text-right font-mono">{pct != null ? fmtPct(pct) : '—'}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {metaEcomm && (
          <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
            Do sada je potrošeno {fmtPct((metaEcomm.actual_spend / metaEcomm.budget_planned) * 100)} od planiranog Ecomm budžeta za {monthLabel}.
          </p>
        )}
      </section>
    </div>
  )
}
