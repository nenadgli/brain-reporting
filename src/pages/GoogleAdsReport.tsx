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

const CAMPAIGN_TYPE_LABEL: Record<string, string> = {
  SEARCH: 'Search',
  PERFORMANCE_MAX: 'Performance Max',
  DISPLAY: 'Display',
  MULTI_CHANNEL: 'App / Multi-channel',
  DEMAND_GEN: 'Demand Gen',
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

type Totals = { impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }
type SortKey = 'spend' | 'conversions' | 'roas' | 'conv_rate'
type Direction = 'up' | 'down' | 'flat'

function pctChange(curr: number, prev: number): { pct: number; dir: Direction } {
  if (prev === 0) return { pct: curr === 0 ? 0 : 100, dir: curr > 0 ? 'up' : 'flat' }
  const pct = ((curr - prev) / prev) * 100
  return { pct, dir: pct > 0.5 ? 'up' : pct < -0.5 ? 'down' : 'flat' }
}

function ChangeBadge({ dir, pct, favorable }: { dir: Direction; pct: number; favorable: 'up' | 'down' | 'neutral' }) {
  const isGood = favorable === 'neutral' ? null : dir === favorable
  const color =
    dir === 'flat' || isGood === null
      ? 'text-[var(--color-ink-soft)]'
      : isGood
        ? 'text-[var(--color-olive)]'
        : 'text-[var(--color-rust)]'
  const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '·'
  return (
    <span className={`ml-2 font-mono text-xs ${color}`}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

const emptyTotals: Totals = { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversion_value: 0 }

export default function GoogleAdsReport() {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<SortKey>('spend')
  const [termsOnlyZeroConv, setTermsOnlyZeroConv] = useState(false)

  const [dateRange, setDateRange] = useState<{ current: [string, string]; previous: [string, string] | null } | null>(null)
  const [trend, setTrend] = useState<{ report_date: string; spend: number; conversions: number }[]>([])
  const [totals, setTotals] = useState<Totals>(emptyTotals)
  const [prevTotals, setPrevTotals] = useState<Totals>(emptyTotals)
  const [byCampaignType, setByCampaignType] = useState<{ campaign_type: string; spend: number; clicks: number; conversions: number; conversion_value: number }[]>([])
  const [byDevice, setByDevice] = useState<{ device: string; spend: number; clicks: number; impressions: number; conversions: number }[]>([])
  const [byCampaign, setByCampaign] = useState<{ campaign: string; campaign_type: string | null; impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }[]>([])
  const [impressionShare, setImpressionShare] = useState<number | null>(null)
  const [topKeywords, setTopKeywords] = useState<{ keyword_text: string; keyword_match_type: string | null; clicks: number; spend: number; conversions: number; avg_quality_score: number | null }[]>([])
  const [topTerms, setTopTerms] = useState<{ search_term: string; impressions: number; clicks: number; spend: number; conversions: number }[]>([])
  const [topCompetitors, setTopCompetitors] = useState<{ domain: string; campaign_count: number; occurrences: number }[]>([])

  useEffect(() => {
    async function loadClients() {
      const { data: sourceRows, error: sourceError } = await supabase.from('data_sources').select('client_id').eq('provider', 'google_ads')
      if (sourceError || !sourceRows || sourceRows.length === 0) {
        setError('Nijedan klijent nema povezan Google Ads nalog.')
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

  // Step 1: find the actual available date range for this client, then split into current/previous halves.
  useEffect(() => {
    if (!selectedId) return
    async function findRange() {
      setLoading(true)
      setError(null)
      const { data, error: trendError } = await supabase
        .from('google_ads_metrics')
        .select('report_date')
        .eq('client_id', selectedId)
        .order('report_date', { ascending: true })
        .limit(1)
      const { data: lastRow } = await supabase
        .from('google_ads_metrics')
        .select('report_date')
        .eq('client_id', selectedId)
        .order('report_date', { ascending: false })
        .limit(1)

      if (trendError || !data || data.length === 0 || !lastRow || lastRow.length === 0) {
        setError('Nema Google Ads podataka za ovog klijenta još uvek.')
        setLoading(false)
        return
      }
      const minDate = data[0].report_date as string
      const maxDate = lastRow[0].report_date as string
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

  // Step 2: once we know the date windows, fetch everything via aggregation RPCs in parallel.
  useEffect(() => {
    if (!selectedId || !dateRange) return
    async function loadAll() {
      setLoading(true)
      setError(null)
      const [cs, ce] = dateRange!.current
      const fullStart = dateRange!.previous ? dateRange!.previous[0] : cs

      const calls = [
        supabase.rpc('google_ads_daily_trend', { p_client_id: selectedId, p_start: fullStart, p_end: ce }),
        supabase.rpc('google_ads_period_totals', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        dateRange!.previous
          ? supabase.rpc('google_ads_period_totals', { p_client_id: selectedId, p_start: dateRange!.previous[0], p_end: dateRange!.previous[1] })
          : Promise.resolve({ data: [emptyTotals], error: null }),
        supabase.rpc('google_ads_campaign_type_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('google_ads_device_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('google_ads_campaign_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('google_ads_impression_share', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('google_ads_top_keywords', { p_client_id: selectedId, p_start: cs, p_end: ce, p_limit: 20 }),
        supabase.rpc('google_ads_top_search_terms', { p_client_id: selectedId, p_start: cs, p_end: ce, p_zero_conv_only: termsOnlyZeroConv, p_limit: 25 }),
        supabase.rpc('google_ads_top_competitors', { p_client_id: selectedId, p_start: cs, p_end: ce, p_limit: 12 }),
      ] as const

      const [trendRes, totalsRes, prevTotalsRes, ctRes, devRes, campRes, isRes, kwRes, termsRes, compRes] = await Promise.all(calls)

      if (trendRes.error || totalsRes.error) {
        setError('Nije moguće učitati Google Ads podatke.')
        setLoading(false)
        return
      }

      setTrend(
        (trendRes.data ?? []).map((r: Record<string, unknown>) => ({
          report_date: r.report_date as string,
          spend: Number(r.spend ?? 0),
          conversions: Number(r.conversions ?? 0),
        }))
      )
      setTotals((totalsRes.data?.[0] as Totals) ?? emptyTotals)
      setPrevTotals((prevTotalsRes.data?.[0] as Totals) ?? emptyTotals)
      setByCampaignType(ctRes.data ?? [])
      setByDevice(devRes.data ?? [])
      setByCampaign(campRes.data ?? [])
      setImpressionShare(isRes.data?.[0]?.avg_share ?? null)
      setTopKeywords(kwRes.data ?? [])
      setTopTerms(termsRes.data ?? [])
      setTopCompetitors(compRes.data ?? [])
      setLoading(false)
    }
    loadAll()
  }, [selectedId, dateRange, termsOnlyZeroConv])

  function deriveKpis(t: Totals) {
    const ctr = t.impressions > 0 ? (t.clicks / t.impressions) * 100 : 0
    const cpc = t.clicks > 0 ? t.spend / t.clicks : 0
    const convRate = t.clicks > 0 ? (t.conversions / t.clicks) * 100 : 0
    const cpa = t.conversions > 0 ? t.spend / t.conversions : 0
    const roas = t.spend > 0 ? t.conversion_value / t.spend : 0
    return { ctr, cpc, convRate, cpa, roas }
  }
  const kpis = useMemo(() => deriveKpis(totals), [totals])
  const prevKpis = useMemo(() => deriveKpis(prevTotals), [prevTotals])
  const hasComparison = dateRange?.previous != null

  const totalSpendForShare = totals.spend || 1

  const campaignRows = useMemo(() => {
    const rows = byCampaign.map((r) => ({
      campaign: r.campaign,
      type: r.campaign_type,
      impressions: r.impressions,
      clicks: r.clicks,
      spend: r.spend,
      conversions: r.conversions,
      conversion_value: r.conversion_value,
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
  }, [byCampaign, sortKey])

  const rangeLabel = dateRange
    ? `${dateRange.current[0].slice(5)} – ${dateRange.current[1].slice(5)}` +
      (dateRange.previous ? ` vs ${dateRange.previous[0].slice(5)} – ${dateRange.previous[1].slice(5)}` : '')
    : ''

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
          <p className="mt-2 text-[var(--color-ink-soft)]">{rangeLabel ? `Period: ${rangeLabel}` : 'Učitavanje perioda…'} &middot; svi tipovi kampanja i uređaji</p>
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
          <section className="mb-10 grid grid-cols-5 gap-px border border-[var(--color-line)] bg-[var(--color-line)]">
            {[
              { label: 'Potrošnja', val: fmtEUR(totals.spend), curr: totals.spend, prev: prevTotals.spend, favorable: 'neutral' as const },
              { label: 'Impresije', val: fmtInt(totals.impressions), curr: totals.impressions, prev: prevTotals.impressions, favorable: 'neutral' as const },
              { label: 'Klikovi', val: fmtInt(totals.clicks), curr: totals.clicks, prev: prevTotals.clicks, favorable: 'neutral' as const },
              { label: 'CTR', val: fmtPct(kpis.ctr), curr: kpis.ctr, prev: prevKpis.ctr, favorable: 'up' as const },
              { label: 'Prosečan CPC', val: fmtEUR(kpis.cpc), curr: kpis.cpc, prev: prevKpis.cpc, favorable: 'down' as const },
              { label: 'Konverzije', val: fmtInt(totals.conversions), curr: totals.conversions, prev: prevTotals.conversions, favorable: 'up' as const },
              { label: 'Vrednost konverzija', val: fmtEUR(totals.conversion_value), curr: totals.conversion_value, prev: prevTotals.conversion_value, favorable: 'up' as const },
              { label: 'ROAS', val: `${kpis.roas.toFixed(2)}x`, curr: kpis.roas, prev: prevKpis.roas, favorable: 'up' as const },
              { label: 'CPA', val: fmtEUR(kpis.cpa), curr: kpis.cpa, prev: prevKpis.cpa, favorable: 'down' as const },
              { label: 'Stopa konverzije', val: fmtPct(kpis.convRate), curr: kpis.convRate, prev: prevKpis.convRate, favorable: 'up' as const },
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
            <h2 className="font-display mb-4 text-lg font-medium">Potrošnja i konverzije po danu</h2>
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
                  <Line yAxisId="conv" type="monotone" dataKey="conversions" name="Konverzije" stroke="var(--color-olive)" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          <div className="mb-10 grid grid-cols-2 gap-8">
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Po tipu kampanje</h2>
              <div className="space-y-3">
                {byCampaignType.map((row) => {
                  const share = (row.spend / totalSpendForShare) * 100
                  return (
                    <div key={row.campaign_type}>
                      <div className="mb-1 flex justify-between text-sm">
                        <span>{CAMPAIGN_TYPE_LABEL[row.campaign_type] ?? row.campaign_type}</span>
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
                  {byDevice.map((row) => (
                    <tr key={row.device} className="border-b border-[var(--color-line)]">
                      <td className="py-2">{DEVICE_LABEL[row.device] ?? row.device}</td>
                      <td className="py-2 text-right font-mono">{fmtEUR(row.spend)}</td>
                      <td className="py-2 text-right font-mono">{row.impressions > 0 ? fmtPct((row.clicks / row.impressions) * 100) : '—'}</td>
                      <td className="py-2 text-right font-mono">{fmtInt(row.conversions)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {impressionShare != null && (
            <section className="mb-10">
              <h2 className="font-display mb-4 text-lg font-medium">Search Impression Share</h2>
              <div className="grid grid-cols-3 gap-px border border-[var(--color-line)] bg-[var(--color-line)]">
                <div className="bg-white p-4">
                  <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Osvojeni udeo</p>
                  <p className="font-display mt-1 text-2xl">{fmtPct(impressionShare)}</p>
                </div>
                <div className="col-span-2 bg-white p-4 flex items-center">
                  <p className="text-xs text-[var(--color-ink-soft)]">
                    Windsor trenutno ne izlaže "izgubljeno zbog budžeta/ranga" kao brojčane vrednosti za ovaj nalog — samo ukupan osvojeni udeo.
                  </p>
                </div>
              </div>
            </section>
          )}

          {topCompetitors.length > 0 && (
            <section className="mb-10">
              <h2 className="font-display mb-2 text-lg font-medium">Konkurencija (iste aukcije)</h2>
              <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
                Domeni koji su se pojavili u istim Google Ads aukcijama kao i vi. Windsor trenutno ne daje overlap rate ni druge procentualne
                metrike konkurencije za ovaj nalog — ovo je lista prisustva, ne rangiranje po jačini.
              </p>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 font-normal">Domen</th>
                    <th className="py-2 text-right font-normal">Kampanje u kojima se pojavljuje</th>
                    <th className="py-2 text-right font-normal">Pojavljivanja</th>
                  </tr>
                </thead>
                <tbody>
                  {topCompetitors.map((c) => (
                    <tr key={c.domain} className="border-b border-[var(--color-line)]">
                      <td className="py-2">{c.domain}</td>
                      <td className="py-2 text-right font-mono">{c.campaign_count}</td>
                      <td className="py-2 text-right font-mono">{c.occurrences}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {topKeywords.length > 0 && (
            <section className="mb-10">
              <h2 className="font-display mb-4 text-lg font-medium">Top ključne reči po potrošnji</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 pr-3 font-normal">Ključna reč</th>
                    <th className="py-2 pr-3 font-normal">Tip</th>
                    <th className="py-2 pr-3 text-right font-normal">Potrošnja</th>
                    <th className="py-2 pr-3 text-right font-normal">Klikovi</th>
                    <th className="py-2 pr-3 text-right font-normal">Konv.</th>
                    <th className="py-2 text-right font-normal">Quality Score</th>
                  </tr>
                </thead>
                <tbody>
                  {topKeywords.map((k) => (
                    <tr key={`${k.keyword_text}::${k.keyword_match_type}`} className="border-b border-[var(--color-line)]">
                      <td className="py-2 pr-3">{k.keyword_text}</td>
                      <td className="py-2 pr-3 text-[var(--color-ink-soft)]">{k.keyword_match_type ?? '—'}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtEUR(k.spend)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(k.clicks)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(k.conversions)}</td>
                      <td className="py-2 text-right font-mono">
                        {k.avg_quality_score != null ? (
                          <span className={k.avg_quality_score >= 7 ? 'text-[var(--color-olive)]' : k.avg_quality_score <= 4 ? 'text-[var(--color-rust)]' : ''}>
                            {k.avg_quality_score.toFixed(1)}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {topTerms.length > 0 && (
            <section className="mb-10">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="font-display text-lg font-medium">Search termini</h2>
                <label className="flex items-center gap-2 text-xs text-[var(--color-ink-soft)]">
                  <input type="checkbox" checked={termsOnlyZeroConv} onChange={(e) => setTermsOnlyZeroConv(e.target.checked)} />
                  Samo bez konverzija (kandidati za negative keywords)
                </label>
              </div>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 pr-3 font-normal">Pretraga korisnika</th>
                    <th className="py-2 pr-3 text-right font-normal">Potrošnja</th>
                    <th className="py-2 pr-3 text-right font-normal">Klikovi</th>
                    <th className="py-2 text-right font-normal">Konv.</th>
                  </tr>
                </thead>
                <tbody>
                  {topTerms.map((t) => (
                    <tr key={t.search_term} className="border-b border-[var(--color-line)]">
                      <td className="py-2 pr-3">{t.search_term}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtEUR(t.spend)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(t.clicks)}</td>
                      <td className="py-2 text-right font-mono">
                        {t.conversions === 0 && t.clicks > 0 ? <span className="text-[var(--color-rust)]">0</span> : fmtInt(t.conversions)}
                      </td>
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
                  ['conversions', 'Konverzije'],
                  ['roas', 'ROAS'],
                  ['conv_rate', 'Stopa konverzije'],
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
                  {campaignRows.map((row) => (
                    <tr key={row.campaign} className="border-b border-[var(--color-line)]">
                      <td className="py-2.5 pr-3 max-w-[220px] truncate" title={row.campaign}>{row.campaign}</td>
                      <td className="py-2.5 pr-3 text-[var(--color-ink-soft)]">{row.type ? CAMPAIGN_TYPE_LABEL[row.type] ?? row.type : '—'}</td>
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
