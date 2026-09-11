import { useEffect, useMemo, useState } from 'react'
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts'
import { supabase, type Client, type GoogleAdsMetric } from '../lib/supabase'

const AGENCY_ID = '00000000-0000-0000-0000-000000000001'

const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
  SEARCH: 'Search',
  PERFORMANCE_MAX: 'Performance Max',
  DISPLAY: 'Display',
  MULTI_CHANNEL: 'App / Multi-channel',
  SHOPPING: 'Shopping',
  VIDEO: 'Video',
}

const DEVICE_LABEL: Record<string, string> = {
  DESKTOP: 'Desktop',
  MOBILE: 'Mobilni',
  TABLET: 'Tablet',
  CONNECTED_TV: 'Connected TV',
  OTHER: 'Ostalo',
}

const fmtEUR = (n: number) => `€${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtInt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmtPct = (n: number) => `${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`

type SortKey = 'spend' | 'conversions' | 'roas' | 'conv_rate'

export default function GoogleAdsReport() {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [metrics, setMetrics] = useState<GoogleAdsMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('spend')

  // Load clients that actually have a google_ads data source.
  useEffect(() => {
    async function loadClients() {
      const { data: sourceRows, error: sourceError } = await supabase
        .from('data_sources')
        .select('client_id')
        .eq('provider', 'google_ads')

      if (sourceError || !sourceRows || sourceRows.length === 0) {
        setError('Nijedan klijent nema povezan Google Ads nalog.')
        setLoading(false)
        return
      }

      const clientIds = [...new Set(sourceRows.map((r) => r.client_id))]

      const { data: clientRows, error: clientError } = await supabase
        .from('clients')
        .select('*')
        .eq('agency_id', AGENCY_ID)
        .in('id', clientIds)
        .order('name')

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
    async function loadMetrics() {
      setLoading(true)
      setError(null)
      const { data, error: metricError } = await supabase
        .from('google_ads_metrics')
        .select('*')
        .eq('client_id', selectedId)
        .order('report_date', { ascending: true })

      if (metricError) {
        setError('Nije moguće učitati Google Ads podatke.')
      } else {
        setMetrics(data ?? [])
      }
      setLoading(false)
    }
    loadMetrics()
  }, [selectedId])

  // Overall KPI totals
  const totals = useMemo(() => {
    const t = { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversion_value: 0 }
    metrics.forEach((m) => {
      t.impressions += m.impressions
      t.clicks += m.clicks
      t.spend += m.spend
      t.conversions += m.conversions
      t.conversion_value += m.conversion_value
    })
    return t
  }, [metrics])

  const kpis = useMemo(() => {
    const ctr = totals.impressions > 0 ? (totals.clicks / totals.impressions) * 100 : 0
    const cpc = totals.clicks > 0 ? totals.spend / totals.clicks : 0
    const cpm = totals.impressions > 0 ? (totals.spend / totals.impressions) * 1000 : 0
    const convRate = totals.clicks > 0 ? (totals.conversions / totals.clicks) * 100 : 0
    const cpa = totals.conversions > 0 ? totals.spend / totals.conversions : 0
    const roas = totals.spend > 0 ? totals.conversion_value / totals.spend : 0
    return { ctr, cpc, cpm, convRate, cpa, roas }
  }, [totals])

  // Trend: spend + conversions per day
  const trendData = useMemo(() => {
    const byDate: Record<string, { date: string; spend: number; conversions: number }> = {}
    metrics.forEach((m) => {
      if (!byDate[m.report_date]) byDate[m.report_date] = { date: m.report_date, spend: 0, conversions: 0 }
      byDate[m.report_date].spend += m.spend
      byDate[m.report_date].conversions += m.conversions
    })
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
  }, [metrics])

  // Campaign type breakdown
  const byCampaignType = useMemo(() => {
    const sums: Record<string, { spend: number; clicks: number; conversions: number; conversion_value: number }> = {}
    metrics.forEach((m) => {
      const key = m.campaign_type ?? 'OSTALO'
      if (!sums[key]) sums[key] = { spend: 0, clicks: 0, conversions: 0, conversion_value: 0 }
      sums[key].spend += m.spend
      sums[key].clicks += m.clicks
      sums[key].conversions += m.conversions
      sums[key].conversion_value += m.conversion_value
    })
    return Object.entries(sums).sort((a, b) => b[1].spend - a[1].spend)
  }, [metrics])

  const totalSpendForShare = totals.spend || 1

  // Device breakdown
  const byDevice = useMemo(() => {
    const sums: Record<string, { spend: number; clicks: number; impressions: number; conversions: number }> = {}
    metrics.forEach((m) => {
      const key = m.device ?? 'OTHER'
      if (!sums[key]) sums[key] = { spend: 0, clicks: 0, impressions: 0, conversions: 0 }
      sums[key].spend += m.spend
      sums[key].clicks += m.clicks
      sums[key].impressions += m.impressions
      sums[key].conversions += m.conversions
    })
    return Object.entries(sums).sort((a, b) => b[1].spend - a[1].spend)
  }, [metrics])

  // Search impression share (impression-weighted average, search campaigns only)
  const impressionShareStats = useMemo(() => {
    const searchRows = metrics.filter((m) => m.campaign_type === 'SEARCH' && m.search_impression_share != null)
    if (searchRows.length === 0) return null
    const weightedSum = searchRows.reduce((acc, m) => acc + (m.search_impression_share ?? 0) * m.impressions, 0)
    const weight = searchRows.reduce((acc, m) => acc + m.impressions, 0)
    const avgShare = weight > 0 ? (weightedSum / weight) * 100 : 0

    const lostBudgetRows = searchRows.filter((m) => m.search_lost_is_budget != null)
    const lostBudget =
      lostBudgetRows.length > 0
        ? (lostBudgetRows.reduce((acc, m) => acc + (m.search_lost_is_budget ?? 0) * m.impressions, 0) /
            lostBudgetRows.reduce((acc, m) => acc + m.impressions, 0)) *
          100
        : null

    const lostRankRows = searchRows.filter((m) => m.search_lost_is_rank != null)
    const lostRank =
      lostRankRows.length > 0
        ? (lostRankRows.reduce((acc, m) => acc + (m.search_lost_is_rank ?? 0) * m.impressions, 0) /
            lostRankRows.reduce((acc, m) => acc + m.impressions, 0)) *
          100
        : null

    return { avgShare, lostBudget, lostRank }
  }, [metrics])

  // Per-campaign aggregation with derived metrics, for the sortable table
  const byCampaign = useMemo(() => {
    const sums: Record<
      string,
      { campaign: string; type: string | null; impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }
    > = {}
    metrics.forEach((m) => {
      if (!sums[m.campaign]) {
        sums[m.campaign] = {
          campaign: m.campaign,
          type: m.campaign_type,
          impressions: 0,
          clicks: 0,
          spend: 0,
          conversions: 0,
          conversion_value: 0,
        }
      }
      sums[m.campaign].impressions += m.impressions
      sums[m.campaign].clicks += m.clicks
      sums[m.campaign].spend += m.spend
      sums[m.campaign].conversions += m.conversions
      sums[m.campaign].conversion_value += m.conversion_value
    })
    const rows = Object.values(sums).map((r) => ({
      ...r,
      ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
      cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
      convRate: r.clicks > 0 ? (r.conversions / r.clicks) * 100 : 0,
      cpa: r.conversions > 0 ? r.spend / r.conversions : 0,
      roas: r.spend > 0 ? r.conversion_value / r.spend : 0,
    }))
    return rows.sort((a, b) => {
      if (sortKey === 'spend') return b.spend - a.spend
      if (sortKey === 'conversions') return b.conversions - a.conversions
      if (sortKey === 'roas') return b.roas - a.roas
      return b.convRate - a.convRate
    })
  }, [metrics, sortKey])

  if (error && clients.length === 0) {
    return <p className="text-[var(--color-rust)]">{error}</p>
  }

  return (
    <div>
      <header className="mb-8 flex items-end justify-between border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Google Ads</p>
          <h1 className="font-display mt-1 text-4xl font-medium">
            {loading ? '…' : clients.find((c) => c.id === selectedId)?.name}
          </h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">Poslednjih nekoliko dana &middot; svi tipovi kampanja i uređaji</p>
        </div>
        {clients.length > 1 && (
          <label className="text-sm">
            <span className="mr-2 text-[var(--color-ink-soft)]">Klijent</span>
            <select
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="rounded border border-[var(--color-line)] bg-white px-3 py-1.5"
            >
              {clients.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </header>

      {error && <p className="text-[var(--color-rust)]">{error}</p>}

      {!error && !loading && (
        <>
          {/* KPI grid */}
          <section className="mb-10 grid grid-cols-5 gap-px border border-[var(--color-line)] bg-[var(--color-line)]">
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Potrošnja</p>
              <p className="font-display mt-1 text-2xl">{fmtEUR(totals.spend)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Impresije</p>
              <p className="font-display mt-1 text-2xl">{fmtInt(totals.impressions)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Klikovi</p>
              <p className="font-display mt-1 text-2xl">{fmtInt(totals.clicks)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">CTR</p>
              <p className="font-display mt-1 text-2xl">{fmtPct(kpis.ctr)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Prosečan CPC</p>
              <p className="font-display mt-1 text-2xl">{fmtEUR(kpis.cpc)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Konverzije</p>
              <p className="font-display mt-1 text-2xl">{fmtInt(totals.conversions)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Vrednost konverzija</p>
              <p className="font-display mt-1 text-2xl">{fmtEUR(totals.conversion_value)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">ROAS</p>
              <p className="font-display mt-1 text-2xl">{kpis.roas.toFixed(2)}x</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">CPA</p>
              <p className="font-display mt-1 text-2xl">{fmtEUR(kpis.cpa)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Stopa konverzije</p>
              <p className="font-display mt-1 text-2xl">{fmtPct(kpis.convRate)}</p>
            </div>
          </section>

          {/* Trend chart */}
          <section className="mb-10">
            <h2 className="font-display mb-4 text-lg font-medium">Potrošnja i konverzije po danu</h2>
            <div className="h-64 rounded border border-[var(--color-line)] bg-white p-4">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData}>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(d) => String(d).slice(5)}
                    tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }}
                    axisLine={{ stroke: 'var(--color-line)' }}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="spend"
                    tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    yAxisId="conv"
                    orientation="right"
                    tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 13, borderRadius: 4, border: '1px solid var(--color-line)' }}
                    formatter={(value, name) => (name === 'Potrošnja' ? fmtEUR(Number(value)) : Number(value).toFixed(1))}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line yAxisId="spend" type="monotone" dataKey="spend" name="Potrošnja" stroke="var(--color-indigo)" strokeWidth={2} dot={false} />
                  <Line yAxisId="conv" type="monotone" dataKey="conversions" name="Konverzije" stroke="var(--color-olive)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <div className="mb-10 grid grid-cols-2 gap-8">
            {/* Campaign type breakdown */}
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Po tipu kampanje</h2>
              <div className="space-y-3">
                {byCampaignType.map(([type, vals]) => {
                  const share = (vals.spend / totalSpendForShare) * 100
                  return (
                    <div key={type}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span>{CAMPAIGN_TYPE_LABEL[type] ?? type}</span>
                        <span className="font-mono text-[var(--color-ink-soft)]">
                          {fmtEUR(vals.spend)} &middot; {share.toFixed(0)}%
                        </span>
                      </div>
                      <div className="h-1.5 w-full bg-[var(--color-indigo-soft)]">
                        <div className="h-1.5 bg-[var(--color-indigo)]" style={{ width: `${share}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            {/* Device breakdown */}
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Po uređaju</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 font-normal">Uređaj</th>
                    <th className="py-2 text-right font-normal">Potrošnja</th>
                    <th className="py-2 text-right font-normal">CTR</th>
                    <th className="py-2 text-right font-normal">Konv.</th>
                  </tr>
                </thead>
                <tbody>
                  {byDevice.map(([device, vals]) => (
                    <tr key={device} className="border-b border-[var(--color-line)]">
                      <td className="py-2">{DEVICE_LABEL[device] ?? device}</td>
                      <td className="py-2 text-right font-mono">{fmtEUR(vals.spend)}</td>
                      <td className="py-2 text-right font-mono">
                        {vals.impressions > 0 ? fmtPct((vals.clicks / vals.impressions) * 100) : '—'}
                      </td>
                      <td className="py-2 text-right font-mono">{fmtInt(vals.conversions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {/* Search impression share */}
          {impressionShareStats && (
            <section className="mb-10">
              <h2 className="font-display mb-4 text-lg font-medium">Search Impression Share</h2>
              <div className="grid grid-cols-3 gap-px border border-[var(--color-line)] bg-[var(--color-line)]">
                <div className="bg-white p-4">
                  <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Osvojeni udeo</p>
                  <p className="font-display mt-1 text-2xl">{fmtPct(impressionShareStats.avgShare)}</p>
                </div>
                <div className="bg-white p-4">
                  <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Izgubljeno (budžet)</p>
                  <p className="font-display mt-1 text-2xl">
                    {impressionShareStats.lostBudget != null ? fmtPct(impressionShareStats.lostBudget) : '—'}
                  </p>
                </div>
                <div className="bg-white p-4">
                  <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Izgubljeno (rang)</p>
                  <p className="font-display mt-1 text-2xl">
                    {impressionShareStats.lostRank != null ? fmtPct(impressionShareStats.lostRank) : '—'}
                  </p>
                </div>
              </div>
            </section>
          )}

          {/* Campaign table */}
          <section>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-lg font-medium">Sve kampanje</h2>
              <div className="flex gap-1 text-xs">
                {(
                  [
                    ['spend', 'Potrošnja'],
                    ['conversions', 'Konverzije'],
                    ['roas', 'ROAS'],
                    ['conv_rate', 'Stopa konverzije'],
                  ] as [SortKey, string][]
                ).map(([key, label]) => (
                  <button
                    key={key}
                    onClick={() => setSortKey(key)}
                    className={`rounded px-2 py-1 ${sortKey === key ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo)]' : 'text-[var(--color-ink-soft)]'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 pr-3 font-normal">Kampanja</th>
                    <th className="py-2 pr-3 font-normal">Tip</th>
                    <th className="py-2 pr-3 text-right font-normal">Potrošnja</th>
                    <th className="py-2 pr-3 text-right font-normal">Impr.</th>
                    <th className="py-2 pr-3 text-right font-normal">Klikovi</th>
                    <th className="py-2 pr-3 text-right font-normal">CTR</th>
                    <th className="py-2 pr-3 text-right font-normal">CPC</th>
                    <th className="py-2 pr-3 text-right font-normal">Konv.</th>
                    <th className="py-2 pr-3 text-right font-normal">Stopa konv.</th>
                    <th className="py-2 pr-3 text-right font-normal">CPA</th>
                    <th className="py-2 text-right font-normal">ROAS</th>
                  </tr>
                </thead>
                <tbody>
                  {byCampaign.map((row) => (
                    <tr key={row.campaign} className="border-b border-[var(--color-line)]">
                      <td className="py-2.5 pr-3 max-w-[220px] truncate" title={row.campaign}>
                        {row.campaign}
                      </td>
                      <td className="py-2.5 pr-3 text-[var(--color-ink-soft)]">
                        {row.type ? CAMPAIGN_TYPE_LABEL[row.type] ?? row.type : '—'}
                      </td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtEUR(row.spend)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtInt(row.impressions)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtInt(row.clicks)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtPct(row.ctr)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtEUR(row.cpc)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtInt(row.conversions)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtPct(row.convRate)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{row.conversions > 0 ? fmtEUR(row.cpa) : '—'}</td>
                      <td className="py-2.5 text-right font-mono">{row.spend > 0 ? `${row.roas.toFixed(2)}x` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
