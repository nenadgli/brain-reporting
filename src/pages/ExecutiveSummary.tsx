import { useEffect, useMemo, useState } from 'react'
import { supabase, type Client } from '../lib/supabase'

const AGENCY_ID = '00000000-0000-0000-0000-000000000001'
const CHANNEL_LABEL: Record<string, string> = { google: 'Google Ads', meta: 'Meta (FB/IG)' }

const fmtEUR = (n: number) => `€${n.toLocaleString('sr-RS', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
const fmtInt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmtPct = (n: number) => `${n.toLocaleString('sr-RS', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`
const fmtPctSigned = (n: number) => `${n >= 0 ? '+' : ''}${n.toLocaleString('sr-RS', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`

type Totals = { impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }
const emptyTotals: Totals = { impressions: 0, clicks: 0, spend: 0, conversions: 0, conversion_value: 0 }

type Insight = { kind: 'good' | 'bad' | 'neutral'; text: string }

export default function ExecutiveSummary() {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dateRange, setDateRange] = useState<{ current: [string, string]; previous: [string, string] | null } | null>(null)
  const [channelTotals, setChannelTotals] = useState<{ channel: string; impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }[]>([])
  const [prevChannelTotals, setPrevChannelTotals] = useState<{ channel: string; impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }[]>([])
  const [campaigns, setCampaigns] = useState<{ channel: string; campaign: string; impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }[]>([])
  const [ga4Verification, setGa4Verification] = useState<{ channel: string; sessions: number; total_users: number; engaged_sessions: number; conversions: number; total_revenue: number }[]>([])
  const [engagementByChannel, setEngagementByChannel] = useState<{ source: string; sessions: number; engaged_sessions: number; bounce_rate: number | null; conversions: number }[]>([])
  const [hasGa4, setHasGa4] = useState(false)

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
        setError('Nijedan klijent trenutno nema oba kanala (Google + Meta) povezana istovremeno.')
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

      const [totRes, prevTotRes, campRes, ga4VerRes, ga4EngRes, ga4SourceCheck] = await Promise.all([
        supabase.rpc('blended_channel_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        dateRange!.previous
          ? supabase.rpc('blended_channel_summary', { p_client_id: selectedId, p_start: dateRange!.previous[0], p_end: dateRange!.previous[1] })
          : Promise.resolve({ data: [], error: null }),
        supabase.rpc('blended_campaign_summary', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('ga4_paid_channel_verification', { p_client_id: selectedId, p_start: cs, p_end: ce }),
        supabase.rpc('ga4_engagement_by_channel', { p_client_id: selectedId, p_start: cs, p_end: ce, p_limit: 10 }),
        supabase.from('data_sources').select('id').eq('client_id', selectedId).eq('provider', 'ga4'),
      ])

      setChannelTotals((totRes as { data: typeof channelTotals }).data ?? [])
      setPrevChannelTotals((prevTotRes as { data: typeof channelTotals }).data ?? [])
      setCampaigns((campRes as { data: typeof campaigns }).data ?? [])
      setGa4Verification((ga4VerRes as { data: typeof ga4Verification }).data ?? [])
      setEngagementByChannel((ga4EngRes as { data: typeof engagementByChannel }).data ?? [])
      setHasGa4(((ga4SourceCheck as { data: unknown[] }).data ?? []).length > 0)
      setLoading(false)
    }
    loadAll()
  }, [selectedId, dateRange])

  const totalsByChannel = useMemo(() => {
    const m: Record<string, Totals> = { google: emptyTotals, meta: emptyTotals }
    channelTotals.forEach((r) => { m[r.channel] = r })
    return m
  }, [channelTotals])

  const prevTotalsByChannel = useMemo(() => {
    const m: Record<string, Totals> = { google: emptyTotals, meta: emptyTotals }
    prevChannelTotals.forEach((r) => { m[r.channel] = r })
    return m
  }, [prevChannelTotals])

  const combined = useMemo(() => {
    const sum = (f: (t: Totals) => number) => f(totalsByChannel.google) + f(totalsByChannel.meta)
    return { impressions: sum((t) => t.impressions), clicks: sum((t) => t.clicks), spend: sum((t) => t.spend), conversions: sum((t) => t.conversions), conversion_value: sum((t) => t.conversion_value) }
  }, [totalsByChannel])

  const prevCombined = useMemo(() => {
    const sum = (f: (t: Totals) => number) => f(prevTotalsByChannel.google) + f(prevTotalsByChannel.meta)
    return { impressions: sum((t) => t.impressions), clicks: sum((t) => t.clicks), spend: sum((t) => t.spend), conversions: sum((t) => t.conversions), conversion_value: sum((t) => t.conversion_value) }
  }, [prevTotalsByChannel])

  const roas = combined.spend > 0 ? combined.conversion_value / combined.spend : 0
  const prevRoas = prevCombined.spend > 0 ? prevCombined.conversion_value / prevCombined.spend : 0
  const spendChangePct = prevCombined.spend > 0 ? ((combined.spend - prevCombined.spend) / prevCombined.spend) * 100 : 0
  const roasChangePct = prevRoas > 0 ? ((roas - prevRoas) / prevRoas) * 100 : 0
  const revenueChangePct = prevCombined.conversion_value > 0 ? ((combined.conversion_value - prevCombined.conversion_value) / prevCombined.conversion_value) * 100 : 0

  const bestCampaign = useMemo(() => {
    const meaningful = campaigns.filter((c) => c.spend >= combined.spend * 0.02 && c.spend > 0)
    if (meaningful.length === 0) return null
    return meaningful.reduce((best, c) => {
      const roasC = c.spend > 0 ? c.conversion_value / c.spend : 0
      const roasBest = best.spend > 0 ? best.conversion_value / best.spend : 0
      return roasC > roasBest ? c : best
    })
  }, [campaigns, combined.spend])

  const worstCampaign = useMemo(() => {
    const candidates = campaigns.filter((c) => c.spend >= combined.spend * 0.02 && c.conversions === 0)
    if (candidates.length === 0) return null
    return candidates.reduce((worst, c) => (c.spend > worst.spend ? c : worst))
  }, [campaigns, combined.spend])

  const topSpendShare = useMemo(() => {
    if (campaigns.length === 0 || combined.spend === 0) return 0
    const top = [...campaigns].sort((a, b) => b.spend - a.spend)[0]
    return (top.spend / combined.spend) * 100
  }, [campaigns, combined.spend])

  const betterChannel = useMemo(() => {
    const gRoas = totalsByChannel.google.spend > 0 ? totalsByChannel.google.conversion_value / totalsByChannel.google.spend : 0
    const mRoas = totalsByChannel.meta.spend > 0 ? totalsByChannel.meta.conversion_value / totalsByChannel.meta.spend : 0
    if (gRoas === 0 && mRoas === 0) return null
    return gRoas >= mRoas ? { name: 'google', roas: gRoas, other: mRoas } : { name: 'meta', roas: mRoas, other: gRoas }
  }, [totalsByChannel])

  const riskyEngagement = useMemo(() => engagementByChannel.filter((r) => r.bounce_rate != null && r.bounce_rate > 0.5 && r.sessions > 100), [engagementByChannel])

  const ga4GapInsight = useMemo(() => {
    return ga4Verification
      .map((row) => {
        const platform = totalsByChannel[row.channel] ?? emptyTotals
        if (platform.conversion_value === 0) return null
        const ratio = row.total_revenue / platform.conversion_value
        return { channel: row.channel, ratio, platformValue: platform.conversion_value, ga4Value: row.total_revenue }
      })
      .filter((x): x is { channel: string; ratio: number; platformValue: number; ga4Value: number } => x !== null && (x.ratio > 1.5 || x.ratio < 0.5))
  }, [ga4Verification, totalsByChannel])

  const insights: Insight[] = useMemo(() => {
    const list: Insight[] = []
    if (dateRange?.previous) {
      list.push({
        kind: spendChangePct >= 0 ? 'neutral' : 'neutral',
        text: `Ukupna potrošnja (Google + Meta) je ${spendChangePct >= 0 ? 'porasla' : 'opala'} za ${fmtPct(Math.abs(spendChangePct))} u odnosu na prethodni period, na ${fmtEUR(combined.spend)}.`,
      })
      list.push({
        kind: roasChangePct >= 0 ? 'good' : 'bad',
        text: `Blended ROAS je ${roasChangePct >= 0 ? 'poboljšan' : 'pogoršan'} (${fmtPctSigned(roasChangePct)}), trenutno na ${roas.toFixed(2)}x.`,
      })
    }
    if (betterChannel) {
      list.push({
        kind: 'neutral',
        text: `${CHANNEL_LABEL[betterChannel.name]} ostvaruje bolji ROAS ovog perioda (${betterChannel.roas.toFixed(2)}x naspram ${betterChannel.other.toFixed(2)}x na drugom kanalu).`,
      })
    }
    if (bestCampaign) {
      const r = bestCampaign.spend > 0 ? bestCampaign.conversion_value / bestCampaign.spend : 0
      list.push({ kind: 'good', text: `Najbolja kampanja po ROAS-u: "${bestCampaign.campaign}" (${CHANNEL_LABEL[bestCampaign.channel]}) — ${r.toFixed(2)}x uz potrošnju od ${fmtEUR(bestCampaign.spend)}. Kandidat za povećanje budžeta.` })
    }
    if (worstCampaign) {
      list.push({ kind: 'bad', text: `Kampanja "${worstCampaign.campaign}" (${CHANNEL_LABEL[worstCampaign.channel]}) je potrošila ${fmtEUR(worstCampaign.spend)} bez ijedne zabeležene konverzije ovog perioda. Vredi proveriti targeting ili pauzirati.` })
    }
    if (topSpendShare > 40) {
      list.push({ kind: 'neutral', text: `${fmtPct(topSpendShare)} ukupnog budžeta ide na jednu jedinu kampanju — koncentracija rizika ako ta kampanja padne u performansama.` })
    }
    riskyEngagement.forEach((r) => {
      list.push({ kind: 'bad', text: `Saobraćaj sa izvora "${r.source}" ima visok bounce rate (${fmtPct((r.bounce_rate ?? 0) * 100)}) uz ${fmtInt(r.sessions)} sesija — posetioci dolaze ali ne ostaju na sajtu.` })
    })
    ga4GapInsight.forEach((g) => {
      if (g.ratio > 1.5) {
        list.push({ kind: 'good', text: `GA4 pripisuje ${fmtEUR(g.ga4Value)} prihoda saobraćaju sa ${CHANNEL_LABEL[g.channel]}, znatno više od ${fmtEUR(g.platformValue)} koliko platforma sama prijavljuje — kanal verovatno doprinosi više nego što njegov sopstveni izveštaj pokazuje.` })
      } else {
        list.push({ kind: 'bad', text: `GA4 pripisuje samo ${fmtEUR(g.ga4Value)} prihoda saobraćaju sa ${CHANNEL_LABEL[g.channel]}, znatno manje od ${fmtEUR(g.platformValue)} koliko platforma prijavljuje — vredi proveriti tačnost conversion trackinga.` })
      }
    })
    return list
  }, [dateRange, spendChangePct, roasChangePct, roas, betterChannel, bestCampaign, worstCampaign, topSpendShare, riskyEngagement, ga4GapInsight, combined.spend])

  const rangeLabel = dateRange
    ? `${dateRange.current[0].slice(5)} – ${dateRange.current[1].slice(5)}` + (dateRange.previous ? ` vs ${dateRange.previous[0].slice(5)} – ${dateRange.previous[1].slice(5)}` : '')
    : ''

  if (error && clients.length === 0) {
    return <p className="text-[var(--color-rust)]">{error}</p>
  }

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-10 flex items-end justify-between border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Sažetak za direktora</p>
          <h1 className="font-display mt-1 text-4xl font-medium">{loading ? '…' : clients.find((c) => c.id === selectedId)?.name}</h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">{rangeLabel ? `Period: ${rangeLabel}` : 'Učitavanje perioda…'}</p>
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
          {/* TL;DR narrative */}
          <section className="mb-10 rounded border border-[var(--color-line)] bg-white p-6">
            <p className="font-display text-lg leading-relaxed">
              U periodu {rangeLabel.split(' vs ')[0]}, {clients.find((c) => c.id === selectedId)?.name} je potrošio{' '}
              <strong>{fmtEUR(combined.spend)}</strong> na Google Ads i Meta oglašavanje zajedno, generišući{' '}
              <strong>{fmtInt(combined.conversions)}</strong> konverzija u vrednosti od <strong>{fmtEUR(combined.conversion_value)}</strong>, za
              blended ROAS od <strong>{roas.toFixed(2)}x</strong>
              {dateRange?.previous && (
                <>
                  {' '}— {spendChangePct >= 0 ? 'porast' : 'pad'} potrošnje od {fmtPct(Math.abs(spendChangePct))} i{' '}
                  {revenueChangePct >= 0 ? 'porast' : 'pad'} prihoda od {fmtPct(Math.abs(revenueChangePct))} u odnosu na prethodni period.
                </>
              )}
              {hasGa4 && ' GA4 podaci su uključeni u proveru koliko se platformski izveštaji poklapaju sa stvarnim ponašanjem na sajtu.'}
            </p>
          </section>

          {/* Snapshot metrics row */}
          <section className="mb-10 grid grid-cols-4 gap-px border border-[var(--color-line)] bg-[var(--color-line)]">
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Potrošnja</p>
              <p className="font-display mt-1 text-2xl">{fmtEUR(combined.spend)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Vrednost konverzija</p>
              <p className="font-display mt-1 text-2xl">{fmtEUR(combined.conversion_value)}</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Blended ROAS</p>
              <p className="font-display mt-1 text-2xl">{roas.toFixed(2)}x</p>
            </div>
            <div className="bg-white p-4">
              <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Konverzije</p>
              <p className="font-display mt-1 text-2xl">{fmtInt(combined.conversions)}</p>
            </div>
          </section>

          {/* Insights feed */}
          <section className="mb-10">
            <h2 className="font-display mb-4 text-lg font-medium">Ključni uvidi</h2>
            <div className="space-y-3">
              {insights.map((ins, i) => (
                <div key={i} className="flex gap-3 border-b border-[var(--color-line)] pb-3">
                  <span
                    className="mt-1 h-2 w-2 shrink-0 rounded-full"
                    style={{ background: ins.kind === 'good' ? 'var(--color-olive)' : ins.kind === 'bad' ? 'var(--color-rust)' : 'var(--color-ink-soft)' }}
                  />
                  <p className="text-sm leading-relaxed">{ins.text}</p>
                </div>
              ))}
              {insights.length === 0 && <p className="text-sm text-[var(--color-ink-soft)]">Nema izdvojenih uvida za ovaj period.</p>}
            </div>
          </section>

          {/* Recommendations */}
          <section>
            <h2 className="font-display mb-4 text-lg font-medium">Preporuke</h2>
            <ul className="space-y-2 text-sm">
              {bestCampaign && (
                <li className="flex gap-2">
                  <span className="text-[var(--color-olive)]">→</span>
                  <span>Razmotriti povećanje budžeta za "{bestCampaign.campaign}" — dokazano najbolji ROAS ovog perioda.</span>
                </li>
              )}
              {worstCampaign && (
                <li className="flex gap-2">
                  <span className="text-[var(--color-rust)]">→</span>
                  <span>Pauzirati ili revidirati "{worstCampaign.campaign}" — troši budžet bez ijedne konverzije.</span>
                </li>
              )}
              {riskyEngagement.length > 0 && (
                <li className="flex gap-2">
                  <span className="text-[var(--color-rust)]">→</span>
                  <span>Proveriti landing stranicu za saobraćaj sa visokim bounce rate-om ({riskyEngagement.map((r) => r.source).join(', ')}).</span>
                </li>
              )}
              {topSpendShare > 40 && (
                <li className="flex gap-2">
                  <span className="text-[var(--color-ink-soft)]">→</span>
                  <span>Razmotriti diverzifikaciju budžeta — trenutno je previše koncentrisan na jednu kampanju.</span>
                </li>
              )}
              {ga4GapInsight.length > 0 && (
                <li className="flex gap-2">
                  <span className="text-[var(--color-ink-soft)]">→</span>
                  <span>Uskladiti conversion tracking između ad platformi i GA4 — trenutno postoji značajno odstupanje u izveštenoj vrednosti.</span>
                </li>
              )}
              {!bestCampaign && !worstCampaign && riskyEngagement.length === 0 && topSpendShare <= 40 && ga4GapInsight.length === 0 && (
                <li className="text-[var(--color-ink-soft)]">Nema hitnih akcionih stavki ovog perioda — performanse su stabilne.</li>
              )}
            </ul>
          </section>
        </>
      )}
    </div>
  )
}
