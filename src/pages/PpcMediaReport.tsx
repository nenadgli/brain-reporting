import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

const CHANNEL_LABEL: Record<string, string> = { google: 'Google Ads', meta: 'Meta Ads' }
const BUCKET_LABEL: Record<string, string> = { Ecomm: 'Ecomm (glavni budžet)', Loyalty: 'Loyalty (App Install)', Social: 'Social (brand awareness)' }
const BUCKET_COLOR: Record<string, string> = { Ecomm: 'var(--color-indigo)', Loyalty: 'var(--color-olive)', Social: '#8a6fb0' }

const fmtEUR = (n: number) => `€${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const fmtInt = (n: number) => n.toLocaleString('sr-RS', { maximumFractionDigits: 0 })
const fmtPct = (n: number) => `${n.toLocaleString('sr-RS', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`

type ChannelRow = { channel: string; bucket: string; spend: number; reach: number; impressions: number; clicks: number; conversions: number; conversion_value: number }

const MONTH_NAMES = ['januar', 'februar', 'mart', 'april', 'maj', 'jun', 'jul', 'avgust', 'septembar', 'oktobar', 'novembar', 'decembar']

export default function PpcMediaReport() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dataMinMax, setDataMinMax] = useState<[string, string] | null>(null)
  const [monthValue, setMonthValue] = useState<string>('')
  const [channelRows, setChannelRows] = useState<ChannelRow[]>([])
  const [structureRows, setStructureRows] = useState<{ row_order: number; row_label: string; channel: string; level: string; sub_dimension: string | null; spend: number; reach: number; clicks: number; impressions: number; conversions: number; conversion_value: number }[]>([])
  const [ga4Check, setGa4Check] = useState<{ channel: string; sessions: number; total_users: number; engaged_sessions: number; conversions: number; total_revenue: number }[]>([])

  useEffect(() => {
    async function init() {
      setLoading(true)
      setError(null)
      const { data, error: rangeError } = await supabase.rpc('blended_date_range', {
        p_client_id: 'c710bfd0-5281-412b-a7d6-2a96c80b9b57',
      })
      const row = data?.[0]
      if (rangeError || !row || !row.min_date || !row.max_date) {
        setError('Nema podataka još uvek.')
        setLoading(false)
        return
      }
      setDataMinMax([row.min_date as string, row.max_date as string])
      const maxMonth = (row.max_date as string).slice(0, 7)
      setMonthValue(maxMonth)
    }
    init()
  }, [])

  const monthOptions = useMemo(() => {
    if (!dataMinMax) return []
    const [minDate, maxDate] = dataMinMax
    const opts: { value: string; label: string }[] = []
    const cursor = new Date(minDate.slice(0, 7) + '-01')
    const end = new Date(maxDate.slice(0, 7) + '-01')
    while (cursor <= end) {
      const y = cursor.getFullYear()
      const m = cursor.getMonth()
      opts.push({ value: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MONTH_NAMES[m]} ${y}` })
      cursor.setMonth(cursor.getMonth() + 1)
    }
    return opts.reverse()
  }, [dataMinMax])

  const range = useMemo(() => {
    if (!monthValue || !dataMinMax) return null
    const [y, m] = monthValue.split('-').map(Number)
    const start = `${y}-${String(m).padStart(2, '0')}-01`
    const lastDay = new Date(y, m, 0).getDate()
    const rawEnd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
    const end = rawEnd > dataMinMax[1] ? dataMinMax[1] : rawEnd
    return [start, end] as [string, string]
  }, [monthValue, dataMinMax])

  useEffect(() => {
    if (!range) return
    async function loadAll() {
      setLoading(true)
      setError(null)
      const [cs, ce] = range!
      const [chRes, ga4Res, structRes] = await Promise.all([
        supabase.rpc('fashion_rs_ppc_channel_summary', { p_start: cs, p_end: ce }),
        supabase.rpc('ga4_paid_channel_verification', { p_client_id: 'c710bfd0-5281-412b-a7d6-2a96c80b9b57', p_start: cs, p_end: ce }),
        supabase.rpc('fashion_rs_report_structure', { p_start: cs, p_end: ce }),
      ])
      if (chRes.error) {
        setError('Nije moguće učitati podatke.')
        setLoading(false)
        return
      }
      setChannelRows(chRes.data ?? [])
      setGa4Check(ga4Res.data ?? [])
      setStructureRows(structRes.data ?? [])
      setLoading(false)
    }
    loadAll()
  }, [range])

  const totals = useMemo(() => {
    return channelRows.reduce(
      (acc, r) => ({
        spend: acc.spend + r.spend,
        clicks: acc.clicks + r.clicks,
        impressions: acc.impressions + r.impressions,
        conversions: acc.conversions + r.conversions,
        conversion_value: acc.conversion_value + r.conversion_value,
      }),
      { spend: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0 }
    )
  }, [channelRows])

  const groupedStructure = useMemo(() => {
    const groups = new Map<string, { row_label: string; channel: string; level: string; rows: typeof structureRows; total: { spend: number; reach: number; clicks: number; impressions: number; conversions: number; conversion_value: number } }>()
    for (const r of structureRows) {
      if (!groups.has(r.row_label)) {
        groups.set(r.row_label, { row_label: r.row_label, channel: r.channel, level: r.level, rows: [], total: { spend: 0, reach: 0, clicks: 0, impressions: 0, conversions: 0, conversion_value: 0 } })
      }
      const g = groups.get(r.row_label)!
      g.rows.push(r)
      g.total.spend += r.spend
      g.total.reach += r.reach
      g.total.clicks += r.clicks
      g.total.impressions += r.impressions
      g.total.conversions += r.conversions
      g.total.conversion_value += r.conversion_value
    }
    return [...groups.values()]
  }, [structureRows])

  const googleGroups = useMemo(() => groupedStructure.filter((g) => g.channel === 'google'), [groupedStructure])
  const metaGroups = useMemo(() => groupedStructure.filter((g) => g.channel === 'meta'), [groupedStructure])

  const monthLabel = monthOptions.find((m) => m.value === monthValue)?.label ?? ''

  if (error) {
    return <p className="text-[var(--color-rust)]">{error}</p>
  }

  return (
    <div>
      <header className="mb-8 flex items-end justify-between border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Media Plan izveštaj &middot; po ugledu na PPC tim</p>
          <h1 className="font-display mt-1 text-4xl font-medium">Fashion&amp;Friends RS</h1>
          <p className="mt-2 text-[var(--color-ink-soft)]">{monthLabel ? `Period: ${monthLabel}` : 'Učitavanje…'} &middot; Google Ads + Meta Ads</p>
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
          <section className="mb-10 rounded border border-[var(--color-line)] bg-[var(--color-indigo-soft)] p-4 text-xs text-[var(--color-ink-soft)]">
            Struktura ovog izveštaja prati PPC media plan format (Ecomm / Loyalty / Social budžetski rasponi, po mreži i po kampanji). Planirani
            budžet (Regular/Flash raspodela) je ručni unos PPC tima i ovde se ne prikazuje — ovo su isključivo stvarni (actual) rezultati iz
            platformi.
          </section>

          <section className="mb-10 grid grid-cols-5 gap-3">
            <div className="kpi-card">
              <p className="kpi-label">Ukupna potrošnja</p>
              <p className="kpi-value">{fmtEUR(totals.spend)}</p>
            </div>
            <div className="kpi-card">
              <p className="kpi-label">Impresije</p>
              <p className="kpi-value">{fmtInt(totals.impressions)}</p>
            </div>
            <div className="kpi-card">
              <p className="kpi-label">Klikovi</p>
              <p className="kpi-value">{fmtInt(totals.clicks)}</p>
            </div>
            <div className="kpi-card">
              <p className="kpi-label">Konverzije</p>
              <p className="kpi-value">{fmtInt(totals.conversions)}</p>
            </div>
            <div className="kpi-card">
              <p className="kpi-label">ROAS</p>
              <p className="kpi-value">{totals.spend > 0 ? `${(totals.conversion_value / totals.spend).toFixed(2)}x` : '—'}</p>
            </div>
          </section>

          <section className="mb-10">
            <h2 className="font-display mb-4 text-lg font-medium">Po mreži i budžetskom rasponu</h2>
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                  <th className="py-2 pr-3 font-normal">Mreža</th>
                  <th className="py-2 pr-3 font-normal">Raspon</th>
                  <th className="py-2 pr-3 text-right font-normal">Spend</th>
                  <th className="py-2 pr-3 text-right font-normal">Reach</th>
                  <th className="py-2 pr-3 text-right font-normal">Impr.</th>
                  <th className="py-2 pr-3 text-right font-normal">Klikovi</th>
                  <th className="py-2 pr-3 text-right font-normal">CTR</th>
                  <th className="py-2 pr-3 text-right font-normal">Konv.</th>
                  <th className="py-2 pr-3 text-right font-normal">Revenue</th>
                  <th className="py-2 text-right font-normal">ROAS</th>
                </tr>
              </thead>
              <tbody>
                {channelRows.map((r, i) => {
                  const ctr = r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0
                  const roas = r.spend > 0 ? r.conversion_value / r.spend : 0
                  return (
                    <tr key={i} className="border-b border-[var(--color-line)]">
                      <td className="py-2 pr-3 font-medium">{CHANNEL_LABEL[r.channel]}</td>
                      <td className="py-2 pr-3">
                        <span className="rounded px-1.5 py-0.5 text-xs text-white" style={{ background: BUCKET_COLOR[r.bucket] }}>
                          {BUCKET_LABEL[r.bucket] ?? r.bucket}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtEUR(r.spend)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{r.reach > 0 ? fmtInt(r.reach) : '—'}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(r.impressions)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(r.clicks)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtPct(ctr)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(r.conversions)}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtEUR(r.conversion_value)}</td>
                      <td className="py-2 text-right font-mono">{r.spend > 0 ? `${roas.toFixed(2)}x` : '—'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </section>

          {ga4Check.length > 0 && (
            <section className="mb-10">
              <h2 className="font-display mb-2 text-lg font-medium">GA4 provera (nezavisna sajt-side istina)</h2>
              <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
                PPC tim u svom izveštaju upozorava da GA4 pripisuje rezultate kampanji i do 90 dana posle klika, pa je GA4 total uvek veći od
                zbira pojedinačnih kampanja. Ovde je ta GA4 provera za period.
              </p>
              <table className="w-full max-w-lg border-collapse text-sm">
                <thead>
                  <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
                    <th className="py-2 pr-3 font-normal">Kanal</th>
                    <th className="py-2 pr-3 text-right font-normal">GA4 sesije</th>
                    <th className="py-2 text-right font-normal">GA4 prihod</th>
                  </tr>
                </thead>
                <tbody>
                  {ga4Check.map((r) => (
                    <tr key={r.channel} className="border-b border-[var(--color-line)]">
                      <td className="py-2 pr-3">{CHANNEL_LABEL[r.channel] ?? r.channel}</td>
                      <td className="py-2 pr-3 text-right font-mono">{fmtInt(r.sessions)}</td>
                      <td className="py-2 text-right font-mono">{fmtEUR(r.total_revenue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section>
            <h2 className="font-display mb-2 text-lg font-medium">Struktura izveštaja</h2>
            <p className="mb-4 text-xs text-[var(--color-ink-soft)]">
              Prati dogovorenu strukturu: neke kampanje su spojene u jedan red (npr. "Search Category + Brand", "BOF"), a neke su prikazane sa
              detaljom po ad setu (Meta), ad grupi ili asset grupi (Google PMax).
            </p>

            <h3 className="font-display mb-3 mt-6 text-base font-medium">Google Ads</h3>
            <StructureTable groups={googleGroups} />

            <h3 className="font-display mb-3 mt-8 text-base font-medium">Meta Ads</h3>
            <StructureTable groups={metaGroups} />
          </section>
        </>
      )}
    </div>
  )
}

function StructureTable({
  groups,
}: {
  groups: { row_label: string; channel: string; level: string; rows: { sub_dimension: string | null; spend: number; reach: number; clicks: number; impressions: number; conversions: number; conversion_value: number }[]; total: { spend: number; reach: number; clicks: number; impressions: number; conversions: number; conversion_value: number } }[]
}) {
  return (
    <table className="mb-2 w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-[var(--color-line)] text-left text-[var(--color-ink-soft)]">
          <th className="py-2 pr-3 font-normal">Red</th>
          <th className="py-2 pr-3 text-right font-normal">Actual Spend</th>
          <th className="py-2 pr-3 text-right font-normal">Reach</th>
          <th className="py-2 pr-3 text-right font-normal">Impressions</th>
          <th className="py-2 pr-3 text-right font-normal">Frequency</th>
          <th className="py-2 pr-3 text-right font-normal">Clicks</th>
          <th className="py-2 pr-3 text-right font-normal">CTR</th>
          <th className="py-2 pr-3 text-right font-normal">Conversions</th>
          <th className="py-2 pr-3 text-right font-normal">Revenue</th>
          <th className="py-2 text-right font-normal">ROAS</th>
        </tr>
      </thead>
      <tbody>
        {groups.length === 0 && (
          <tr>
            <td colSpan={10} className="py-3 text-[var(--color-ink-soft)]">Nema podataka za ovaj period.</td>
          </tr>
        )}
        {groups.map((g) => {
          const ctr = g.total.impressions > 0 ? (g.total.clicks / g.total.impressions) * 100 : 0
          const roas = g.total.spend > 0 ? g.total.conversion_value / g.total.spend : 0
          const freq = g.total.reach > 0 ? g.total.impressions / g.total.reach : null
          return (
            <>
              <tr key={g.row_label} className="border-b border-[var(--color-line)] bg-[var(--color-indigo-soft)]">
                <td className="py-2 pr-3 font-medium">{g.row_label}</td>
                <td className="py-2 pr-3 text-right font-mono">{fmtEUR(g.total.spend)}</td>
                <td className="py-2 pr-3 text-right font-mono">{g.total.reach > 0 ? fmtInt(g.total.reach) : '—'}</td>
                <td className="py-2 pr-3 text-right font-mono">{fmtInt(g.total.impressions)}</td>
                <td className="py-2 pr-3 text-right font-mono">{freq != null ? freq.toFixed(2) : '—'}</td>
                <td className="py-2 pr-3 text-right font-mono">{fmtInt(g.total.clicks)}</td>
                <td className="py-2 pr-3 text-right font-mono">{fmtPct(ctr)}</td>
                <td className="py-2 pr-3 text-right font-mono">{fmtInt(g.total.conversions)}</td>
                <td className="py-2 pr-3 text-right font-mono">{fmtEUR(g.total.conversion_value)}</td>
                <td className="py-2 text-right font-mono">{g.total.spend > 0 ? `${roas.toFixed(2)}x` : '—'}</td>
              </tr>
              {g.level !== 'campaign' &&
                g.rows.map((sr, i) => {
                  const srCtr = sr.impressions > 0 ? (sr.clicks / sr.impressions) * 100 : 0
                  const srRoas = sr.spend > 0 ? sr.conversion_value / sr.spend : 0
                  const srFreq = sr.reach > 0 ? sr.impressions / sr.reach : null
                  return (
                    <tr key={`${g.row_label}-${i}`} className="border-b border-[var(--color-line)] text-[var(--color-ink-soft)]">
                      <td className="py-1.5 pr-3 pl-6 max-w-[220px] truncate" title={sr.sub_dimension ?? ''}>↳ {sr.sub_dimension}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtEUR(sr.spend)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{sr.reach > 0 ? fmtInt(sr.reach) : '—'}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtInt(sr.impressions)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{srFreq != null ? srFreq.toFixed(2) : '—'}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtInt(sr.clicks)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtPct(srCtr)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtInt(sr.conversions)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono">{fmtEUR(sr.conversion_value)}</td>
                      <td className="py-1.5 text-right font-mono">{sr.spend > 0 ? `${srRoas.toFixed(2)}x` : '—'}</td>
                    </tr>
                  )
                })}
            </>
          )
        })}
      </tbody>
    </table>
  )
}
