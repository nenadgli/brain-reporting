import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

// "Meta struktura": snapshot of the F&F Meta accounts (facebook-ads-sync, structure mode; read only). Per market: the ad sets
// the Meta builder would copy for each media plan line type, every campaign with its ad sets and settings, and the ads whose
// URL tags break the GA4 rule (utm_campaign = campaign--ad set, utm_medium = paid).

type AdSet = {
  client_id: string; campaign_id: string; campaign: string; campaign_status: string | null; campaign_objective: string | null
  campaign_daily_eur: number | null; campaign_lifetime_eur: number | null; cbo: boolean
  adset_id: string; adset_name: string; adset_status: string | null; adset_daily_eur: number | null; adset_lifetime_eur: number | null
  adset_optimization_goal: string | null; adset_start_time: string | null; adset_end_time: string | null
  adset_promoted_object: Record<string, unknown> | null; adset_attribution_spec: { event_type: string; window_days: number }[] | null
  adset_targeting: Record<string, unknown> | null; ads: number; spend: number | null; url_tags: string | null
  window_from: string; window_to: string; synced_at: string
}
type CampType = { campaign_id: string; line_type: string }
type Template = AdSet & { line_type: string; add_to_cart: boolean; advantage_audience: boolean }

const MARKETS = ['RS', 'HR', 'BA', 'ME', 'SI', 'AL']
const TYPE_LABEL: Record<string, string> = {
  conversion: 'Conversion', remarketing: 'Remarketing (DPA)', traffic: 'Traffic', awareness: 'Awareness', always_on: 'Always-on',
  kiko: 'KIKO', main: 'Main', app: 'App', social: 'Social', other: 'Ostalo',
}
const TYPE_ORDER = ['conversion', 'remarketing', 'traffic', 'awareness', 'always_on', 'main', 'kiko', 'app', 'social', 'other']
const OPT_LABEL: Record<string, string> = {
  VALUE: 'Vrednost (value)', OFFSITE_CONVERSIONS: 'Konverzije', LANDING_PAGE_VIEWS: 'Landing page views', REACH: 'Reach', APP_INSTALLS: 'Instalacije',
}

const eur = (n: number | null | undefined) => (n == null ? '–' : `${Math.round(Number(n)).toLocaleString('sr-Latn-RS')} €`)
const day = (s: string | null) => (s ? `${Number(s.slice(8, 10))}.${Number(s.slice(5, 7))}.` : '')
const range = (a: string | null, b: string | null) => (a ? `${day(a)}${b ? ` – ${day(b)}` : ' →'}` : '–')

function budget(a: AdSet): string {
  if (a.cbo) return 'CBO (kampanja)'
  if (Number(a.adset_lifetime_eur) > 0) return `${eur(a.adset_lifetime_eur)} ukupno`
  if (Number(a.adset_daily_eur) > 0) return `${eur(a.adset_daily_eur)} / dan`
  return '–'
}

function attribution(spec: AdSet['adset_attribution_spec']): string {
  if (!spec?.length) return '–'
  const name: Record<string, string> = { CLICK_THROUGH: 'klik', VIEW_THROUGH: 'pregled', ENGAGED_VIDEO_VIEW: 'video' }
  return spec.map((s) => `${s.window_days}d ${name[s.event_type] ?? s.event_type}`).join(' + ')
}

function promoted(p: AdSet['adset_promoted_object']): string {
  if (!p) return '–'
  if (p.product_set_id) return `product set ${p.product_set_id}`
  if (p.custom_event_type) return `pixel · ${String(p.custom_event_type).toLowerCase().replace(/_/g, ' ')}`
  if (p.application_id) return 'aplikacija'
  if (p.page_id) return 'stranica'
  return '–'
}

// What is wrong with one ad set's URL tags for the GA4 matching (null = fine).
function utmIssue(tags: string | null, type: string): string | null {
  if (!tags) return type === 'app' ? null : 'bez UTM'
  const parts = tags.split(' || ')
  if (parts.some((t) => /utm_campaign=\{\{adset\.name\}\}/.test(t))) return 'utm_campaign = samo ad set'
  if (parts.some((t) => /utm_campaign=\{\{campaign\.name\}\}(&|$)/.test(t))) return 'utm_campaign = samo kampanja'
  if (parts.some((t) => !/utm_campaign=\{\{campaign\.name\}\}--\{\{adset\.name\}\}/.test(t))) return 'nestandardan utm_campaign'
  if (parts.some((t) => /utm_medium=cpc/.test(t))) return 'utm_medium=cpc umesto paid'
  return null
}

function Badge({ children, tone = 'gray' }: { children: React.ReactNode; tone?: 'gray' | 'indigo' | 'red' | 'green' }) {
  const cls = { gray: 'bg-slate-100 text-slate-600', indigo: 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]', red: 'bg-red-50 text-red-700', green: 'bg-emerald-50 text-emerald-700' }[tone]
  return <span className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${cls}`}>{children}</span>
}

export default function MetaStructure() {
  const [market, setMarket] = useState('RS')
  const [clients, setClients] = useState<Record<string, string>>({})
  const [adsets, setAdsets] = useState<AdSet[]>([])
  const [types, setTypes] = useState<Record<string, string>>({})
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [refreshing, setRefreshing] = useState(false)
  const [note, setNote] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    supabase.from('clients').select('id, name').like('name', 'Fashion&Friends %').then(({ data }) => {
      const m: Record<string, string> = {}
      for (const c of (data ?? []) as { id: string; name: string }[]) m[c.name.replace('Fashion&Friends ', '')] = c.id
      setClients(m)
    })
  }, [])

  const clientId = clients[market]

  useEffect(() => {
    if (!clientId) return
    setLoading(true); setError('')
    Promise.all([
      supabase.from('meta_adsets').select('*').eq('client_id', clientId),
      supabase.from('meta_campaign_types').select('campaign_id, line_type').eq('client_id', clientId),
      supabase.from('meta_template_adsets').select('*').eq('client_id', clientId),
    ]).then(([a, t, tp]) => {
      setLoading(false)
      const e = a.error ?? t.error ?? tp.error
      if (e) { setError(e.message); return }
      setAdsets((a.data ?? []) as AdSet[])
      setTypes(Object.fromEntries(((t.data ?? []) as CampType[]).map((x) => [x.campaign_id, x.line_type])))
      setTemplates((tp.data ?? []) as Template[])
    })
  }, [clientId, tick])

  const campaigns = useMemo(() => {
    const m = new Map<string, { id: string; name: string; type: string; cbo: boolean; daily: number | null; lifetime: number | null; objective: string | null; status: string | null; adsets: AdSet[]; spend: number }>()
    for (const a of adsets) {
      if (!m.has(a.campaign_id)) m.set(a.campaign_id, { id: a.campaign_id, name: a.campaign, type: types[a.campaign_id] ?? 'other', cbo: a.cbo, daily: a.campaign_daily_eur, lifetime: a.campaign_lifetime_eur, objective: a.campaign_objective, status: a.campaign_status, adsets: [], spend: 0 })
      const c = m.get(a.campaign_id)!
      c.adsets.push(a); c.spend += Number(a.spend ?? 0)
    }
    const list = [...m.values()]
    for (const c of list) c.adsets.sort((x, y) => (y.adset_start_time ?? '').localeCompare(x.adset_start_time ?? ''))
    return list.sort((x, y) => TYPE_ORDER.indexOf(x.type) - TYPE_ORDER.indexOf(y.type) || y.spend - x.spend)
  }, [adsets, types])

  const issues = useMemo(() => adsets
    .map((a) => ({ a, issue: utmIssue(a.url_tags, types[a.campaign_id] ?? 'other') }))
    .filter((x) => x.issue && (types[x.a.campaign_id] ?? '') !== 'social')
    .sort((x, y) => Number(y.a.spend ?? 0) - Number(x.a.spend ?? 0)), [adsets, types])

  const sortedTemplates = useMemo(() => [...templates].sort((x, y) => TYPE_ORDER.indexOf(x.line_type) - TYPE_ORDER.indexOf(y.line_type) || Number(x.add_to_cart) - Number(y.add_to_cart)), [templates])
  const snap = adsets[0]
  const totalSpend = adsets.reduce((s, a) => s + Number(a.spend ?? 0), 0)
  const issueSpend = issues.reduce((s, x) => s + Number(x.a.spend ?? 0), 0)

  async function refresh() {
    if (!clientId) return
    setRefreshing(true); setNote('')
    const { data, error: e } = await supabase.functions.invoke('facebook-ads-sync', { body: { client_id: clientId, structure: true } })
    setRefreshing(false)
    if (e) { setNote(`Greška: ${e.message}`); return }
    const n = (data?.results ?? []).reduce((s: number, r: { structure_ads?: number }) => s + (r.structure_ads ?? 0), 0)
    setNote(`Osveženo: ${n} oglasa.`)
    setTick((t) => t + 1)
  }

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow-label">Kampanje · Meta</p>
          <h1 className="font-display text-2xl font-semibold">Meta struktura</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--color-ink-soft)]">
            Snimak Meta naloga: šta builder kopira za svaku liniju iz MPL-a, sve kampanje i ad setovi sa podešavanjima, i oglasi čiji UTM kvari GA4 vezu.
            Samo čitanje, ništa se ne menja u nalogu.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {note && <span className="text-sm text-[var(--color-ink-soft)]">{note}</span>}
          <button onClick={refresh} disabled={refreshing || !clientId} className="btn-secondary text-sm">{refreshing ? 'Osvežavam…' : 'Osveži snimak'}</button>
        </div>
      </div>

      <div className="mb-6 inline-flex rounded-lg border border-[var(--color-line)] bg-white p-1 text-sm">
        {MARKETS.map((m) => (
          <button key={m} onClick={() => { setMarket(m); setOpen({}) }}
            className={`rounded px-4 py-1.5 ${market === m ? 'bg-[var(--color-indigo)] text-white' : 'text-[var(--color-ink-soft)]'}`}>{m}</button>
        ))}
      </div>

      {error && <p className="mb-4 text-sm text-[var(--color-rust)]">{error}</p>}
      {loading && <p className="text-sm text-[var(--color-ink-soft)]">Učitavanje…</p>}
      {!loading && !error && clientId && adsets.length === 0 && (
        <p className="text-sm text-[var(--color-ink-soft)]">Nema snimka za {market}. Klikni „Osveži snimak“.</p>
      )}

      {!loading && adsets.length > 0 && (<>
        <div className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
          <div className="kpi-card"><p className="kpi-label">Kampanje / ad setovi</p><p className="kpi-value">{campaigns.length} / {adsets.length}</p></div>
          <div className="kpi-card"><p className="kpi-label">Potrošnja u snimku</p><p className="kpi-value">{eur(totalSpend)}</p></div>
          <div className="kpi-card"><p className="kpi-label">UTM problemi</p><p className="kpi-value">{issues.length} <span className="text-sm font-normal text-[var(--color-ink-soft)]">ad setova · {eur(issueSpend)}</span></p></div>
          <div className="kpi-card"><p className="kpi-label">Snimak</p><p className="kpi-value text-base">{range(snap.window_from, snap.window_to)}</p>
            <p className="text-xs text-[var(--color-ink-soft)]">osveženo {new Date(snap.synced_at).toLocaleString('sr-Latn-RS', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</p></div>
        </div>

        <section className="mb-10">
          <h2 className="mb-1 text-lg font-semibold">Šabloni za builder</h2>
          <p className="mb-3 text-sm text-[var(--color-ink-soft)]">Nova akcija iz MPL-a = kopija ovog ad seta (targeting, pixel/katalog, attribution i oglasi ostaju), sa novim imenom, datumima, budžetom i kreativama.</p>
          <div className="card overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-[var(--color-ink-soft)]">
                <tr className="border-b border-[var(--color-line)]">
                  <th className="px-3 py-2">MPL linija</th><th className="px-3 py-2">Ad set (šablon)</th><th className="px-3 py-2">Datumi</th><th className="px-3 py-2">Budžet</th>
                  <th className="px-3 py-2">Optimizacija</th><th className="px-3 py-2">Cilj</th><th className="px-3 py-2">Attribution</th><th className="px-3 py-2">Adv+ publika</th>
                </tr>
              </thead>
              <tbody>
                {sortedTemplates.map((t) => (
                  <tr key={t.adset_id} className="border-b border-[var(--color-line)] last:border-0 align-top">
                    <td className="px-3 py-2 font-medium">{TYPE_LABEL[t.line_type]}{t.add_to_cart ? ' · Add to cart' : ''}</td>
                    <td className="px-3 py-2"><div>{t.adset_name}</div><div className="text-xs text-[var(--color-ink-soft)]">{t.campaign} · {t.ads} oglas{t.ads === 1 ? '' : 'a'}</div></td>
                    <td className="whitespace-nowrap px-3 py-2">{range(t.adset_start_time, t.adset_end_time)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{budget(t)}</td>
                    <td className="px-3 py-2">{OPT_LABEL[t.adset_optimization_goal ?? ''] ?? t.adset_optimization_goal}</td>
                    <td className="px-3 py-2 text-xs">{promoted(t.adset_promoted_object)}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs">{attribution(t.adset_attribution_spec)}</td>
                    <td className="px-3 py-2">{t.advantage_audience ? <Badge tone="indigo">da</Badge> : <Badge>ne</Badge>}</td>
                  </tr>
                ))}
                {sortedTemplates.length === 0 && <tr><td colSpan={8} className="px-3 py-3 text-[var(--color-ink-soft)]">Nema ad setova akcija u snimku.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="mb-10">
          <h2 className="mb-1 text-lg font-semibold">UTM problemi</h2>
          <p className="mb-3 text-sm text-[var(--color-ink-soft)]">Standard: <code className="font-mono text-xs">utm_source=facebook&amp;utm_medium=paid&amp;utm_campaign={'{{campaign.name}}--{{adset.name}}'}</code>. Ostalo GA4 ne vezuje za MPL liniju (ili deli medium na dva).</p>
          {issues.length === 0 ? <p className="text-sm text-emerald-700">Svi ad setovi imaju standardni UTM.</p> : (
            <div className="card overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-[var(--color-ink-soft)]">
                  <tr className="border-b border-[var(--color-line)]"><th className="px-3 py-2">Problem</th><th className="px-3 py-2">Kampanja / ad set</th><th className="px-3 py-2 text-right">Potrošnja</th></tr>
                </thead>
                <tbody>
                  {issues.map(({ a, issue }) => (
                    <tr key={a.adset_id} className="border-b border-[var(--color-line)] last:border-0 align-top">
                      <td className="px-3 py-2"><Badge tone="red">{issue}</Badge></td>
                      <td className="px-3 py-2"><div>{a.adset_name}</div><div className="text-xs text-[var(--color-ink-soft)]">{a.campaign}</div></td>
                      <td className="whitespace-nowrap px-3 py-2 text-right">{eur(a.spend)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section>
          <h2 className="mb-3 text-lg font-semibold">Kampanje i ad setovi</h2>
          <div className="space-y-2">
            {campaigns.map((c) => (
              <div key={c.id} className="card">
                <button onClick={() => setOpen({ ...open, [c.id]: !open[c.id] })} className="flex w-full items-center gap-3 px-4 py-3 text-left">
                  <span className="text-xs text-[var(--color-ink-soft)]">{open[c.id] ? '▾' : '▸'}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="text-xs text-[var(--color-ink-soft)]">{c.adsets.length} ad set{c.adsets.length === 1 ? '' : 'ova'} · {c.cbo ? `CBO ${c.daily ? `${eur(c.daily)} / dan` : c.lifetime ? `${eur(c.lifetime)} ukupno` : ''}` : 'budžet po ad setu'}</span>
                  </span>
                  <Badge tone={c.type === 'social' || c.type === 'other' ? 'gray' : 'indigo'}>{TYPE_LABEL[c.type]}</Badge>
                  {c.status && c.status !== 'ACTIVE' && <Badge>{c.status.toLowerCase()}</Badge>}
                  <span className="w-24 text-right text-sm">{eur(c.spend)}</span>
                </button>
                {open[c.id] && (
                  <div className="overflow-x-auto border-t border-[var(--color-line)]">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-[var(--color-ink-soft)]">
                        <tr><th className="px-4 py-2">Ad set</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Datumi</th><th className="px-3 py-2">Budžet</th><th className="px-3 py-2">Optimizacija</th><th className="px-3 py-2">Cilj</th><th className="px-3 py-2">UTM</th><th className="px-3 py-2 text-right">Potrošnja</th></tr>
                      </thead>
                      <tbody>
                        {c.adsets.map((a) => {
                          const issue = utmIssue(a.url_tags, c.type)
                          return (
                            <tr key={a.adset_id} className="border-t border-[var(--color-line)] align-top">
                              <td className="px-4 py-2"><div>{a.adset_name}</div><div className="font-mono text-[11px] text-[var(--color-ink-soft)]">{a.adset_id} · {a.ads} oglas{a.ads === 1 ? '' : 'a'}</div></td>
                              <td className="px-3 py-2">{a.adset_status === 'ACTIVE' ? <Badge tone="green">aktivan</Badge> : <Badge>{(a.adset_status ?? '–').toLowerCase()}</Badge>}</td>
                              <td className="whitespace-nowrap px-3 py-2">{range(a.adset_start_time, a.adset_end_time)}</td>
                              <td className="whitespace-nowrap px-3 py-2">{budget(a)}</td>
                              <td className="px-3 py-2">{OPT_LABEL[a.adset_optimization_goal ?? ''] ?? a.adset_optimization_goal}</td>
                              <td className="px-3 py-2 text-xs">{promoted(a.adset_promoted_object)}</td>
                              <td className="px-3 py-2">{issue ? <Badge tone="red">{issue}</Badge> : a.url_tags ? <Badge tone="green">ok</Badge> : <Badge>–</Badge>}</td>
                              <td className="whitespace-nowrap px-3 py-2 text-right">{eur(a.spend)}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      </>)}
    </div>
  )
}
