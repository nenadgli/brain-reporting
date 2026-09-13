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
import { supabase, type Client } from '../lib/supabase'

const AGENCY_ID = '00000000-0000-0000-0000-000000000001'

const OBJECTIVE_LABEL: Record<string, string> = {
  OUTCOME_SALES: 'Prodaja',
  OUTCOME_TRAFFIC: 'Saobraćaj',
  OUTCOME_ENGAGEMENT: 'Angažovanje',
  OUTCOME_LEADS: 'Leadovi',
  OUTCOME_AWARENESS: 'Svesnost o brendu',
  OUTCOME_APP_PROMOTION: 'Promocija aplikacije',
  APP_INSTALLS: 'Instalacije aplikacije',
  LINK_CLICKS: 'Klikovi na link',
}

const PLATFORM_LABEL: Record<string, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  audience_network: 'Audience Network',
  messenger: 'Messenger',
  threads: 'Threads',
  other: 'Ostalo',
}

const DEVICE_LABEL: Record<string, string> = {
  mobile_app: 'Mobilna aplikacija',
  mobile_web: 'Mobilni web',
  desktop: 'Desktop',
  other: 'Ostalo',
}

const fmtEUR = (n: number) => `€${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtInt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmtPct = (n: number) => `${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`

type Totals = { impressions: number; clicks: number; spend: number; reach: number; conversions: number; conversion_value: number }
type SortKey = 'spend' | 'conversions' | 'roas'
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

const emptyTotals: Totals = { impressions: 0, clicks: 0, spend: 0, reach: 0, conversions: 0, conversion_value: 0 }

export default function FacebookAdsReport() {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('spend')

  const [dateRange, setDateRange] = useState<{ current: [string, string]; previous: [string, string] | null } | null>(null)
  const [trend, setTrend] = useState<{ report_date: string; spend: number; conversions: number }[]>([])
  const [totals, setTotals] = useState<Totals>(emptyTotals)
  const [prevTotals, setPrevTotals] = useState<Totals>(emptyTotals)
  const [byObjective, setByObjective] = useState<{ objective: string; spend: number; clicks: number; conversions: number; conversion_value: number }[]>([])
  const [byPlatform, setByPlatform] = useState<{ publisher_platform: string; spend: number; clicks: number; impressions: number; reach: number }[]>([])
  const [byDevice, setByDevice] = useState<{ device_platform: string; spend: number; clicks: number; impressions: number }[]>([])
  const [byCampaign, setByCampaign] = useState<{ campaign: string; objective: string | null; impressions: number; clicks: number; spend: number; reach: number; conversions: number; conversion_value: number }[]>([])
  const [topCreatives, setTopCreatives] = useState<{ ad_name: string; adset_name: string | null; campaign: string | null; impressions: number; clicks: number; spend: number }[]>([])

  useEffect(() => {
    async function loadClients() {
      const { data: sourceRows, error: sourceError } = await supabase.from('data_sources').select('client_id').eq('provider', 'facebook')
      if (sourceError || !sourceRows || sourceRows.length === 0) {
        setError('Nijedan klijent nema povezan Facebook Ads nalog.')
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
      const { data: first } = await supabase.from('facebook_ads_metrics').select('report_date').eq('client_id', selectedId).order('report_date', { ascending: true }).limit(1)
      const { data: last } = await supabase.from('facebook_ads_metrics').select('report_date').eq('client_id', selectedId).order('report_date', { ascending: false }).limit(1)
      if (!first || first.length === 0 || !last || last.length === 0) {
        setError('Nema Facebook Ads podataka za ovog klijenta još uvek.')
        setLoading(false)
        return
      }
      const minDate = first[0].report_date as string
      const maxDate = last[0].report_date as string
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

      const [trendRes, totalsRes, prevTotalsRes, objRes, platRes, devRes, campRes, creativesRes] = await Promise.all([
        supabase.rpc('facebook_ads_daily_trend', { p_client_id: selectedId, p_start: fullStart, p_end: ce }),
        supabase.rpc('facebook_ads_period_totals', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        dateRange!.previous
          ? supabase.rpc('facebook_ads_period_totals', { p_client_id: selectedId, p_start: dateRange!.previous[0], p_end: dateRange!.previous[1] })
          : Promise.resolve({ data: [emptyTotals], error: null }),
        supabase.rpc('facebook_ads_objective_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('facebook_ads_platform_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('facebook_ads_device_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('facebook_ads_campaign_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('facebook_ads_top_creatives', { p_client_id: selectedId, p_start: cs, p_end: ce, p_limit: 20 }),
      ])

      if (trendRes.error || totalsRes.error) {
        setError('Nije moguće učitati Facebook Ads podatke.')
        setLoading(false)
        return
      }

      setTrend((trendRes.data ?? []).map((r: Record<string, unknown>) => ({ report_date: r.report_date as string, spend: Number(r.spend ?? 0), conversions: Number(r.conversions ?? 0) })))
      setTotals((totalsRes.data?.[0] as Totals) ?? emptyTotals)
      setPrevTotals((prevTotalsRes.data?.[0] as Totals) ?? emptyTotals)
      setByObjective(objRes.data ?? [])
      setByPlatform(platRes.data ?? [])
      setByDevice(devRes.data ?? [])
      setByCampaign(campRes.data ?? [])
      setTopCreatives(creativesRes.data ?? [])
      setLoading(false)
    }
    loadAll()
  }, [selectedId, dateRange])

  function deriveKpis(t: Totals) {
    const ctr = t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0
    const cpc = t.clicks > 0 ? t.spend / t.clicks : 0
    const cpa = t.conversions > 0 ? t.spend / t.conversions : 0
    const roas = t.spend > 0 ? t.conversion_value / t.spend : 0
    const frequency = t.reach > 0 ? t.impressions / t.reach : 0
    return { ctr, cpc, cpa, roas, frequency }
  }
  const kpis = useMemo(() => deriveKpis(totals), [totals])
  const prevKpis = useMemo(() => deriveKpis(prevTotals), [prevTotals])
  const hasComparison = dateRange?.previous != null
  const totalSpendForShare = totals.spend || 1

  const campaignRows = useMemo(() => {
    const rows = byCampaign.map((r) => ({
      campaign: r.campaign,
      objective: r.objective,
      impressions: r.impressions,
      clicks: r.clicks,
      spend: r.spend,
      conversions: r.conversions,
      conversion_value: r.conversion_value,
      ctr: r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0,
      cpc: r.clicks > 0 ? r.spend / r.clicks : 0,
      cpa: r.conversions > 0 ? r.spend / r.conversions : 0,
      roas: r.spend > 0 ? r.conversion_value / r.spend : 0,
    }))
    return rows.sort((a, b) => {
      if (sortKey === 'spend') return b.spend - a.spend
      if (sortKey === 'conversions') return b.conversions - a.conversions
      return b.roas - a.roas
    })
  }, [byCampaign, sortKey])

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
          <p className="eyebrow-label">Facebook &amp; Instagram Ads</p>
          <h1 className="font-display mt-1 text-4xl font-medium">{loading ? '…' : clients.find((c) => c.id === selectedId)?.name}</h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">{rangeLabel ? `Period: ${rangeLabel}` : 'Učitavanje perioda…'} &middot; svi ciljevi i plasmani</p>
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
          <section className="mb-10 kpi-grid grid-cols-5">
            {[
              { label: 'Potrošnja', val: fmtEUR(totals.spend), curr: totals.spend, prev: prevTotals.spend, favorable: 'neutral' as const },
              { label: 'Doseg (reach)', val: fmtInt(totals.reach), curr: totals.reach, prev: prevTotals.reach, favorable: 'up' as const },
              { label: 'Impresije', val: fmtInt(totals.impressions), curr: totals.impressions, prev: prevTotals.impressions, favorable: 'neutral' as const },
              { label: 'Frekvencija', val: kpis.frequency.toFixed(2), curr: kpis.frequency, prev: prevKpis.frequency, favorable: 'down' as const },
              { label: 'CTR', val: fmtPct(kpis.ctr), curr: kpis.ctr, prev: prevKpis.ctr, favorable: 'up' as const },
              { label: 'Klikovi', val: fmtInt(totals.clicks), curr: totals.clicks, prev: prevTotals.clicks, favorable: 'neutral' as const },
              { label: 'Prosečan CPC', val: fmtEUR(kpis.cpc), curr: kpis.cpc, prev: prevKpis.cpc, favorable: 'down' as const },
              { label: 'Kupovine', val: fmtInt(totals.conversions), curr: totals.conversions, prev: prevTotals.conversions, favorable: 'up' as const },
              { label: 'ROAS', val: `${kpis.roas.toFixed(2)}x`, curr: kpis.roas, prev: prevKpis.roas, favorable: 'up' as const },
              { label: 'CPA', val: fmtEUR(kpis.cpa), curr: kpis.cpa, prev: prevKpis.cpa, favorable: 'down' as const },
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

          <section className="mb-10">
            <h2 className="font-display mb-4 text-lg font-medium">Potrošnja i kupovine po danu</h2>
            <div className="h-64 rounded border border-[var(--color-line)] bg-white p-4">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trend}>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis dataKey="report_date" tickFormatter={(d) => String(d).slice(5)} tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={{ stroke: 'var(--color-line)' }} tickLine={false} />
                  <YAxis yAxisId="spend" tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
                  <YAxis yAxisId="conv" orientation="right" tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ fontSize: 13, borderRadius: 4, border: '1px solid var(--color-line)' }} formatter={(value, name) => (name === 'Potrošnja' ? fmtEUR(Number(value)) : Number(value).toFixed(1))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Line yAxisId="spend" type="monotone" dataKey="spend" name="Potrošnja" stroke="var(--color-indigo)" strokeWidth={2} dot={false} />
                  <Line yAxisId="conv" type="monotone" dataKey="conversions" name="Kupovine" stroke="var(--color-olive)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <div className="mb-10 grid grid-cols-2 gap-8">
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Po cilju kampanje</h2>
              <div className="space-y-3">
                {byObjective.map((row) => {
                  const share = (row.spend / totalSpendForShare) * 100
                  return (
                    <div key={row.objective}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span>{OBJECTIVE_LABEL[row.objective] ?? row.objective}</span>
                        <span className="font-mono text-[var(--color-ink-soft)]">{fmtEUR(row.spend)} &middot; {share.toFixed(0)}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-[var(--color-indigo-soft)]">
                        <div className="h-1.5 bg-[var(--color-indigo)]" style={{ width: `${share}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </section>

            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Po plasmanu</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 font-normal">Plasman</th>
                    <th className="py-2 text-right font-normal">Potrošnja</th>
                    <th className="py-2 text-right font-normal">CTR</th>
                    <th className="py-2 text-right font-normal">Doseg</th>
                  </tr>
                </thead>
                <tbody>
                  {byPlatform.map((row) => (
                    <tr key={row.publisher_platform} className="border-b border-[var(--color-line)]">
                      <td className="py-2">{PLATFORM_LABEL[row.publisher_platform] ?? row.publisher_platform}</td>
                      <td className="py-2 text-right font-mono">{fmtEUR(row.spend)}</td>
                      <td className="py-2 text-right font-mono">{row.impressions > 0 ? fmtPct((row.clicks / row.impressions) * 100) : '—'}</td>
                      <td className="py-2 text-right font-mono">{fmtInt(row.reach)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <section className="mb-10">
            <h2 className="font-display mb-4 text-lg font-medium">Po uređaju</h2>
            <table className="w-full max-w-md border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                  <th className="py-2 font-normal">Uređaj</th>
                  <th className="py-2 text-right font-normal">Potrošnja</th>
                  <th className="py-2 text-right font-normal">CTR</th>
                </tr>
              </thead>
              <tbody>
                {byDevice.map((row) => (
                  <tr key={row.device_platform} className="border-b border-[var(--color-line)]">
                    <td className="py-2">{DEVICE_LABEL[row.device_platform] ?? row.device_platform}</td>
                    <td className="py-2 text-right font-mono">{fmtEUR(row.spend)}</td>
                    <td className="py-2 text-right font-mono">{row.impressions > 0 ? fmtPct((row.clicks / row.impressions) * 100) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {topCreatives.length > 0 && (
            <section className="mb-10">
              <h2 className="font-display mb-4 text-lg font-medium">Top kreative po potrošnji</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 pr-3 font-normal">Kreativa</th>
                    <th className="py-2 pr-3 font-normal">Ad set</th>
                    <th className="py-2 pr-3 text-right font-normal">Potrošnja</th>
                    <th className="py-2 pr-3 text-right font-normal">Impr.</th>
                    <th className="py-2 text-right font-normal">CTR</th>
                  </tr>
                </thead>
                <tbody>
                  {topCreatives.map((c) => (
                    <tr key={c.ad_name} className="border-b border-[var(--color-line)]">
                      <td className="py-2 pr-3 max-w-[220px] truncate" title={c.ad_name}>{c.ad_name}</td>
                      <td className="py-2 pr-3 text-[var(--color-ink-soft)] max-w-[180px] truncate" title={c.adset_name ?? ''}>{c.adset_name ?? '—'}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtEUR(c.spend)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(c.impressions)}</td>
                      <td className="py-2 text-right font-mono">{c.impressions > 0 ? fmtPct((c.clicks / c.impressions) * 100) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section>
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-display text-lg font-medium">Sve kampanje</h2>
              <div className="flex gap-1 text-xs">
                {([
                  ['spend', 'Potrošnja'],
                  ['conversions', 'Kupovine'],
                  ['roas', 'ROAS'],
                ] as [SortKey, string][]).map(([key, label]) => (
                  <button key={key} onClick={() => setSortKey(key)} className={`rounded px-2 py-1 ${sortKey === key ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo)]' : 'text-[var(--color-ink-soft)]'}`}>
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
                    <th className="py-2 pr-3 font-normal">Cilj</th>
                    <th className="py-2 pr-3 text-right font-normal">Potrošnja</th>
                    <th className="py-2 pr-3 text-right font-normal">Impr.</th>
                    <th className="py-2 pr-3 text-right font-normal">Klikovi</th>
                    <th className="py-2 pr-3 text-right font-normal">CTR</th>
                    <th className="py-2 pr-3 text-right font-normal">CPC</th>
                    <th className="py-2 pr-3 text-right font-normal">Kupovine</th>
                    <th className="py-2 pr-3 text-right font-normal">CPA</th>
                    <th className="py-2 text-right font-normal">ROAS</th>
                  </tr>
                </thead>
                <tbody>
                  {campaignRows.map((row) => (
                    <tr key={row.campaign} className="border-b border-[var(--color-line)]">
                      <td className="py-2.5 pr-3 max-w-[220px] truncate" title={row.campaign}>{row.campaign}</td>
                      <td className="py-2.5 pr-3 text-[var(--color-ink-soft)]">{row.objective ? OBJECTIVE_LABEL[row.objective] ?? row.objective : '—'}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtEUR(row.spend)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtInt(row.impressions)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtInt(row.clicks)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtPct(row.ctr)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtEUR(row.cpc)}</td>
                      <td className="py-2.5 pr-3 text-right font-mono">{fmtInt(row.conversions)}</td>
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
