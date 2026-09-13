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
const CHANNEL_LABEL: Record<string, string> = { push_notification: 'Push notifikacije', newsletter: 'Newsletter (email)' }

const fmtEUR = (n: number) => `€${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtInt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmtPct = (n: number) => `${n.toLocaleString('sr-RS', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}%`

type Totals = { sessions: number; total_users: number; engaged_sessions: number; conversions: number; total_revenue: number; campaign_count: number }
const emptyTotals: Totals = { sessions: 0, total_users: 0, engaged_sessions: 0, conversions: 0, total_revenue: 0, campaign_count: 0 }

export default function OwnedChannelsReport() {
  const [clients, setClients] = useState<Client[]>([])
  const [selectedId, setSelectedId] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [dateRange, setDateRange] = useState<[string, string] | null>(null)
  const [totals, setTotals] = useState<Record<string, Totals>>({ push_notification: emptyTotals, newsletter: emptyTotals })
  const [trend, setTrend] = useState<{ report_date: string; push_notification: number; newsletter: number }[]>([])
  const [pushTypes, setPushTypes] = useState<{ campaign_type: string; sessions: number; total_users: number; conversions: number; total_revenue: number; campaign_count: number }[]>([])
  const [newsletterTypes, setNewsletterTypes] = useState<{ campaign_type: string; sessions: number; total_users: number; conversions: number; total_revenue: number; campaign_count: number }[]>([])
  const [topPush, setTopPush] = useState<{ campaign: string; sessions: number; total_users: number; engaged_sessions: number; conversions: number; total_revenue: number }[]>([])
  const [topNewsletter, setTopNewsletter] = useState<{ campaign: string; sessions: number; total_users: number; engaged_sessions: number; conversions: number; total_revenue: number }[]>([])

  useEffect(() => {
    async function loadClients() {
      const { data: sourceRows, error: sourceError } = await supabase.from('data_sources').select('client_id').eq('provider', 'ga4')
      if (sourceError || !sourceRows || sourceRows.length === 0) {
        setError('Nijedan klijent nema povezan GA4 nalog (push/newsletter podaci dolaze preko GA4).')
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
      const { data, error: rangeError } = await supabase.rpc('owned_channel_date_range', { p_client_id: selectedId })
      const row = data?.[0]
      if (rangeError || !row || !row.min_date || !row.max_date) {
        setError('Nema push/newsletter podataka za ovog klijenta još uvek.')
        setLoading(false)
        return
      }
      setDateRange([row.min_date as string, row.max_date as string])
    }
    findRange()
  }, [selectedId])

  useEffect(() => {
    if (!selectedId || !dateRange) return
    async function loadAll() {
      setLoading(true)
      setError(null)
      const [start, end] = dateRange as [string, string]

      const [totRes, trendRes, pushTypeRes, nlTypeRes, topPushRes, topNlRes] = await Promise.all([
        supabase.rpc('owned_channel_period_totals', { p_client_id: selectedId, p_start: start, p_end: end }),
        supabase.rpc('owned_channel_daily_trend', { p_client_id: selectedId, p_start: start, p_end: end }),
        supabase.rpc('owned_channel_type_summary', { p_client_id: selectedId, p_start: start, p_end: end, p_source: 'push_notification' }),
        supabase.rpc('owned_channel_type_summary', { p_client_id: selectedId, p_start: start, p_end: end, p_source: 'newsletter' }),
        supabase.rpc('owned_channel_top_campaigns', { p_client_id: selectedId, p_start: start, p_end: end, p_source: 'push_notification', p_limit: 20 }),
        supabase.rpc('owned_channel_top_campaigns', { p_client_id: selectedId, p_start: start, p_end: end, p_source: 'newsletter', p_limit: 20 }),
      ])

      if (totRes.error) {
        setError('Nije moguće učitati podatke.')
        setLoading(false)
        return
      }

      const totalsMap: Record<string, Totals> = { push_notification: emptyTotals, newsletter: emptyTotals }
      ;(totRes.data ?? []).forEach((r: Totals & { source: string }) => { totalsMap[r.source] = r })
      setTotals(totalsMap)

      const byDate: Record<string, { report_date: string; push_notification: number; newsletter: number }> = {}
      ;(trendRes.data ?? []).forEach((r: { report_date: string; source: string; sessions: number }) => {
        if (!byDate[r.report_date]) byDate[r.report_date] = { report_date: r.report_date, push_notification: 0, newsletter: 0 }
        byDate[r.report_date][r.source as 'push_notification' | 'newsletter'] = r.sessions
      })
      setTrend(Object.values(byDate).sort((a, b) => a.report_date.localeCompare(b.report_date)))

      setPushTypes(pushTypeRes.data ?? [])
      setNewsletterTypes(nlTypeRes.data ?? [])
      setTopPush(topPushRes.data ?? [])
      setTopNewsletter(topNlRes.data ?? [])
      setLoading(false)
    }
    loadAll()
  }, [selectedId, dateRange])

  const combined = useMemo(() => {
    const sum = (f: (t: Totals) => number) => f(totals.push_notification) + f(totals.newsletter)
    return {
      sessions: sum((t) => t.sessions), total_users: sum((t) => t.total_users), engaged_sessions: sum((t) => t.engaged_sessions),
      conversions: sum((t) => t.conversions), total_revenue: sum((t) => t.total_revenue), campaign_count: sum((t) => t.campaign_count),
    }
  }, [totals])

  const revenuePerCampaign = (t: Totals) => (t.campaign_count > 0 ? t.total_revenue / t.campaign_count : 0)
  const revenuePerSession = (t: Totals) => (t.sessions > 0 ? t.total_revenue / t.sessions : 0)

  const betterChannel = useMemo(() => {
    const pushRps = revenuePerSession(totals.push_notification)
    const nlRps = revenuePerSession(totals.newsletter)
    if (pushRps === 0 && nlRps === 0) return null
    return pushRps >= nlRps ? { name: 'push_notification', rps: pushRps, other: nlRps } : { name: 'newsletter', rps: nlRps, other: pushRps }
  }, [totals])

  const rangeLabel = dateRange ? `${dateRange[0]} – ${dateRange[1]}` : ''

  if (error && clients.length === 0) {
    return <p className="text-[var(--color-rust)]">{error}</p>
  }

  return (
    <div>
      <header className="mb-8 flex items-end justify-between border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Sopstveni kanali (owned) &middot; iz GA4</p>
          <h1 className="font-display mt-1 text-4xl font-medium">{loading ? '…' : clients.find((c) => c.id === selectedId)?.name}</h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">{rangeLabel ? `Period: ${rangeLabel}` : 'Učitavanje perioda…'} &middot; Push notifikacije + Newsletter</p>
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
          {/* Analiza narrative */}
          <section className="mb-10 rounded border border-[var(--color-line)] bg-white p-6">
            <p className="font-display text-lg leading-relaxed">
              Push i newsletter kanali zajedno su generisali <strong>{fmtInt(combined.sessions)}</strong> sesija i{' '}
              <strong>{fmtEUR(combined.total_revenue)}</strong> prihoda u periodu, kroz <strong>{fmtInt(combined.campaign_count)}</strong>{' '}
              odvojenih kampanja/slanja.
              {betterChannel && (
                <>
                  {' '}
                  <strong>{CHANNEL_LABEL[betterChannel.name]}</strong> nosi bolji prihod po sesiji ({fmtEUR(betterChannel.rps)} naspram{' '}
                  {fmtEUR(betterChannel.other)} na drugom kanalu) &mdash; efikasniji je po jedinici saobraćaja, iako to ne mora značiti veći
                  ukupan obim.
                </>
              )}
            </p>
          </section>

          {/* KPI comparison */}
          <section className="mb-10 grid grid-cols-2 gap-8">
            {(['push_notification', 'newsletter'] as const).map((ch) => {
              const t = totals[ch]
              return (
                <div key={ch} className="kpi-card">
                  <p className="kpi-label" style={{ color: 'rgba(255,255,255,0.85)' }}>{CHANNEL_LABEL[ch]}</p>
                  <p className="kpi-value">{fmtEUR(t.total_revenue)}</p>
                  <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
                    <div>
                      <p className="text-white/70">Sesije</p>
                      <p className="font-mono">{fmtInt(t.sessions)}</p>
                    </div>
                    <div>
                      <p className="text-white/70">Korisnici</p>
                      <p className="font-mono">{fmtInt(t.total_users)}</p>
                    </div>
                    <div>
                      <p className="text-white/70">Broj slanja</p>
                      <p className="font-mono">{fmtInt(t.campaign_count)}</p>
                    </div>
                    <div>
                      <p className="text-white/70">Prihod po slanju</p>
                      <p className="font-mono">{fmtEUR(revenuePerCampaign(t))}</p>
                    </div>
                    <div>
                      <p className="text-white/70">Angažovanost</p>
                      <p className="font-mono">{t.sessions > 0 ? fmtPct((t.engaged_sessions / t.sessions) * 100) : '—'}</p>
                    </div>
                    <div>
                      <p className="text-white/70">Prihod / sesiji</p>
                      <p className="font-mono">{fmtEUR(revenuePerSession(t))}</p>
                    </div>
                  </div>
                </div>
              )
            })}
          </section>

          {/* Trend chart */}
          <section className="mb-10">
            <h2 className="font-display mb-4 text-lg font-medium">Sesije po danu</h2>
            <div className="h-64 rounded border border-[var(--color-line)] bg-white p-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trend}>
                  <defs>
                    <linearGradient id="pushGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-indigo)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-indigo)" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="nlGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="var(--color-olive)" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="var(--color-olive)" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-line)" vertical={false} />
                  <XAxis dataKey="report_date" tickFormatter={(d) => String(d).slice(5)} tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={{ stroke: 'var(--color-line)' }} tickLine={false} />
                  <YAxis tick={{ fontSize: 12, fill: 'var(--color-ink-soft)' }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ fontSize: 13, borderRadius: 4, border: '1px solid var(--color-line)' }} formatter={(value) => fmtInt(Number(value))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Area type="monotone" dataKey="push_notification" name="Push notifikacije" stroke="var(--color-indigo)" fill="url(#pushGrad)" strokeWidth={2} />
                  <Area type="monotone" dataKey="newsletter" name="Newsletter" stroke="var(--color-olive)" fill="url(#nlGrad)" strokeWidth={2} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Type breakdown */}
          <div className="mb-10 grid grid-cols-2 gap-8">
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Push &mdash; po tipu kampanje</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 font-normal">Tip</th>
                    <th className="py-2 text-right font-normal">Slanja</th>
                    <th className="py-2 text-right font-normal">Sesije</th>
                    <th className="py-2 text-right font-normal">Prihod</th>
                  </tr>
                </thead>
                <tbody>
                  {pushTypes.map((row) => (
                    <tr key={row.campaign_type} className="border-b border-[var(--color-line)]">
                      <td className="py-2">{row.campaign_type}</td>
                      <td className="py-2 text-right font-mono">{fmtInt(row.campaign_count)}</td>
                      <td className="py-2 text-right font-mono">{fmtInt(row.sessions)}</td>
                      <td className="py-2 text-right font-mono">{fmtEUR(row.total_revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Newsletter &mdash; po tipu kampanje</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 font-normal">Tip</th>
                    <th className="py-2 text-right font-normal">Slanja</th>
                    <th className="py-2 text-right font-normal">Sesije</th>
                    <th className="py-2 text-right font-normal">Prihod</th>
                  </tr>
                </thead>
                <tbody>
                  {newsletterTypes.map((row) => (
                    <tr key={row.campaign_type} className="border-b border-[var(--color-line)]">
                      <td className="py-2">{row.campaign_type}</td>
                      <td className="py-2 text-right font-mono">{fmtInt(row.campaign_count)}</td>
                      <td className="py-2 text-right font-mono">{fmtInt(row.sessions)}</td>
                      <td className="py-2 text-right font-mono">{fmtEUR(row.total_revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
                "Napušteta korpa" su automatizovana slanja (trigger-based), ne ručno poslati broadcast-ovi &mdash; očekivano manji obim po
                slanju, ali visoka relevantnost.
              </p>
            </section>
          </div>

          {/* Top campaigns */}
          <div className="grid grid-cols-2 gap-8">
            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Top push kampanje</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 pr-2 font-normal">Kampanja</th>
                    <th className="py-2 pr-2 text-right font-normal">Sesije</th>
                    <th className="py-2 text-right font-normal">Prihod</th>
                  </tr>
                </thead>
                <tbody>
                  {topPush.map((c) => (
                    <tr key={c.campaign} className="border-b border-[var(--color-line)]">
                      <td className="py-1.5 pr-2 max-w-[200px] truncate" title={c.campaign}>{c.campaign}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">{fmtInt(c.sessions)}</td>
                      <td className="py-1.5 text-right font-mono">{fmtEUR(c.total_revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <section>
              <h2 className="font-display mb-4 text-lg font-medium">Top newsletter kampanje</h2>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 pr-2 font-normal">Kampanja</th>
                    <th className="py-2 pr-2 text-right font-normal">Sesije</th>
                    <th className="py-2 text-right font-normal">Prihod</th>
                  </tr>
                </thead>
                <tbody>
                  {topNewsletter.map((c) => (
                    <tr key={c.campaign} className="border-b border-[var(--color-line)]">
                      <td className="py-1.5 pr-2 max-w-[200px] truncate" title={c.campaign}>{c.campaign}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">{fmtInt(c.sessions)}</td>
                      <td className="py-1.5 text-right font-mono">{fmtEUR(c.total_revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        </>
      )}
    </div>
  )
}
