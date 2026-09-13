import { useEffect, useMemo, useState } from 'react'
import {
  AreaChart,
  Area,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { supabase, type Client } from '../lib/supabase'

const AGENCY_ID = '00000000-0000-0000-0000-000000000001'

const CHANNEL_LABEL: Record<string, string> = { google: 'Google Ads', meta: 'Meta (FB/IG)' }
const CHANNEL_COLOR: Record<string, string> = { google: 'var(--color-indigo)', meta: 'var(--color-olive)' }

const fmtEUR = (n: number) => `€${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtInt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmtPct = (n: number) => `${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`

type Totals = { impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }
type Metric = 'spend' | 'conversions' | 'conversion_value'
type Direction = 'up' | 'down' | 'flat'

function pctChange(curr: number, prev: number): { pct: number; dir: Direction } {
  if (prev === 0) return { pct: curr === 0 ? 0 : 100, dir: curr > 0 ? 'up' : 'flat' }
  const pct = ((curr - prev) / prev) * 100
  return { pct, dir: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat' }
}

function ChangeBadge({ dir, pct, favorable }: { dir: Direction; pct: number; favorable: 'up' | 'down' | 'neutral' }) {
  const isGood = favorable === 'neutral' ? null : dir === favorable
  const color = dir === 'flat' || isGood === null ? 'text-white/70' : isGood ? 'text-white font-semibold' : 'text-amber-200 font-semibold'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '·'
  return (
    <span className={`ml-2 font-mono text-xs ${color}`}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

const emptyTotals: Totals = { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversion_value: 0 }
const METRIC_OPTIONS: { key: Metric; label: string }[] = [
  { key: 'spend', label: 'Potrošnja' },
  { key: 'conversions', label: 'Konverzije' },
  { key: 'conversion_value', label: 'Vrednost konverzija' },
]

export default function BlendedReport() {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dateRange, setDateRange] = useState<{ current: [string, string]; previous: [string, string] | null } | null>(null)
  const [rawTrend, setRawTrend] = useState<{ report_date: string; channel: string; spend: number; conversions: number; conversion_value: number }[]>([])
  const [channelTotals, setChannelTotals] = useState<{ channel: string; impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }[]>([])
  const [prevChannelTotals, setPrevChannelTotals] = useState<{ channel: string; impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }[]>([])
  const [campaigns, setCampaigns] = useState<{ channel: string; campaign: string; impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }[]>([])
  const [ga4Verification, setGa4Verification] = useState<{ channel: string; sessions: number; total_users: number; engaged_sessions: number; conversions: number; total_revenue: number }[]>([])
  const [newVsReturning, setNewVsReturning] = useState<{ report_date: string; new_users: number; returning_users: number }[]>([])
  const [engagementByChannel, setEngagementByChannel] = useState<{ source: string; sessions: number; engaged_sessions: number; bounce_rate: number | null; conversions: number }[]>([])

  const [trendMetric, setTrendMetric] = useState<Metric>('spend')
  const [showGoogle, setShowGoogle] = useState(true)
  const [showMeta, setShowMeta] = useState(true)

  useEffect(() => {
    async function loadClients() {
      const [{ data: gRows }, { data: fRows }] = await Promise.all([
        supabase.from('data_sources').select('client_id').eq('provider', 'google_ads'),
        supabase.from('data_sources').select('client_id').eq('provider', 'facebook'),
      ])
      const googleIds = new Set((gRows ?? []).map((r) => r.client_id))
      const metaIds = new Set((fRows ?? []).map((r) => r.client_id))
      const bothIds = [...googleIds].filter((id) => metaIds.has(id))

      if (bothIds.length === 0) {
        setError('Nijedan klijent trenutno nema i Google Ads i Meta nalog povezan istovremeno.')
        setLoading(false)
        return
      }
      const { data: clientRows, error: clientError } = await supabase
        .from('clients').select('*').eq('agency_id', AGENCY_ID).in('id', bothIds).order('name')
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
      const { data, error: rangeError } = await supabase.rpc('blended_date_range', { p_client_id: selectedId })
      const row = data?.[0]
      if (rangeError || !row || !row.min_date || !row.max_date) {
        setError('Nema podataka za ovog klijenta još uvek.')
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

      const calls = [
        supabase.rpc('blended_daily_trend', { p_client_id: selectedId, p_start: fullStart, p_end: ce }),
        supabase.rpc('blended_channel_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        dateRange!.previous
          ? supabase.rpc('blended_channel_summary', { p_client_id: selectedId, p_start: dateRange!.previous[0], p_end: dateRange!.previous[1] })
          : Promise.resolve({ data: [], error: null }),
        supabase.rpc('blended_campaign_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('ga4_paid_channel_verification', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('ga4_new_vs_returning_trend', { p_client_id: selectedId, p_start: fullStart, p_end: ce }),
        supabase.rpc('ga4_engagement_by_channel', { p_client_id: selectedId, p_start: cs, p_end: ce, p_limit: 8 }),
      ]
      const [trendRes, totRes, prevTotRes, campRes, ga4VerRes, ga4NewRetRes, ga4EngRes] = await Promise.all(calls)

      const tRes = trendRes as { data: typeof rawTrend; error: unknown }
      const cRes = totRes as { data: typeof channelTotals; error: unknown }
      if (tRes.error || cRes.error) {
        setError('Nije moguće učitati blended podatke.')
        setLoading(false)
        return
      }
      setRawTrend((trendRes as { data: typeof rawTrend }).data ?? [])
      setChannelTotals((totRes as { data: typeof channelTotals }).data ?? [])
      setPrevChannelTotals(((prevTotRes as { data: typeof channelTotals }).data) ?? [])
      setCampaigns(((campRes as { data: typeof campaigns }).data) ?? [])
      setGa4Verification((ga4VerRes as { data: typeof ga4Verification }).data ?? [])
      setNewVsReturning((ga4NewRetRes as { data: typeof newVsReturning }).data ?? [])
      setEngagementByChannel((ga4EngRes as { data: typeof engagementByChannel }).data ?? [])
      setLoading(false)
    }
    loadAll()
  }, [selectedId, dateRange])

  const totalsByChannel = useMemo(() => {
    const m: Record<string, Totals> = { google: emptyTotals, meta: emptyTotals }
    channelTotals.forEach((r) => {
      m[r.channel] = { impressions: r.impressions, clicks: r.clicks, spend: r.spend, conversions: r.conversions, conversion_value: r.conversion_value }
    })
    return m
  }, [channelTotals])

  const prevTotalsByChannel = useMemo(() => {
    const m: Record<string, Totals> = { google: emptyTotals, meta: emptyTotals }
    prevChannelTotals.forEach((r) => {
      m[r.channel] = { impressions: r.impressions, clicks: r.clicks, spend: r.spend, conversions: r.conversions, conversion_value: r.conversion_value }
    })
    return m
  }, [prevChannelTotals])

  const combined = useMemo(() => {
    const sum = (f: (t: Totals) => number) => f(totalsByChannel.google) + f(totalsByChannel.meta)
    return {
      impressions: sum((t) => t.impressions),
      clicks: sum((t) => t.clicks),
      spend: sum((t) => t.spend),
      conversions: sum((t) => t.conversions),
      conversion_value: sum((t) => t.conversion_value),
    }
  }, [totalsByChannel])

  const prevCombined = useMemo(() => {
    const sum = (f: (t: Totals) => number) => f(prevTotalsByChannel.google) + f(prevTotalsByChannel.meta)
    return {
      impressions: sum((t) => t.impressions),
      clicks: sum((t) => t.clicks),
      spend: sum((t) => t.spend),
      conversions: sum((t) => t.conversions),
      conversion_value: sum((t) => t.conversion_value),
    }
  }, [prevTotalsByChannel])

  const hasComparison = dateRange?.previous != null

  function deriveKpis(t: Totals) {
    const ctr = t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0
    const cpc = t.clicks > 0 ? t.spend / t.clicks : 0
    const cpa = t.conversions > 0 ? t.spend / t.conversions : 0
    const roas = t.spend > 0 ? t.conversion_value / t.spend : 0
    return { ctr, cpc, cpa, roas }
  }
  const kpis = useMemo(() => deriveKpis(combined), [combined])
  const prevKpis = useMemo(() => deriveKpis(prevCombined), [prevCombined])

  // Pivot raw trend rows into {date, google, meta} for the selected metric
  const trendData = useMemo(() => {
    const byDate: Record<string, { date: string; google: number; meta: number }> = {}
    rawTrend.forEach((r) => {
      if (!byDate[r.report_date]) byDate[r.report_date] = { date: r.report_date, google: 0, meta: 0 }
      byDate[r.report_date][r.channel as 'google' | 'meta'] = r[trendMetric]
    })
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
  }, [rawTrend, trendMetric])

  const spendShareData = useMemo(
    () => [
      { name: 'Google Ads', value: totalsByChannel.google.spend, key: 'google' },
      { name: 'Meta (FB/IG)', value: totalsByChannel.meta.spend, key: 'meta' },
    ].filter((d) => d.value > 0),
    [totalsByChannel]
  )

  const topCampaigns = useMemo(() => {
    return campaigns
      .map((c) => ({
        ...c,
        roas: c.spend > 0 ? c.conversion_value / c.spend : 0,
        cpa: c.conversions > 0 ? c.spend / c.conversions : 0,
      }))
      .sort((a, b) => b.spend - a.spend)
      .slice(0, 20)
  }, [campaigns])

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
          <p className="eyebrow-label">Blended izveštaj</p>
          <h1 className="font-display mt-1 text-4xl font-medium">{loading ? '…' : clients.find((c) => c.id === selectedId)?.name}</h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">{rangeLabel ? `Period: ${rangeLabel}` : 'Učitavanje perioda…'} &middot; Google Ads + Meta zajedno</p>
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
          {/* Combined KPIs */}
          <section className="mb-10 kpi-grid grid-cols-4">
            {[
              { label: 'Ukupna potrošnja', val: fmtEUR(combined.spend), curr: combined.spend, prev: prevCombined.spend, favorable: 'neutral' as const },
              { label: 'Ukupne konverzije', val: fmtInt(combined.conversions), curr: combined.conversions, prev: prevCombined.conversions, favorable: 'up' as const },
              { label: 'Vrednost konverzija', val: fmtEUR(combined.conversion_value), curr: combined.conversion_value, prev: prevCombined.conversion_value, favorable: 'up' as const },
              { label: 'Blended ROAS', val: `${kpis.roas.toFixed(2)}x`, curr: kpis.roas, prev: prevKpis.roas, favorable: 'up' as const },
              { label: 'Blended CPA', val: fmtEUR(kpis.cpa), curr: kpis.cpa, prev: prevKpis.cpa, favorable: 'down' as const },
              { label: 'Blended CTR', val: fmtPct(kpis.ctr), curr: kpis.ctr, prev: prevKpis.ctr, favorable: 'up' as const },
              { label: 'Ukupni klikovi', val: fmtInt(combined.clicks), curr: combined.clicks, prev: prevCombined.clicks, favorable: 'neutral' as const },
              { label: 'Ukupne impresije', val: fmtInt(combined.impressions), curr: combined.impressions, prev: prevCombined.impressions, favorable: 'neutral' as const },
            ].map((kpi) => {
              const { pct, dir } = pctChange(kpi.curr, kpi.prev)
              return (
                <div key={kpi.label} className="kpi-card">
                  <p className="kpi-label">{kpi.label}</p>
                  <p className="kpi-value">{kpi.val}</p>
                  {hasComparison && <ChangeBadge dir={dir} pct={pct} favorable={kpi.favorable} />}
                </div>
              )
            })}
          </section>

          {/* Interactive trend chart */}
          <section className="mb-10">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h2 className="font-display text-lg font-medium">Trend po kanalu</h2>
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex gap-1 text-xs">
                  {METRIC_OPTIONS.map((m) => (
                    <button
                      key={m.key}
                      onClick={() => setTrendMetric(m.key)}
                      className={`rounded px-2 py-1 ${trendMetric === m.key ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo)]' : 'text-[var(--color-ink-soft)]'}`}
                    >
                      {m.label}
                    </button>
                  ))}
                </div>
                <div className="flex gap-3 text-xs">
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={showGoogle} onChange={(e) => setShowGoogle(e.target.checked)} />
                    <span style={{ color: 'var(--color-indigo)' }}>Google Ads</span>
                  </label>
                  <label className="flex items-center gap-1.5">
                    <input type="checkbox" checked={showMeta} onChange={(e) => setShowMeta(e.target.checked)} />
                    <span style={{ color: 'var(--color-olive)' }}>Meta</span>
                  </label>
                </div>
              </div>
            </div>
            <div className="h-72 rounded border border-[var(--color-line)] bg-white p-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData}>
                  <defs>
                    <linearGradient id="googleGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-indigo)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-indigo)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="metaGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-olive)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-olive)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={(d) => String(d).slice(5)} tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={{ stroke: 'var(--color-line)' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 13, borderRadius: 4, border: '1px solid var(--color-line)' }}
                    formatter={(value, name) => [trendMetric === 'conversions' ? Number(value).toFixed(1) : fmtEUR(Number(value)), name]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  {showGoogle && (
                    <Area type="monotone" dataKey="google" name="Google Ads" stroke="var(--color-indigo)" fill="url(#googleGrad)" strokeWidth={2} stackId={trendMetric === 'spend' ? '1' : undefined} />
                  )}
                  {showMeta && (
                    <Area type="monotone" dataKey="meta" name="Meta (FB/IG)" stroke="var(--color-olive)" fill="url(#metaGrad)" strokeWidth={2} stackId={trendMetric === 'spend' ? '1' : undefined} />
                  )}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <div className="mb-10 grid grid-cols-2 gap-8">
            {/* Spend share donut */}
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Udeo potrošnje po kanalu</h2>
              <div className="h-64 rounded border border-[var(--color-line)] bg-white p-4">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={spendShareData} dataKey="value" nameKey="name" innerRadius={55} outerRadius={90} paddingAngle={2}>
                      {spendShareData.map((entry) => (
                        <Cell key={entry.key} fill={CHANNEL_COLOR[entry.key]} />
                      ))}
                    </Pie>
                    <Tooltip formatter={(value) => fmtEUR(Number(value))} contentStyle={{ fontSize: 13, borderRadius: 4, border: '1px solid var(--color-line)' }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
            </section>

            {/* Channel comparison table */}
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Google vs Meta</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 font-normal">Metrika</th>
                    <th className="py-2 text-right font-normal">Google Ads</th>
                    <th className="py-2 text-right font-normal">Meta</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['Potrošnja', fmtEUR(totalsByChannel.google.spend), fmtEUR(totalsByChannel.meta.spend)],
                    ['Klikovi', fmtInt(totalsByChannel.google.clicks), fmtInt(totalsByChannel.meta.clicks)],
                    ['CTR', fmtPct(deriveKpis(totalsByChannel.google).ctr), fmtPct(deriveKpis(totalsByChannel.meta).ctr)],
                    ['Konverzije', fmtInt(totalsByChannel.google.conversions), fmtInt(totalsByChannel.meta.conversions)],
                    ['Vrednost konv.', fmtEUR(totalsByChannel.google.conversion_value), fmtEUR(totalsByChannel.meta.conversion_value)],
                    ['ROAS', `${deriveKpis(totalsByChannel.google).roas.toFixed(2)}x`, `${deriveKpis(totalsByChannel.meta).roas.toFixed(2)}x`],
                    ['CPA', fmtEUR(deriveKpis(totalsByChannel.google).cpa), fmtEUR(deriveKpis(totalsByChannel.meta).cpa)],
                  ].map(([label, g, m]) => (
                    <tr key={label} className="border-b border-[var(--color-line)]">
                      <td className="py-2 text-[var(--color-ink-soft)]">{label}</td>
                      <td className="py-2 text-right font-mono">{g}</td>
                      <td className="py-2 text-right font-mono">{m}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {/* GA4 verification: what ad platforms self-report vs what GA4 independently measures */}
          {ga4Verification.length > 0 && (
            <section className="mb-10">
              <h2 className="font-display mb-2 text-lg font-medium">GA4 provera plaćenog saobraćaja</h2>
              <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
                Google Ads i Meta sami prijavljuju svoje konverzije preko sopstvenih piksela (levo). GA4 nezavisno meri šta se stvarno desilo na
                sajtu za posetioce koji su stigli sa tog kanala (desno) &mdash; ovo je "site-side" istina, korisna za proveru da li platforma
                precenjuje svoj doprinos. Napomena: GA4 "konverzije" broji sve konfigurisane key events (ne samo kupovine), pa se taj broj
                očekivano neće poklopiti sa brojem konverzija koji prijavljuje ad platforma &mdash; fokusiraj se na sesije i prihod za realno
                poređenje.
              </p>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 pr-3 font-normal">Kanal</th>
                    <th className="py-2 pr-3 text-right font-normal">Platforma: potrošnja</th>
                    <th className="py-2 pr-3 text-right font-normal">Platforma: vrednost konv.</th>
                    <th className="py-2 pr-3 text-right font-normal">GA4: sesije</th>
                    <th className="py-2 pr-3 text-right font-normal">GA4: angažovane</th>
                    <th className="py-2 text-right font-normal">GA4: prihod</th>
                  </tr>
                </thead>
                <tbody>
                  {ga4Verification.map((row) => {
                    const platform = totalsByChannel[row.channel] ?? emptyTotals
                    return (
                      <tr key={row.channel} className="border-b border-[var(--color-line)]">
                        <td className="py-2 pr-3">
                          <span className="rounded px-1.5 py-0.5 text-xs" style={{ background: row.channel === 'google' ? 'var(--color-indigo-soft)' : '#eef3e9', color: CHANNEL_COLOR[row.channel] }}>
                            {CHANNEL_LABEL[row.channel]}
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right font-mono">{fmtEUR(platform.spend)}</td>
                        <td className="py-2 pr-3 text-right font-mono">{fmtEUR(platform.conversion_value)}</td>
                        <td className="py-2 pr-3 text-right font-mono">{fmtInt(row.sessions)}</td>
                        <td className="py-2 pr-3 text-right font-mono">{row.sessions > 0 ? fmtPct((row.engaged_sessions / row.sessions) * 100) : '—'}</td>
                        <td className="py-2 text-right font-mono">{fmtEUR(row.total_revenue)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </section>
          )}

          <div className="mb-10 grid grid-cols-2 gap-8">
            {/* New vs returning users — retention proxy */}
            {newVsReturning.length > 0 && (
              <section>
                <h2 className="font-display mb-4 text-lg font-medium">Novi vs. povratni korisnici</h2>
                <div className="h-56 rounded border border-[var(--color-line)] bg-white p-4">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={newVsReturning}>
                      <CartesianGrid stroke="var(--color-line)" vertical={false} />
                      <XAxis dataKey="report_date" tickFormatter={(d) => String(d).slice(5)} tick={{ fontSize: 11, fill: 'var(--color-ink-soft)' }} axisLine={{ stroke: 'var(--color-line)' }} tickLine={false} />
                      <YAxis tick={{ fontSize: 11, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
                      <Tooltip contentStyle={{ fontSize: 13, borderRadius: 4, border: '1px solid var(--color-line)' }} formatter={(value) => fmtInt(Number(value))} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="returning_users" name="Povratni" stackId="u" stroke="var(--color-indigo)" fill="var(--color-indigo)" fillOpacity={0.5} strokeWidth={1.5} />
                      <Area type="monotone" dataKey="new_users" name="Novi" stackId="u" stroke="var(--color-olive)" fill="var(--color-olive)" fillOpacity={0.5} strokeWidth={1.5} />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                  Proxy za retention (GA4 ne izlaže kohortni retention preko Windsor konektora) &mdash; prati da li se udeo povratnih korisnika
                  vremenom širi ili sužava.
                </p>
              </section>
            )}

            {/* Engagement quality by channel */}
            {engagementByChannel.length > 0 && (
              <section>
                <h2 className="font-display mb-4 text-lg font-medium">Kvalitet saobraćaja po kanalu</h2>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                      <th className="py-2 font-normal">Izvor</th>
                      <th className="py-2 text-right font-normal">Sesije</th>
                      <th className="py-2 text-right font-normal">Bounce rate</th>
                      <th className="py-2 text-right font-normal">Angažovanost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {engagementByChannel.map((row) => (
                      <tr key={row.source} className="border-b border-[var(--color-line)]">
                        <td className="py-2">{row.source}</td>
                        <td className="py-2 text-right font-mono">{fmtInt(row.sessions)}</td>
                        <td className="py-2 text-right font-mono">
                          {row.bounce_rate != null ? (
                            <span className={row.bounce_rate > 0.5 ? 'text-[var(--color-rust)]' : ''}>{fmtPct(row.bounce_rate * 100)}</span>
                          ) : '—'}
                        </td>
                        <td className="py-2 text-right font-mono">{row.sessions > 0 ? fmtPct((row.engaged_sessions / row.sessions) * 100) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                  Niska angažovanost uz visoku potrošnju na tom kanalu je signal da klikovi dolaze, ali posetioci ne ostaju &mdash; vredi
                  proveriti landing stranicu i targeting.
                </p>
              </section>
            )}
          </div>

          {/* Combined campaign ranking */}
          <section>
            <h2 className="font-display mb-4 text-lg font-medium">Top kampanje (oba kanala)</h2>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                  <th className="py-2 pr-3 font-normal">Kampanja</th>
                  <th className="py-2 pr-3 font-normal">Kanal</th>
                  <th className="py-2 pr-3 text-right font-normal">Potrošnja</th>
                  <th className="py-2 pr-3 text-right font-normal">Konv.</th>
                  <th className="py-2 pr-3 text-right font-normal">CPA</th>
                  <th className="py-2 text-right font-normal">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {topCampaigns.map((c, i) => (
                  <tr key={`${c.channel}-${c.campaign}-${i}`} className="border-b border-[var(--color-line)]">
                    <td className="py-2 pr-3 max-w-[260px] truncate" title={c.campaign}>{c.campaign}</td>
                    <td className="py-2 pr-3">
                      <span
                        className="rounded px-1.5 py-0.5 text-xs"
                        style={{ background: c.channel === 'google' ? 'var(--color-indigo-soft)' : '#eef3e9', color: CHANNEL_COLOR[c.channel] }}
                      >
                        {CHANNEL_LABEL[c.channel]}
                      </span>
                    </td>
                    <td className="py-2 pr-3 text-right font-mono">{fmtEUR(c.spend)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{fmtInt(c.conversions)}</td>
                    <td className="py-2 pr-3 text-right font-mono">{c.conversions > 0 ? fmtEUR(c.cpa) : '—'}</td>
                    <td className="py-2 text-right font-mono">{c.spend > 0 ? `${c.roas.toFixed(2)}x` : '—'}</td>
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
