import { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
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

const METRIC_LABEL: Record<string, string> = {
  spend: 'Potrošnja (EUR)',
  impressions: 'Impresije',
  clicks: 'Klikovi',
}

export default function Dashboard() {
  const [clientList, setClientList] = useState<Client[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [client, setClient] = useState<Client | null>(null)
  const [metrics, setMetrics] = useState<ReportMetric[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load the list of clients for this agency once, and default to the first one.
  useEffect(() => {
    async function loadClientList() {
      const { data, error: listError } = await supabase
        .from('clients')
        .select('*')
        .eq('agency_id', AGENCY_ID)
        .order('name')

      if (listError || !data || data.length === 0) {
        setError('Nema klijenata za ovu agenciju.')
        setLoading(false)
        return
      }
      setClientList(data)
      setSelectedId(data[0].id)
    }
    loadClientList()
  }, [])

  // Load the selected client's metrics whenever selection changes.
  useEffect(() => {
    if (!selectedId) return
    async function load() {
      setLoading(true)
      setError(null)

      const clientData = clientList.find((c) => c.id === selectedId) ?? null
      setClient(clientData)

      const { data: metricData, error: metricError } = await supabase
        .from('report_metrics')
        .select('*')
        .eq('client_id', selectedId)
        .order('report_date', { ascending: true })

      if (metricError) {
        setError('Nije moguće učitati izveštaj.')
      } else {
        setMetrics(metricData ?? [])
      }
      setLoading(false)
    }
    load()
  }, [selectedId, clientList])

  const channels = useMemo(() => [...new Set(metrics.map((m) => m.channel))], [metrics])

  const spendByDate = useMemo(() => {
    type Row = { date: string; [channel: string]: string | number }
    const byDate: Record<string, Row> = {}
    metrics
      .filter((m) => m.metric_name === 'spend')
      .forEach((m) => {
        const key = m.report_date
        if (!byDate[key]) byDate[key] = { date: key }
        byDate[key][m.channel] = (Number(byDate[key][m.channel]) || 0) + m.metric_value
      })
    return Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date))
  }, [metrics])

  const totalsByChannel = useMemo(() => {
    const sums: Record<string, Record<string, number>> = {}
    metrics.forEach((m) => {
      if (!sums[m.channel]) sums[m.channel] = {}
      sums[m.channel][m.metric_name] = (sums[m.channel][m.metric_name] ?? 0) + m.metric_value
    })
    return sums
  }, [metrics])

  const totalsByCampaign = useMemo(() => {
    const sums: Record<string, { channel: string; spend: number; clicks: number; impressions: number }> = {}
    metrics.forEach((m) => {
      const key = m.campaign ?? '(bez kampanje)'
      if (!sums[key]) sums[key] = { channel: m.channel, spend: 0, clicks: 0, impressions: 0 }
      if (m.metric_name === 'spend') sums[key].spend += m.metric_value
      if (m.metric_name === 'clicks') sums[key].clicks += m.metric_value
      if (m.metric_name === 'impressions') sums[key].impressions += m.metric_value
    })
    return sums
  }, [metrics])

  const hasCampaignData = Object.keys(totalsByCampaign).some((k) => k !== '(bez kampanje)')
  const lineColors = ['var(--color-indigo)', 'var(--color-olive)', 'var(--color-rust)']

  if (error && clientList.length === 0) {
    return <p className="text-[var(--color-rust)]">{error}</p>
  }

  return (
    <div>
      <header className="mb-10 flex items-end justify-between border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">
            Pilot Agencija
          </p>
          <h1 className="font-display mt-1 text-4xl font-medium">
            {loading ? '…' : client?.name}
          </h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">Poslednjih nekoliko dana &middot; svi povezani kanali</p>
        </div>
        <label className="text-sm">
          <span className="mr-2 text-[var(--color-ink-soft)]">Klijent</span>
          <select
            value={selectedId}
            onChange={(e) => setSelectedId(e.target.value)}
            className="rounded border border-[var(--color-line)] bg-white px-3 py-1.5"
          >
            {clientList.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && <p className="text-[var(--color-rust)]">{error}</p>}

      {!error && (
        <>
          <section className="mb-12">
            <h2 className="font-display mb-4 text-lg font-medium">Potrošnja po danu</h2>
            <div className="h-64 rounded border border-[var(--color-line)] bg-white p-4">
              {loading ? (
                <div className="flex h-full items-center justify-center text-[var(--color-ink-soft)]">
                  Učitavanje…
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={spendByDate}>
                    <CartesianGrid stroke="var(--color-line)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(d) => d.slice(5)}
                      tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }}
                      axisLine={{ stroke: 'var(--color-line)' }}
                      tickLine={false}
                    />
                    <YAxis
                      tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <Tooltip
                      contentStyle={{ fontSize: 13, borderRadius: 4, border: '1px solid var(--color-line)' }}
                      formatter={(value) => `€${Number(value).toFixed(2)}`}
                    />
                    {channels.map((ch, i) => (
                      <Line
                        key={ch}
                        type="monotone"
                        dataKey={ch}
                        name={CHANNEL_LABEL[ch] ?? ch}
                        stroke={lineColors[i % lineColors.length]}
                        strokeWidth={2}
                        dot={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          <section className="mb-12">
            <h2 className="font-display mb-4 text-lg font-medium">Ukupno po kanalu</h2>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                  <th className="py-2 font-normal">Kanal</th>
                  {Object.keys(METRIC_LABEL).map((m) => (
                    <th key={m} className="py-2 text-right font-normal">
                      {METRIC_LABEL[m]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.keys(totalsByChannel).map((channel) => (
                  <tr key={channel} className="border-b border-[var(--color-line)]">
                    <td className="py-3 font-medium">{CHANNEL_LABEL[channel] ?? channel}</td>
                    {Object.keys(METRIC_LABEL).map((m) => (
                      <td key={m} className="py-3 text-right font-mono">
                        {(totalsByChannel[channel][m] ?? 0).toLocaleString('sr-RS', { maximumFractionDigits: 0 })}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {hasCampaignData && (
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Po kampanji</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 font-normal">Kampanja</th>
                    <th className="py-2 font-normal">Kanal</th>
                    <th className="py-2 text-right font-normal">Potrošnja (EUR)</th>
                    <th className="py-2 text-right font-normal">Klikovi</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(totalsByCampaign).map(([campaign, vals]) => (
                    <tr key={campaign} className="border-b border-[var(--color-line)]">
                      <td className="py-3">{campaign}</td>
                      <td className="py-3 text-[var(--color-ink-soft)]">{CHANNEL_LABEL[vals.channel] ?? vals.channel}</td>
                      <td className="py-3 text-right font-mono">€{vals.spend.toFixed(2)}</td>
                      <td className="py-3 text-right font-mono">{vals.clicks.toLocaleString('sr-RS')}</td>
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
