import { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid } from 'recharts'
import { supabase, type Client, type ReportMetric } from '../lib/supabase'

// Demo-only hardcoded agency id — in the real app this comes from the logged-in
// agency user's app_users row, not a constant. See README auth TODO.
const AGENCY_ID = '00000000-0000-0000-0000-000000000001'

const CHANNEL_LABEL: Record<string, string> = {
  meta_ads: 'Meta Ads',
  google_ads: 'Google Ads',
  google: 'Google Ads',
  facebook: 'Facebook',
}

type MetricWithClient = ReportMetric & { client_name: string }

export default function AgencyReport() {
  const [clients, setClients] = useState<Client[]>([])
  const [metrics, setMetrics] = useState<MetricWithClient[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<'spend' | 'clicks'>('spend')

  useEffect(() => {
    async function load() {
      setLoading(true)
      setError(null)

      const { data: clientRows, error: clientError } = await supabase
        .from('clients')
        .select('*')
        .eq('agency_id', AGENCY_ID)
        .order('name')

      if (clientError || !clientRows) {
        setError('Nije moguće učitati klijente agencije.')
        setLoading(false)
        return
      }
      setClients(clientRows)

      const clientMap = Object.fromEntries(clientRows.map((c) => [c.id, c.name]))
      const clientIds = clientRows.map((c) => c.id)

      if (clientIds.length === 0) {
        setMetrics([])
        setLoading(false)
        return
      }

      const { data: metricRows, error: metricError } = await supabase
        .from('report_metrics')
        .select('*')
        .in('client_id', clientIds)
        .order('report_date', { ascending: true })

      if (metricError) {
        setError('Nije moguće učitati izveštaj.')
      } else {
        setMetrics(
          (metricRows ?? []).map((m) => ({ ...m, client_name: clientMap[m.client_id] ?? 'Nepoznat klijent' }))
        )
      }
      setLoading(false)
    }
    load()
  }, [])

  // Overall totals across the whole agency
  const overallTotals = useMemo(() => {
    const sums = { spend: 0, clicks: 0, impressions: 0 }
    metrics.forEach((m) => {
      if (m.metric_name in sums) sums[m.metric_name as keyof typeof sums] += m.metric_value
    })
    return sums
  }, [metrics])

  const activeChannels = useMemo(() => new Set(metrics.map((m) => m.channel)).size, [metrics])

  // Per-client totals
  const byClient = useMemo(() => {
    const sums: Record<string, { name: string; spend: number; clicks: number; impressions: number }> = {}
    metrics.forEach((m) => {
      if (!sums[m.client_id]) sums[m.client_id] = { name: m.client_name, spend: 0, clicks: 0, impressions: 0 }
      if (m.metric_name === 'spend') sums[m.client_id].spend += m.metric_value
      if (m.metric_name === 'clicks') sums[m.client_id].clicks += m.metric_value
      if (m.metric_name === 'impressions') sums[m.client_id].impressions += m.metric_value
    })
    return Object.values(sums).sort((a, b) => b.spend - a.spend)
  }, [metrics])

  // Per-campaign totals across all clients
  const byCampaign = useMemo(() => {
    const sums: Record<
      string,
      { campaign: string; client_name: string; channel: string; spend: number; clicks: number; impressions: number }
    > = {}
    metrics.forEach((m) => {
      const key = `${m.client_id}::${m.campaign ?? '(bez kampanje)'}::${m.channel}`
      if (!sums[key]) {
        sums[key] = {
          campaign: m.campaign ?? '(bez kampanje)',
          client_name: m.client_name,
          channel: m.channel,
          spend: 0,
          clicks: 0,
          impressions: 0,
        }
      }
      if (m.metric_name === 'spend') sums[key].spend += m.metric_value
      if (m.metric_name === 'clicks') sums[key].clicks += m.metric_value
      if (m.metric_name === 'impressions') sums[key].impressions += m.metric_value
    })
    return Object.values(sums).sort((a, b) => (sortBy === 'spend' ? b.spend - a.spend : b.clicks - a.clicks))
  }, [metrics, sortBy])

  // Spend trend per client, per date
  const trendData = useMemo(() => {
    const byDate: Record<string, Record<string, string | number>> = {}
    metrics
      .filter((m) => m.metric_name === 'spend')
      .forEach((m) => {
        const key = m.report_date
        if (!byDate[key]) byDate[key] = { date: key }
        byDate[key][m.client_name] = (Number(byDate[key][m.client_name]) || 0) + m.metric_value
      })
    return Object.values(byDate).sort((a, b) => String(a.date).localeCompare(String(b.date)))
  }, [metrics])

  const clientNames = useMemo(() => clients.map((c) => c.name), [clients])
  const lineColors = ['var(--color-indigo)', 'var(--color-olive)', 'var(--color-rust)', '#8a6fb0', '#3f7f8f']

  if (loading) {
    return <div className="py-20 text-center text-[var(--color-ink-soft)]">Učitavanje agencijskog izveštaja…</div>
  }

  if (error) {
    return <p className="text-[var(--color-rust)]">{error}</p>
  }

  return (
    <div>
      <section className="mb-10 kpi-grid grid-cols-4">
        <div className="kpi-card">
          <p className="kpi-label">Klijenata</p>
          <p className="kpi-value">{clients.length}</p>
        </div>
        <div className="kpi-card">
          <p className="kpi-label">Ukupna potrošnja</p>
          <p className="kpi-value">€{overallTotals.spend.toLocaleString('sr-RS', { maximumFractionDigits: 0 })}</p>
        </div>
        <div className="kpi-card">
          <p className="kpi-label">Ukupno klikova</p>
          <p className="kpi-value">{overallTotals.clicks.toLocaleString('sr-RS')}</p>
        </div>
        <div className="kpi-card">
          <p className="kpi-label">Aktivnih kanala</p>
          <p className="kpi-value">{activeChannels}</p>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="font-display mb-4 text-lg font-medium">Potrošnja po klijentu, po danu</h2>
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
              <YAxis tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
              <Tooltip
                contentStyle={{ fontSize: 13, borderRadius: 4, border: '1px solid var(--color-line)' }}
                formatter={(value) => `€${Number(value).toFixed(2)}`}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              {clientNames.map((name, i) => (
                <Line
                  key={name}
                  type="monotone"
                  dataKey={name}
                  stroke={lineColors[i % lineColors.length]}
                  strokeWidth={2}
                  dot={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="mb-12">
        <h2 className="font-display mb-4 text-lg font-medium">Po klijentu</h2>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
              <th className="py-2 font-normal">Klijent</th>
              <th className="py-2 text-right font-normal">Potrošnja (EUR)</th>
              <th className="py-2 text-right font-normal">Impresije</th>
              <th className="py-2 text-right font-normal">Klikovi</th>
              <th className="py-2 text-right font-normal">CTR</th>
            </tr>
          </thead>
          <tbody>
            {byClient.map((c) => (
              <tr key={c.name} className="border-b border-[var(--color-line)]">
                <td className="py-3 font-medium">{c.name}</td>
                <td className="py-3 text-right font-mono">€{c.spend.toFixed(2)}</td>
                <td className="py-3 text-right font-mono">{c.impressions.toLocaleString('sr-RS')}</td>
                <td className="py-3 text-right font-mono">{c.clicks.toLocaleString('sr-RS')}</td>
                <td className="py-3 text-right font-mono">
                  {c.impressions > 0 ? `${((c.clicks / c.impressions) * 100).toFixed(2)}%` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-lg font-medium">Sve kampanje</h2>
          <div className="flex gap-1 text-xs">
            <button
              onClick={() => setSortBy('spend')}
              className={`rounded px-2 py-1 ${sortBy === 'spend' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo)]' : 'text-[var(--color-ink-soft)]'}`}
            >
              Sortiraj po potrošnji
            </button>
            <button
              onClick={() => setSortBy('clicks')}
              className={`rounded px-2 py-1 ${sortBy === 'clicks' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo)]' : 'text-[var(--color-ink-soft)]'}`}
            >
              Sortiraj po klikovima
            </button>
          </div>
        </div>
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
              <th className="py-2 font-normal">Kampanja</th>
              <th className="py-2 font-normal">Klijent</th>
              <th className="py-2 font-normal">Kanal</th>
              <th className="py-2 text-right font-normal">Potrošnja (EUR)</th>
              <th className="py-2 text-right font-normal">Klikovi</th>
            </tr>
          </thead>
          <tbody>
            {byCampaign.map((row, i) => (
              <tr key={i} className="border-b border-[var(--color-line)]">
                <td className="py-3">{row.campaign}</td>
                <td className="py-3 text-[var(--color-ink-soft)]">{row.client_name}</td>
                <td className="py-3 text-[var(--color-ink-soft)]">{CHANNEL_LABEL[row.channel] ?? row.channel}</td>
                <td className="py-3 text-right font-mono">€{row.spend.toFixed(2)}</td>
                <td className="py-3 text-right font-mono">{row.clicks.toLocaleString('sr-RS')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  )
}
