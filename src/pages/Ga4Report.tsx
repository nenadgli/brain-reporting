import { useEffect, useMemo, useState } from 'react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { supabase, type Client } from '../lib/supabase'

const AGENCY_ID = '00000000-0000-0000-0000-000000000001'

const SOURCE_LABEL: Record<string, string> = {
  google: 'Google (organic + paid)',
  '(direct)': 'Direktan pristup',
  facebook: 'Facebook / Instagram',
  '(not set)': 'Nepoznato',
}

const fmtEUR = (n: number) => `€${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtInt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmtPct = (n: number) => `${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`

type Totals = { sessions: number; total_users: number; new_users: number; engaged_sessions: number; conversions: number; total_revenue: number }
type Direction = 'up' | 'down' | 'flat'

function pctChange(curr: number, prev: number): { pct: number; dir: Direction } {
  if (prev === 0) return { pct: curr === 0 ? 0 : 100, dir: curr > 0 ? 'up' : 'flat' }
  const pct = ((curr - prev) / prev) * 100
  return { pct, dir: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat' }
}

function ChangeBadge({ dir, pct, favorable }: { dir: Direction; pct: number; favorable: 'up' | 'down' | 'neutral' }) {
  const isGood = favorable === 'neutral' ? null : dir === favorable
  const color = dir === 'flat' || isGood === null ? 'text-[var(--color-ink-soft)]' : isGood ? 'text-[var(--color-olive)]' : 'text-[var(--color-rust)]'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '·'
  return (
    <span className={`ml-2 font-mono text-xs ${color}`}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

const emptyTotals: Totals = { sessions: 0, total_users: 0, new_users: 0, engaged_sessions: 0, conversions: 0, total_revenue: 0 }

export default function Ga4Report() {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dateRange, setDateRange] = useState<{ current: [string, string]; previous: [string, string] | null } | null>(null)
  const [trend, setTrend] = useState<{ report_date: string; sessions: number; conversions: number; total_revenue: number }[]>([])
  const [totals, setTotals] = useState<Totals>(emptyTotals)
  const [prevTotals, setPrevTotals] = useState<Totals>(emptyTotals)
  const [bySource, setBySource] = useState<{ source: string; sessions: number; total_users: number; engaged_sessions: number; conversions: number; total_revenue: number }[]>([])
  const [topCampaigns, setTopCampaigns] = useState<{ campaign: string; source: string; sessions: number; total_users: number; conversions: number; total_revenue: number }[]>([])

  useEffect(() => {
    async function loadClients() {
      const { data: sourceRows, error: sourceError } = await supabase.from('data_sources').select('client_id').eq('provider', 'ga4')
      if (sourceError || !sourceRows || sourceRows.length === 0) {
        setError('Nijedan klijent nema povezan GA4 nalog.')
        setLoading(false)
        return
      }
      const clientIds = [...new Set(sourceRows.map((r) => r.client_id))]
      const { data: clientRows, error: clientError } = await supabase
        .from('clients').select('*').eq('agency_id', AGENCY_ID).in('id', clientIds).order('name')
      if (clientError || !clientRows || clientRows.length === 0) {
        setError('Nije moguće učitati klijente.')
        setLoading(false)
        return
      }
      setClients(clientRows)
      setSelectedId(clientRows[0].id)
    }
    loadClients()
  }, [])

  useEffect(() => {
    if (!selectedId) return
    async function findRange() {
      setLoading(true)
      setError(null)
      const { data, error: rangeError } = await supabase.rpc('ga4_date_range', { p_client_id: selectedId })
      const row = data?.[0]
      if (rangeError || !row || !row.min_date || !row.max_date) {
        setError('Nema GA4 podataka za ovog klijenta još uvek.')
        setLoading(false)
        return
      }
      const minDate = row.min_date as string
      const maxDate = row.max_date as string
      const totalDays = Math.round((new Date(maxDate).getTime() - new Date(minDate).getTime()) / 86400000) + 1
      const half = Math.floor(totalDays / 2)
      if (half === 0) {
        setDateRange({ current: [minDate, maxDate], previous: null })
      } else {
        const currentStart = new Date(new Date(maxDate).getTime() - (half - 1) * 86400000).toISOString().slice(0, 10)
        const prevEnd = new Date(new Date(currentStart).getTime() - 86400000).toISOString().slice(0, 10)
        const prevStart = new Date(new Date(prevEnd).getTime() - (half - 1) * 86400000).toISOString().slice(0, 10)
        setDateRange({ current: [currentStart, maxDate], previous: [prevStart, prevEnd] })
      }
    }
    findRange()
  }, [selectedId])

  useEffect(() => {
    if (!selectedId || !dateRange) return
    async function loadAll() {
      setLoading(true)
      setError(null)
      const [cs, ce] = dateRange!.current
      const fullStart = dateRange!.previous ? dateRange!.previous[0] : cs

      const [trendRes, totalsRes, prevTotalsRes, sourceRes, campRes] = await Promise.all([
        supabase.rpc('ga4_daily_trend', { p_client_id: selectedId, p_start: fullStart, p_end: ce }),
        supabase.rpc('ga4_period_totals', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        dateRange!.previous
          ? supabase.rpc('ga4_period_totals', { p_client_id: selectedId, p_start: dateRange!.previous[0], p_end: dateRange!.previous[1] })
          : Promise.resolve({ data: [emptyTotals], error: null }),
        supabase.rpc('ga4_source_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('ga4_campaign_summary', { p_client_id: selectedId, p_start: cs, p_end: ce, p_limit: 20 }),
      ])

      if (trendRes.error || totalsRes.error) {
        setError('Nije moguće učitati GA4 podatke.')
        setLoading(false)
        return
      }

      setTrend((trendRes.data ?? []).map((r: Record<string, unknown>) => ({
        report_date: r.report_date as string, sessions: Number(r.sessions ?? 0), conversions: Number(r.conversions ?? 0), total_revenue: Number(r.total_revenue ?? 0),
      })))
      setTotals((totalsRes.data?.[0] as Totals) ?? emptyTotals)
      setPrevTotals((prevTotalsRes.data?.[0] as Totals) ?? emptyTotals)
      setBySource(sourceRes.data ?? [])
      setTopCampaigns(campRes.data ?? [])
      setLoading(false)
    }
    loadAll()
  }, [selectedId, dateRange])

  function deriveKpis(t: Totals) {
    const engagementRate = t.sessions > 0 ? (t.engaged_sessions / t.sessions) * 100 : 0
    const convRate = t.sessions > 0 ? (t.conversions / t.sessions) * 100 : 0
    const newUserShare = t.total_users > 0 ? (t.new_users / t.total_users) * 100 : 0
    const revenuePerSession = t.sessions > 0 ? t.total_revenue / t.sessions : 0
    return { engagementRate, convRate, newUserShare, revenuePerSession }
  }
  const kpis = useMemo(() => deriveKpis(totals), [totals])
  const prevKpis = useMemo(() => deriveKpis(prevTotals), [prevTotals])
  const hasComparison = dateRange?.previous != null
  const totalSessionsForShare = totals.sessions || 1

  const rangeLabel = dateRange
    ? `${dateRange.current[0].slice(5)} – ${dateRange.current[1].slice(5)}` + (dateRange.previous ? ` vs ${dateRange.previous[0].slice(5)} – ${dateRange.previous[1].slice(5)}` : '')
    : ''

  if (error && clients.length === 0) {
    return <p className="text-[var(--color-rust)]">{error}</p>
  }

  return (
    <div>
      <header className="mb-8 flex items-end justify-between border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Google Analytics 4 &middot; Tržište RS</p>
          <h1 className="font-display mt-1 text-4xl font-medium">{loading ? '…' : clients.find((c) => c.id === selectedId)?.name}</h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">{rangeLabel ? `Period: ${rangeLabel}` : 'Učitavanje perioda…'} &middot; ceo sajt (svi kanali saobraćaja)</p>
        </div>
        {clients.length > 1 && (
          <label className="text-sm">
            <span className="mr-2 text-[var(--color-ink-soft)]">Klijent</span>
            <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} className="rounded border border-[var(--color-line)] bg-white px-3 py-1.5">
              {clients.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
      </header>

      {error && <p className="text-[var(--color-rust)]">{error}</p>}

      {!error && !loading && (
        <>
          <section className="mb-10 grid grid-cols-4 gap-px border border-[var(--color-line)] bg-[var(--color-line)]">
            {[
              { label: 'Sesije', val: fmtInt(totals.sessions), curr: totals.sessions, prev: prevTotals.sessions, favorable: 'up' as const },
              { label: 'Korisnici', val: fmtInt(totals.total_users), curr: totals.total_users, prev: prevTotals.total_users, favorable: 'up' as const },
              { label: 'Novi korisnici', val: fmtPct(kpis.newUserShare), curr: kpis.newUserShare, prev: prevKpis.newUserShare, favorable: 'neutral' as const },
              { label: 'Stopa angažovanja', val: fmtPct(kpis.engagementRate), curr: kpis.engagementRate, prev: prevKpis.engagementRate, favorable: 'up' as const },
              { label: 'Konverzije', val: fmtInt(totals.conversions), curr: totals.conversions, prev: prevTotals.conversions, favorable: 'up' as const },
              { label: 'Stopa konverzije', val: fmtPct(kpis.convRate), curr: kpis.convRate, prev: prevKpis.convRate, favorable: 'up' as const },
              { label: 'Prihod', val: fmtEUR(totals.total_revenue), curr: totals.total_revenue, prev: prevTotals.total_revenue, favorable: 'up' as const },
              { label: 'Prihod po sesiji', val: fmtEUR(kpis.revenuePerSession), curr: kpis.revenuePerSession, prev: prevKpis.revenuePerSession, favorable: 'up' as const },
            ].map((kpi) => {
              const { pct, dir } = pctChange(kpi.curr, kpi.prev)
              return (
                <div key={kpi.label} className="bg-white p-4">
                  <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">{kpi.label}</p>
                  <p className="font-display mt-1 text-2xl">{kpi.val}</p>
                  {hasComparison && <ChangeBadge dir={dir} pct={pct} favorable={kpi.favorable} />}
                </div>
              )
            })}
          </section>

          <section className="mb-10">
            <h2 className="font-display mb-4 text-lg font-medium">Sesije i prihod po danu</h2>
            <div className="h-64 rounded border border-[var(--color-line)] bg-white p-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend}>
                  <defs>
                    <linearGradient id="sessionsGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-indigo)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-indigo)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis dataKey="report_date" tickFormatter={(d) => String(d).slice(5)} tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={{ stroke: 'var(--color-line)' }} tickLine={false} />
                  <YAxis yAxisId="sessions" tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="revenue" orientation="right" tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ fontSize: 13, borderRadius: 4, border: '1px solid var(--color-line)' }} formatter={(value, name) => (name === 'Prihod' ? fmtEUR(Number(value)) : fmtInt(Number(value)))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area yAxisId="sessions" type="monotone" dataKey="sessions" name="Sesije" stroke="var(--color-indigo)" fill="url(#sessionsGrad)" strokeWidth={2} />
                  <Area yAxisId="revenue" type="monotone" dataKey="total_revenue" name="Prihod" stroke="var(--color-olive)" fill="none" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="mb-10">
            <h2 className="font-display mb-4 text-lg font-medium">Po kanalu saobraćaja</h2>
            <div className="space-y-3 mb-6">
              {bySource.slice(0, 6).map((row) => {
                const share = (row.sessions / totalSessionsForShare) * 100
                return (
                  <div key={row.source}>
                    <div className="mb-1 flex justify-between text-sm">
                      <span>{SOURCE_LABEL[row.source] ?? row.source}</span>
                      <span className="font-mono text-[var(--color-ink-soft)]">{fmtInt(row.sessions)} sesija &middot; {share.toFixed(0)}%</span>
                    </div>
                    <div className="h-1.5 w-full bg-[var(--color-indigo-soft)]">
                      <div className="h-1.5 bg-[var(--color-indigo)]" style={{ width: `${share}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                  <th className="py-2 font-normal">Izvor</th>
                  <th className="py-2 text-right font-normal">Sesije</th>
                  <th className="py-2 text-right font-normal">Korisnici</th>
                  <th className="py-2 text-right font-normal">Stopa angažovanja</th>
                  <th className="py-2 text-right font-normal">Konv.</th>
                  <th className="py-2 text-right font-normal">Prihod</th>
                </tr>
              </thead>
              <tbody>
                {bySource.slice(0, 15).map((row) => (
                  <tr key={row.source} className="border-b border-[var(--color-line)]">
                    <td className="py-2">{SOURCE_LABEL[row.source] ?? row.source}</td>
                    <td className="py-2 text-right font-mono">{fmtInt(row.sessions)}</td>
                    <td className="py-2 text-right font-mono">{fmtInt(row.total_users)}</td>
                    <td className="py-2 text-right font-mono">{row.sessions > 0 ? fmtPct((row.engaged_sessions / row.sessions) * 100) : '—'}</td>
                    <td className="py-2 text-right font-mono">{fmtInt(row.conversions)}</td>
                    <td className="py-2 text-right font-mono">{fmtEUR(row.total_revenue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {topCampaigns.length > 0 && (
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Top kampanje po sesijama</h2>
              <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
                Atribucija po GA4 (poslednji klik), ne po ad platformi &mdash; brojevi se neće poklopiti tačno sa Google Ads / Meta izveštajima,
                to je očekivano i normalno.
              </p>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 pr-3 font-normal">Kampanja</th>
                    <th className="py-2 pr-3 font-normal">Izvor</th>
                    <th className="py-2 pr-3 text-right font-normal">Sesije</th>
                    <th className="py-2 pr-3 text-right font-normal">Korisnici</th>
                    <th className="py-2 pr-3 text-right font-normal">Konv.</th>
                    <th className="py-2 text-right font-normal">Prihod</th>
                  </tr>
                </thead>
                <tbody>
                  {topCampaigns.map((c, i) => (
                    <tr key={i} className="border-b border-[var(--color-line)]">
                      <td className="py-2 pr-3 max-w-[280px] truncate" title={c.campaign}>{c.campaign}</td>
                      <td className="py-2 pr-3 text-[var(--color-ink-soft)]">{SOURCE_LABEL[c.source] ?? c.source}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(c.sessions)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(c.total_users)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(c.conversions)}</td>
                      <td className="py-2 text-right font-mono">{fmtEUR(c.total_revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </>
      )}
    </div>
  )
}
