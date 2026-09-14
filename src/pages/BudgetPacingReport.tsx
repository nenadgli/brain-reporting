import { useEffect, useMemo, useState } from 'react'
import { Line, ComposedChart, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts'
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
type DailyRow = { report_date: string; network: string; planned_cum: number; actual_cum: number }

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
  const [monthOptions, setMonthOptions] = useState<{ value: string; label: string }[]>([])
  const [monthValue, setMonthValue] = useState<string>('')
  const [googleRows, setGoogleRows] = useState<GoogleRow[]>([])
  const [metaRows, setMetaRows] = useState<MetaRow[]>([])
  const [dailyRows, setDailyRows] = useState<DailyRow[]>([])

  useEffect(() => {
    async function loadMonths() {
      const { data, error: err } = await supabase
        .from('media_plan_lines')
        .select('month')
        .eq('client_id', 'c710bfd0-5281-412b-a7d6-2a96c80b9b57')
      if (err || !data || data.length === 0) {
        setError('Nema uvezenog media plana još uvek.')
        setLoading(false)
        return
      }
      const uniqueMonths = [...new Set(data.map((r) => r.month as string))].sort().reverse()
      const opts = uniqueMonths.map((m) => {
        const [y, mm] = m.split('-').map(Number)
        return { value: m, label: `${MONTH_NAMES[mm - 1]} ${y}` }
      })
      setMonthOptions(opts)
      setMonthValue(opts[0].value)
    }
    loadMonths()
  }, [])

  useEffect(() => {
    if (!monthValue) return
    async function load() {
      setLoading(true)
      setError(null)
      const [gRes, mRes, dRes] = await Promise.all([
        supabase.rpc('fashion_rs_google_pacing', { p_month: monthValue }),
        supabase.rpc('fashion_rs_meta_pacing', { p_month: monthValue }),
        supabase.rpc('fashion_rs_daily_pacing', { p_month: monthValue }),
      ])
      if (gRes.error || mRes.error) {
        setError('Nije moguće učitati podatke o budžetu.')
        setLoading(false)
        return
      }
      setGoogleRows(gRes.data ?? [])
      setMetaRows(mRes.data ?? [])
      setDailyRows(dRes.data ?? [])
      setLoading(false)
    }
    load()
  }, [monthValue])

  const monthLabel = monthOptions.find((m) => m.value === monthValue)?.label ?? ''

  const googleTotals = useMemo(
    () => googleRows.reduce((acc, r) => ({ budget: acc.budget + r.budget_total, actual: acc.actual + r.actual_spend }), { budget: 0, actual: 0 }),
    [googleRows]
  )
  const metaEcomm = metaRows.find((r) => r.bucket === 'Ecomm')

  // Pivot daily rows into {date, google_planned, google_actual, meta_planned, meta_actual}
  const dailyChartData = useMemo(() => {
    const byDate: Record<string, { date: string; google_planned: number; google_actual: number; meta_planned: number; meta_actual: number }> = {}
    dailyRows.forEach((r) => {
      if (!byDate[r.report_date]) byDate[r.report_date] = { date: r.report_date, google_planned: 0, google_actual: 0, meta_planned: 0, meta_actual: 0 }
      if (r.network === 'google') {
        byDate[r.report_date].google_planned = r.planned_cum
        byDate[r.report_date].google_actual = r.actual_cum
      } else {
        byDate[r.report_date].meta_planned = r.planned_cum
        byDate[r.report_date].meta_actual = r.actual_cum
      }
    })
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
  }, [dailyRows])

  // Only show actuals up to the last day we actually have data for (avoid a misleading drop to zero)
  const lastActualDate = useMemo(() => {
    const withSpend = dailyRows.filter((r) => r.actual_cum > 0)
    return withSpend.length > 0 ? withSpend.sort((a, b) => b.report_date.localeCompare(a.report_date))[0].report_date : null
  }, [dailyRows])

  if (error) return <p className="text-[var(--color-rust)]">{error}</p>
  if (loading && monthOptions.length === 0) return <p className="text-[var(--color-ink-soft)]">Učitavanje…</p>

  return (
    <div>
      <header className="mb-8 flex items-end justify-between border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Praćenje budžeta naspram media plana &middot; dnevno</p>
          <h1 className="font-display mt-1 text-4xl font-medium">Fashion&amp;Friends RS</h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">Period: {monthLabel} &middot; planirano vs. stvarno potrošeno</p>
        </div>
        <label className="text-sm">
          <span className="mr-2 text-[var(--color-ink-soft)]">Mesec</span>
          <select value={monthValue} onChange={(e) => setMonthValue(e.target.value)} className="rounded border border-[var(--color-line)] bg-white px-3 py-1.5">
            {monthOptions.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
        </label>
      </header>

      {!loading && (
        <>
          <section className="mb-8 rounded border border-[var(--color-line)] bg-[var(--color-indigo-soft)] p-4 text-xs text-[var(--color-ink-soft)]">
            <strong>Google Ads</strong> je prikazan po flajtu (tip kampanje + period) — pouzdano, bez preklapanja.{' '}
            <strong>Meta Ads</strong> je prikazan na nivou celog meseca po budžetskom rasponu (Ecomm/Loyalty/Social) — flajt-po-flajt praćenje za
            Meta trenutno nije pouzdano zbog preklapanja kampanja u istom periodu.
          </section>

          {/* Daily burn chart */}
          <section className="mb-10">
            <h2 className="font-display mb-4 text-lg font-medium">Dnevno praćenje — planirano vs. stvarno (kumulativno)</h2>
            <div className="grid grid-cols-2 gap-6">
              <div>
                <p className="mb-2 text-sm font-medium text-[var(--color-ink-soft)]">Google Ads</p>
                <div className="h-56 rounded border border-[var(--color-line)] bg-white p-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={dailyChartData}>
                      <CartesianGrid stroke="var(--color-line)" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={(d) => String(d).slice(5)} tick={{ fontSize: 10, fill: 'var(--color-ink-soft)' }} axisLine={{ stroke: 'var(--color-line)' }} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 4, border: '1px solid var(--color-line)' }} formatter={(v) => fmtEUR(Number(v))} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="google_planned" name="Planirano" stroke="var(--color-ink-soft)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} />
                      <Line
                        type="monotone"
                        dataKey="google_actual"
                        name="Stvarno"
                        stroke="var(--color-indigo)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls={false}
                        data={dailyChartData.filter((d) => !lastActualDate || d.date <= lastActualDate)}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
              <div>
                <p className="mb-2 text-sm font-medium text-[var(--color-ink-soft)]">Meta Ads</p>
                <div className="h-56 rounded border border-[var(--color-line)] bg-white p-3">
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart data={dailyChartData}>
                      <CartesianGrid stroke="var(--color-line)" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={(d) => String(d).slice(5)} tick={{ fontSize: 10, fill: 'var(--color-ink-soft)' }} axisLine={{ stroke: 'var(--color-line)' }} tickLine={false} />
                      <YAxis tick={{ fontSize: 10, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ fontSize: 12, borderRadius: 4, border: '1px solid var(--color-line)' }} formatter={(v) => fmtEUR(Number(v))} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                      <Line type="monotone" dataKey="meta_planned" name="Planirano" stroke="var(--color-ink-soft)" strokeDasharray="4 3" strokeWidth={1.5} dot={false} />
                      <Line
                        type="monotone"
                        dataKey="meta_actual"
                        name="Stvarno"
                        stroke="var(--color-olive)"
                        strokeWidth={2}
                        dot={false}
                        connectNulls={false}
                        data={dailyChartData.filter((d) => !lastActualDate || d.date <= lastActualDate)}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>
            <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
              Isprekidana linija = ravnomerno raspoređen plan (budžet flajta / broj dana). Puna linija = stvarna kumulativna potrošnja do
              poslednjeg dana za koji imamo sinhronizovane podatke.
            </p>
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
        </>
      )}
    </div>
  )
}
