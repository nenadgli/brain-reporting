import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

// "Proizvodi": product feeds Brain checks on a schedule, each check's totals, and every change per
// product (new, out of stock, back, price, sale, title, custom labels). Read-only.

type Feed = { id: string; market: string; url: string; interval_hours: number; enabled: boolean; last_checked_at: string | null; last_status: string | null; last_error: string | null; clients: { name: string } | null }
type Snapshot = { id: number; checked_at: string; status: string; items: number | null; on_sale: number | null; avg_discount_pct: number | null; new_items: number | null; removed_items: number | null; back_items: number | null; price_changes: number | null; sale_changes: number | null; other_changes: number | null; error: string | null }
type Change = { id: number; item_id: string; changed_at: string; kind: string; old_value: string | null; new_value: string | null }
type Item = { item_id: string; title: string | null; price: number | null; sale_price: number | null; link: string | null; removed_at: string | null }
type Perf = {
  item_id: string; title: string | null; category: string | null; link: string | null; price: number | null; sale_price: number | null; in_feed: boolean
  views: number; add_to_cart: number; purchases: number; revenue: number; impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number
  meta_spend: number; meta_purchases: number; meta_value: number
  last_change_kind: string | null; last_change_at: string | null; last_change_old: string | null; last_change_new: string | null
}
// Signals worth a look; thresholds are deliberately simple and shown on screen.
type Seg = {
  value: string; items: number; items_start: number | null; on_sale: number; on_sale_start: number | null; avg_price: number | null; avg_effective_price: number | null
  avg_discount_pct: number | null; avg_discount_start: number | null; max_discount_pct: number | null; new_items: number; removed_items: number; price_changes: number
  views: number; add_to_cart: number; purchases: number; revenue: number; clicks: number; spend: number; conversion_value: number; meta_spend: number; meta_value: number; start_day: string | null; end_day: string | null
}
type Sum = { day: string; value: string; kind: string; n: number; avg_pct: number | null; items: { item_id: string; title: string | null; old: string | null; new: string | null; pct: number | null }[] }
// How each kind of change reads in the summary.
const SUM_LABEL: Record<string, (n: number) => string> = {
  price_down: (n) => `${n} pojeftinilo`, price_up: (n) => `${n} poskupelo`, sale_start: (n) => `${n} stavljeno na akciju`,
  sale_end: (n) => `${n} skinuto sa akcije`, new: (n) => `${n} ubačeno`, removed: (n) => `${n} izbačeno (nema na stanju)`,
  back: (n) => `${n} vraćeno`, title: (n) => `${n} promenjen naslov`, label: (n) => `${n} promenjen label`, availability: (n) => `${n} promenjena dostupnost`,
}
const DIMS: [string, string][] = [
  ['category', 'Kategorija'], ['price', 'Cenovni razred (cena koju kupac plaća)'], ['discount', 'Popust'], ['sale', 'Akcija / puna cena'],
  ['brand', 'Brend'], ['gender', 'Pol'], ['color', 'Boja'], ['google_category', 'Google kategorija'],
  ['label0', 'Custom label 0'], ['label1', 'Custom label 1'], ['label2', 'Custom label 2'], ['label3', 'Custom label 3'], ['label4', 'Custom label 4'],
]
const FLAGS: { key: string; label: string; test: (p: Perf) => boolean }[] = [
  { key: 'bez_prodaje', label: 'troši bez prodaje (≥ 30, 0 kupovina)', test: (p) => p.spend >= 30 && p.purchases === 0 },
  { key: 'bez_oglasa', label: 'prodaje se, a skoro bez oglasa (≥ 3 kupovine, < 5 troška)', test: (p) => p.purchases >= 3 && p.spend < 5 },
  { key: 'nema_stanja', label: 'nema na stanju, a trošio je', test: (p) => !p.in_feed && p.spend > 0 },
]

const KIND: Record<string, { label: string; cls: string }> = {
  new: { label: 'nov', cls: 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' },
  removed: { label: 'nema na stanju', cls: 'bg-red-50 text-[var(--color-rust)]' },
  back: { label: 'vratio se', cls: 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' },
  price_up: { label: 'poskupeo', cls: 'bg-amber-50 text-amber-800' },
  price_down: { label: 'pojeftinio', cls: 'bg-amber-50 text-amber-800' },
  sale_start: { label: 'akcija počela', cls: 'bg-amber-50 text-amber-800' },
  sale_end: { label: 'akcija završena', cls: 'bg-amber-50 text-amber-800' },
  title: { label: 'naslov', cls: 'bg-[var(--color-paper)] text-[var(--color-ink-soft)]' },
  label: { label: 'custom label', cls: 'bg-[var(--color-paper)] text-[var(--color-ink-soft)]' },
  availability: { label: 'dostupnost', cls: 'bg-[var(--color-paper)] text-[var(--color-ink-soft)]' },
}
const STATUS: Record<string, string> = { ok: 'u redu', nepromenjen: 'bez promena', osnova: 'prvi snimak', sumnjiv: 'sumnjiv feed', greska: 'greška' }
const n0 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('sr-RS', { maximumFractionDigits: 0 }))
const when = (s: string) => new Date(s).toLocaleString('sr-Latn-RS', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })

export default function ProductFeeds() {
  const [feeds, setFeeds] = useState<Feed[]>([])
  const [feedId, setFeedId] = useState('')
  const [snaps, setSnaps] = useState<Snapshot[]>([])
  const [changes, setChanges] = useState<Change[]>([])
  const [items, setItems] = useState<Record<string, Item>>({})
  const [kind, setKind] = useState('')
  const [q, setQ] = useState('')
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'segments' | 'perf' | 'changes'>('segments')
  const [dim, setDim] = useState('category')
  const [segs, setSegs] = useState<Seg[]>([])
  const [sums, setSums] = useState<Sum[]>([])
  const [days, setDays] = useState(30)
  const [perf, setPerf] = useState<Perf[]>([])
  const [flag, setFlag] = useState('')
  const [sort, setSort] = useState<keyof Perf>('spend')

  useEffect(() => {
    supabase.from('product_feeds').select('id, market, url, interval_hours, enabled, last_checked_at, last_status, last_error, clients(name)').eq('enabled', true).order('created_at')
      .then(({ data, error: e }) => {
        if (e) { setError(e.message); return }
        const list = (data ?? []) as unknown as Feed[]
        setFeeds(list)
        if (list.length) setFeedId(list[0].id)
      })
  }, [])

  useEffect(() => {
    if (!feedId) return
    setError('')
    let q1 = supabase.from('feed_changes').select('id, item_id, changed_at, kind, old_value, new_value').eq('feed_id', feedId).order('changed_at', { ascending: false }).limit(500)
    if (kind) q1 = q1.eq('kind', kind)
    Promise.all([
      supabase.from('feed_snapshots').select('*').eq('feed_id', feedId).order('checked_at', { ascending: false }).limit(30),
      q1,
    ]).then(async ([s, c]) => {
      if (s.error || c.error) { setError((s.error ?? c.error)!.message); return }
      setSnaps((s.data ?? []) as Snapshot[])
      const ch = (c.data ?? []) as Change[]
      setChanges(ch)
      const ids = [...new Set(ch.map((x) => x.item_id))]
      const m: Record<string, Item> = {}
      for (let i = 0; i < ids.length; i += 200) {
        const { data } = await supabase.from('feed_items').select('item_id, title, price, sale_price, link, removed_at').eq('feed_id', feedId).in('item_id', ids.slice(i, i + 200))
        for (const it of (data ?? []) as Item[]) m[it.item_id] = it
      }
      setItems(m)
    })
  }, [feedId, kind])

  useEffect(() => {
    if (!feedId) return
    const to = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
    supabase.rpc('product_performance', { p_feed_id: feedId, p_from: from, p_to: to }).then(({ data, error: e }) => {
      if (e) { setError(e.message); return }
      setPerf(((data ?? []) as Perf[]).map((p) => ({ ...p, views: +p.views, add_to_cart: +p.add_to_cart, purchases: +p.purchases, revenue: +p.revenue, impressions: +p.impressions, clicks: +p.clicks, spend: +p.spend, conversions: +p.conversions, conversion_value: +p.conversion_value, meta_spend: +p.meta_spend, meta_purchases: +p.meta_purchases, meta_value: +p.meta_value })))
    })
  }, [feedId, days])

  useEffect(() => {
    if (!feedId) return
    const to = new Date(Date.now() - 864e5).toISOString().slice(0, 10)
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
    supabase.rpc('feed_segments', { p_feed_id: feedId, p_dim: dim, p_from: from, p_to: to }).then(({ data, error: e }) => {
      if (e) { setError(e.message); return }
      setSegs(((data ?? []) as Seg[]).map((x) => ({ ...x, revenue: +x.revenue, spend: +x.spend, purchases: +x.purchases, conversion_value: +x.conversion_value, views: +x.views, meta_spend: +x.meta_spend, meta_value: +x.meta_value })))
    })
  }, [feedId, dim, days])
  useEffect(() => {
    if (!feedId || tab !== 'changes') return
    const to = new Date().toISOString().slice(0, 10)
    const from = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10)
    supabase.rpc('feed_change_summary', { p_feed_id: feedId, p_dim: dim, p_from: from, p_to: to }).then(({ data, error: e }) => {
      if (e) { setError(e.message); return }
      setSums((data ?? []) as Sum[])
    })
  }, [feedId, dim, days, tab])
  const sumDays = useMemo(() => {
    const m = new Map<string, Map<string, Sum[]>>()
    for (const x of sums) {
      const d = m.get(x.day) ?? new Map<string, Sum[]>()
      d.set(x.value, [...(d.get(x.value) ?? []), x])
      m.set(x.day, d)
    }
    return [...m.entries()].map(([day, segsOfDay]) => ({ day, segs: [...segsOfDay.entries()].sort((a, b) => b[1].reduce((t, x) => t + x.n, 0) - a[1].reduce((t, x) => t + x.n, 0)) }))
  }, [sums])
  const segTotals = useMemo(() => segs.reduce((t, x) => ({ items: t.items + x.items, revenue: t.revenue + x.revenue, spend: t.spend + x.spend }), { items: 0, revenue: 0, spend: 0 }), [segs])

  const perfShown = useMemo(() => {
    const t = q.trim().toLowerCase()
    const f = FLAGS.find((x) => x.key === flag)
    return perf.filter((p) => (!f || f.test(p)) && (!t || p.item_id.toLowerCase().includes(t) || (p.title ?? '').toLowerCase().includes(t)))
      .sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0)).slice(0, 300)
  }, [perf, flag, q, sort])
  const totals = useMemo(() => perf.reduce((t, p) => ({ spend: t.spend + p.spend, revenue: t.revenue + p.revenue, purchases: t.purchases + p.purchases, value: t.value + p.conversion_value }), { spend: 0, revenue: 0, purchases: 0, value: 0 }), [perf])

  const feed = feeds.find((f) => f.id === feedId)
  const last = snaps.find((s) => s.status !== 'greska' && s.items != null)
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase()
    return t ? changes.filter((c) => c.item_id.toLowerCase().includes(t) || (items[c.item_id]?.title ?? '').toLowerCase().includes(t)) : changes
  }, [changes, items, q])

  const inputCls = 'rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Praćenje product feeda</p>
          <h1 className="font-display mt-1 text-4xl font-medium">Proizvodi</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-ink-soft)]">
            Brain preuzima feed na nekoliko sati i beleži svaku promenu po proizvodu. Feed sadrži samo proizvode na stanju, pa „nema na stanju“ znači da je proizvod nestao iz feeda.
          </p>
        </div>
        <select value={feedId} onChange={(e) => setFeedId(e.target.value)} className={inputCls}>
          {feeds.map((f) => <option key={f.id} value={f.id}>{f.clients?.name ?? '—'} {f.market}</option>)}
        </select>
      </header>

      {error && <p className="mb-6 rounded bg-red-50 px-4 py-2 text-sm text-[var(--color-rust)]">{error}</p>}
      {!feeds.length && !error && <p className="text-sm text-[var(--color-ink-soft)]">Još nema feedova za praćenje.</p>}

      {feed && (
        <>
          <section className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-5">
            {[
              ['Proizvoda u feedu', n0(last?.items)],
              ['Na akciji', last?.items ? `${n0(last.on_sale)} (${Math.round(Number(last.on_sale) / Number(last.items) * 100)}%)` : '—'],
              ['Prosečan popust', last?.avg_discount_pct != null ? `${last.avg_discount_pct}%` : '—'],
              ['Poslednja provera', feed.last_checked_at ? when(feed.last_checked_at) : '—'],
              ['Stanje', `${STATUS[feed.last_status ?? ''] ?? '—'} · na ${feed.interval_hours} h`],
            ].map(([k, v]) => (
              <div key={k} className="rounded border border-[var(--color-line)] bg-white p-4">
                <p className="text-xs text-[var(--color-ink-soft)]">{k}</p>
                <p className="font-display mt-1 text-xl">{v}</p>
              </div>
            ))}
          </section>
          {feed.last_error && <p className="mb-6 rounded bg-red-50 px-4 py-2 text-sm text-[var(--color-rust)]">Poslednja provera: {feed.last_error}</p>}


          <div className="mb-4 flex overflow-hidden rounded border border-[var(--color-line)] text-sm" style={{ width: 'fit-content' }}>
            {([['segments', 'Segmenti'], ['perf', 'Učinak po proizvodu'], ['changes', 'Promene u feedu']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setTab(k)} className={`px-4 py-1.5 ${tab === k ? 'bg-[var(--color-indigo)] text-white' : 'bg-white'}`}>{l}</button>
            ))}
          </div>

          {tab === 'segments' && (
          <section className="mb-10">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <select value={dim} onChange={(e) => setDim(e.target.value)} className={inputCls}>
                {DIMS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputCls}>
                {[7, 14, 30].map((d) => <option key={d} value={d}>poslednjih {d} dana</option>)}
              </select>
              {segs[0]?.start_day && <span className="text-xs text-[var(--color-ink-soft)]">stanje feeda: {segs[0].end_day} naspram {segs[0].start_day}{segs[0].start_day === segs[0].end_day ? ' (istorija segmenata se puni od danas)' : ''}</span>}
            </div>
            <p className="mb-2 text-xs text-[var(--color-ink-soft)]">Feed: proizvodi, udeo na akciji, prosečna cena i popust danas i promena od početka perioda, novi, nestali i promene cene u periodu. Prodaja (GA4) i oglasi (Google Ads) su za isti period; udeo pokazuje da li segment dobija oglase srazmerno prodaji.</p>
            <div className="overflow-x-auto rounded border border-[var(--color-line)] bg-white">
              <table className="w-full text-xs">
                <thead className="bg-[var(--color-paper)] text-left text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">{DIMS.find(([k]) => k === dim)?.[1]}</th>
                    <th className="px-2 text-right">Proizvoda</th><th className="px-2 text-right">Na akciji</th><th className="px-2 text-right">Prosečan popust</th>
                    <th className="px-2 text-right">Prosečna cena</th><th className="px-2 text-right">Novi / nestali</th><th className="px-2 text-right">Promene cene</th>
                    <th className="px-2 text-right">Kupovine</th><th className="px-2 text-right">Prihod GA4</th><th className="px-2 text-right">Udeo prihoda</th>
                    <th className="px-2 text-right">Trošak Google</th><th className="px-2 text-right">Udeo troška Google</th><th className="px-2 text-right">ROAS Google</th>
                    <th className="px-2 text-right">Trošak Meta</th><th className="px-2 text-right">ROAS Meta</th>
                  </tr>
                </thead>
                <tbody>
                  {segs.map((x) => {
                    const delta = (a: number | null, b: number | null, unit = '') => (a == null || b == null || a === b ? '' : ` (${a > b ? '+' : ''}${Math.round((a - b) * 10) / 10}${unit})`)
                    const revShare = segTotals.revenue ? x.revenue / segTotals.revenue * 100 : 0
                    const spendShare = segTotals.spend ? x.spend / segTotals.spend * 100 : 0
                    return (
                      <tr key={x.value} className="border-t border-[var(--color-line)]">
                        <td className="px-3 py-1.5 font-medium">{x.value}</td>
                        <td className="px-2 text-right">{n0(x.items)}<span className="text-[var(--color-ink-soft)]">{delta(x.items, x.items_start)}</span></td>
                        <td className="px-2 text-right">{x.items ? `${Math.round(x.on_sale / x.items * 100)}%` : '—'}</td>
                        <td className="px-2 text-right">{x.avg_discount_pct != null ? `${x.avg_discount_pct}%` : '—'}<span className="text-[var(--color-ink-soft)]">{delta(x.avg_discount_pct, x.avg_discount_start, ' pp')}</span>{x.max_discount_pct != null ? <span className="block text-[var(--color-ink-soft)]">do {x.max_discount_pct}%</span> : null}</td>
                        <td className="px-2 text-right">{n0(x.avg_effective_price)}{x.avg_price != null && x.avg_effective_price != null && x.avg_price !== x.avg_effective_price ? <span className="block text-[var(--color-ink-soft)]">pre popusta {n0(x.avg_price)}</span> : null}</td>
                        <td className="px-2 text-right">{x.new_items} / {x.removed_items}</td>
                        <td className="px-2 text-right">{x.price_changes}</td>
                        <td className="px-2 text-right">{n0(x.purchases)}</td>
                        <td className="px-2 text-right">{n0(x.revenue)}</td>
                        <td className="px-2 text-right">{revShare ? `${Math.round(revShare)}%` : '—'}</td>
                        <td className="px-2 text-right">{n0(x.spend)}</td>
                        <td className={`px-2 text-right ${spendShare > revShare * 1.5 && spendShare >= 5 ? 'text-[var(--color-rust)]' : revShare > spendShare * 1.5 && revShare >= 5 ? 'text-[var(--color-indigo-dark)]' : ''}`}>{spendShare ? `${Math.round(spendShare)}%` : '—'}</td>
                        <td className="px-2 text-right">{x.spend > 0 ? (x.conversion_value / x.spend).toFixed(1) : '—'}</td>
                        <td className="px-2 text-right">{n0(x.meta_spend)}</td>
                        <td className="px-2 text-right">{x.meta_spend > 0 ? (x.meta_value / x.meta_spend).toFixed(1) : '—'}</td>
                      </tr>
                    )
                  })}
                  {!segs.length && <tr><td colSpan={15} className="px-3 py-4 text-sm text-[var(--color-ink-soft)]">Nema podataka po segmentima (snimak segmenata se pravi posle prve sledeće provere feeda).</td></tr>}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-[var(--color-ink-soft)]">Crven udeo troška: segment dobija znatno veći deo budžeta nego prihoda. Plav: prodaje se više nego što dobija oglase.</p>
          </section>
          )}

          {tab === 'perf' && (
          <section className="mb-10">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputCls}>
                {[7, 14, 30].map((d) => <option key={d} value={d}>poslednjih {d} dana</option>)}
              </select>
              <select value={flag} onChange={(e) => setFlag(e.target.value)} className={inputCls}>
                <option value="">svi proizvodi</option>
                {FLAGS.map((f) => <option key={f.key} value={f.key}>{f.label} ({perf.filter(f.test).length})</option>)}
              </select>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID ili naziv proizvoda" className={`${inputCls} w-56`} />
              <span className="text-xs text-[var(--color-ink-soft)]">Google Ads trošak {n0(totals.spend)} · GA4 prihod {n0(totals.revenue)} · kupovina {n0(totals.purchases)}</span>
            </div>
            <p className="mb-2 text-xs text-[var(--color-ink-soft)]">GA4: pregledi, korpa, kupovine i prihod za tržište feeda. Google Ads: Shopping i PMax po proizvodu. Klik na naslov kolone sortira.</p>
            <div className="overflow-x-auto rounded border border-[var(--color-line)] bg-white">
              <table className="w-full text-xs">
                <thead className="bg-[var(--color-paper)] text-left text-[var(--color-ink-soft)]">
                  <tr>
                    <th className="px-3 py-2">Proizvod</th><th className="px-2 text-right">Cena</th>
                    {([['views', 'Pregledi'], ['add_to_cart', 'Korpa'], ['purchases', 'Kupovine'], ['revenue', 'Prihod GA4'], ['clicks', 'Klikovi'], ['spend', 'Trošak Google'], ['conversion_value', 'Vrednost Google'], ['meta_spend', 'Trošak Meta'], ['meta_value', 'Vrednost Meta']] as [keyof Perf, string][]).map(([k, l]) => (
                      <th key={k} className="cursor-pointer px-2 text-right" onClick={() => setSort(k)}>{l}{sort === k ? ' ↓' : ''}</th>
                    ))}
                    <th className="px-2 text-right">ROAS Google</th><th className="px-2">Poslednja promena u feedu</th>
                  </tr>
                </thead>
                <tbody>
                  {perfShown.map((p) => (
                    <tr key={p.item_id} className="border-t border-[var(--color-line)]">
                      <td className="px-3 py-1.5">
                        {p.link ? <a href={p.link} target="_blank" rel="noreferrer" className="underline decoration-[var(--color-line)]">{p.title ?? p.item_id}</a> : (p.title ?? p.item_id)}
                        <span className="ml-1 text-[var(--color-ink-soft)]">{p.item_id}</span>
                        {!p.in_feed && <span className="ml-1 rounded bg-red-50 px-1 text-[var(--color-rust)]">nema na stanju</span>}
                        {FLAGS.filter((f) => f.key !== 'nema_stanja' && f.test(p)).map((f) => <span key={f.key} className="ml-1 rounded bg-amber-50 px-1 text-amber-800">{f.key === 'bez_prodaje' ? 'troši bez prodaje' : 'bez oglasa'}</span>)}
                      </td>
                      <td className="px-2 text-right whitespace-nowrap">{p.sale_price != null ? <><s className="text-[var(--color-ink-soft)]">{n0(p.price)}</s> {n0(p.sale_price)}</> : n0(p.price)}</td>
                      <td className="px-2 text-right">{n0(p.views)}</td>
                      <td className="px-2 text-right">{n0(p.add_to_cart)}</td>
                      <td className="px-2 text-right">{n0(p.purchases)}</td>
                      <td className="px-2 text-right">{n0(p.revenue)}</td>
                      <td className="px-2 text-right">{n0(p.clicks)}</td>
                      <td className="px-2 text-right">{n0(p.spend)}</td>
                      <td className="px-2 text-right">{n0(p.conversion_value)}</td>
                      <td className="px-2 text-right">{n0(p.meta_spend)}</td>
                      <td className="px-2 text-right">{n0(p.meta_value)}</td>
                      <td className="px-2 text-right">{p.spend > 0 ? (p.conversion_value / p.spend).toFixed(1) : '—'}</td>
                      <td className="px-2 whitespace-nowrap">{p.last_change_kind ? <><span className={`rounded px-1 ${KIND[p.last_change_kind]?.cls ?? ''}`}>{KIND[p.last_change_kind]?.label ?? p.last_change_kind}</span> {p.last_change_at ? when(p.last_change_at) : ''}</> : ''}</td>
                    </tr>
                  ))}
                  {!perfShown.length && <tr><td colSpan={13} className="px-3 py-4 text-sm text-[var(--color-ink-soft)]">Nema podataka za ovaj izbor.</td></tr>}
                </tbody>
              </table>
            </div>
            {perf.length > 300 && <p className="mt-2 text-xs text-[var(--color-ink-soft)]">Prikazano prvih 300 od {perf.length}; suzi filterom ili pretragom.</p>}
          </section>
          )}

          {tab === 'changes' && <>
          <section className="mb-10">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-xl font-medium">Šta se promenilo</h2>
              <select value={dim} onChange={(e) => setDim(e.target.value)} className={inputCls}>
                {DIMS.map(([k, l]) => <option key={k} value={k}>po: {l}</option>)}
              </select>
              <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputCls}>
                {[7, 14, 30].map((d) => <option key={d} value={d}>poslednjih {d} dana</option>)}
              </select>
            </div>
            {!sumDays.length && <p className="rounded border border-dashed border-[var(--color-line)] bg-white p-4 text-sm text-[var(--color-ink-soft)]">U ovom periodu feed se nije menjao (ili još nema dve provere za poređenje).</p>}
            <div className="space-y-4">
              {sumDays.map(({ day, segs: ss }) => (
                <div key={day} className="rounded border border-[var(--color-line)] bg-white p-3">
                  <p className="mb-2 text-sm font-medium">{new Date(day + 'T00:00:00').toLocaleDateString('sr-Latn-RS', { weekday: 'long', day: 'numeric', month: 'numeric' })}</p>
                  <ul className="space-y-1 text-sm">
                    {ss.map(([value, list]) => (
                      <li key={value}>
                        <details>
                          <summary className="cursor-pointer">
                            <span className="font-medium">{value}:</span>{' '}
                            {list.map((x) => `${(SUM_LABEL[x.kind] ?? ((n: number) => `${n} ${x.kind}`))(x.n)}${x.avg_pct != null && ['price_down', 'price_up', 'sale_start', 'sale_end'].includes(x.kind) ? ` (${x.avg_pct > 0 ? '+' : ''}${x.avg_pct}% prosečno)` : ''}`).join(', ')}
                          </summary>
                          <table className="mt-1 mb-2 w-full text-xs">
                            <tbody>
                              {list.flatMap((x) => x.items.slice(0, 50).map((i) => (
                                <tr key={x.kind + i.item_id} className="border-t border-[var(--color-line)]">
                                  <td className="py-0.5 pr-3"><span className={`rounded px-1 ${KIND[x.kind]?.cls ?? ''}`}>{KIND[x.kind]?.label ?? x.kind}</span></td>
                                  <td className="pr-3">{i.title ?? i.item_id} <span className="text-[var(--color-ink-soft)]">{i.item_id}</span></td>
                                  <td className="pr-3 text-right whitespace-nowrap">{i.old ?? ''}{i.old && i.new ? ' → ' : ''}{i.new ?? ''}</td>
                                  <td className="text-right">{i.pct != null ? `${i.pct > 0 ? '+' : ''}${i.pct}%` : ''}</td>
                                </tr>
                              )))}
                            </tbody>
                          </table>
                        </details>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </section>

          <h2 className="font-display mb-3 text-xl font-medium">Provere feeda</h2>
          <section className="mb-10 overflow-x-auto rounded border border-[var(--color-line)] bg-white">
            <table className="w-full text-xs">
              <thead className="bg-[var(--color-paper)] text-left text-[var(--color-ink-soft)]">
                <tr>
                  <th className="px-3 py-2">Provera</th><th className="px-2">Stanje</th>
                  {['Proizvoda', 'Na akciji', 'Novi', 'Nema na stanju', 'Vratili se', 'Promene cene', 'Akcija počela/završena', 'Ostalo'].map((h) => <th key={h} className="px-2 text-right">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {snaps.map((s) => (
                  <tr key={s.id} className="border-t border-[var(--color-line)]" title={s.error ?? undefined}>
                    <td className="px-3 py-1.5">{when(s.checked_at)}</td>
                    <td className={`px-2 ${s.status === 'greska' || s.status === 'sumnjiv' ? 'text-[var(--color-rust)]' : ''}`}>{STATUS[s.status] ?? s.status}</td>
                    {[s.items, s.on_sale, s.new_items, s.removed_items, s.back_items, s.price_changes, s.sale_changes, s.other_changes].map((v, i) => <td key={i} className="px-2 text-right">{n0(v)}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 className="font-display text-xl font-medium">Promene po proizvodu</h2>
              <select value={kind} onChange={(e) => setKind(e.target.value)} className={inputCls}>
                <option value="">sve promene</option>
                {Object.entries(KIND).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID ili naziv proizvoda" className={`${inputCls} w-64`} />
              <span className="text-xs text-[var(--color-ink-soft)]">poslednjih {changes.length}</span>
            </div>
            <div className="overflow-x-auto rounded border border-[var(--color-line)] bg-white">
              <table className="w-full text-xs">
                <thead className="bg-[var(--color-paper)] text-left text-[var(--color-ink-soft)]">
                  <tr><th className="px-3 py-2">Kada</th><th className="px-2">Promena</th><th className="px-2">Proizvod</th><th className="px-2">Bilo</th><th className="px-2">Sada</th></tr>
                </thead>
                <tbody>
                  {shown.map((c) => {
                    const it = items[c.item_id]
                    return (
                      <tr key={c.id} className="border-t border-[var(--color-line)]">
                        <td className="px-3 py-1.5 whitespace-nowrap">{when(c.changed_at)}</td>
                        <td className="px-2"><span className={`rounded px-1.5 py-0.5 ${KIND[c.kind]?.cls ?? ''}`}>{KIND[c.kind]?.label ?? c.kind}</span></td>
                        <td className="px-2">
                          {it?.link ? <a href={it.link} target="_blank" rel="noreferrer" className="underline decoration-[var(--color-line)]">{it.title ?? c.item_id}</a> : (it?.title ?? c.item_id)}
                          <span className="ml-1 text-[var(--color-ink-soft)]">{c.item_id}</span>
                        </td>
                        <td className="px-2">{c.old_value ?? ''}</td>
                        <td className="px-2">{c.new_value ?? ''}</td>
                      </tr>
                    )
                  })}
                  {!shown.length && <tr><td colSpan={5} className="px-3 py-4 text-sm text-[var(--color-ink-soft)]">{snaps.length <= 1 ? 'Prvi snimak feeda je sačuvan; promene se vide od sledeće provere.' : 'Nema promena za ovaj izbor.'}</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          </>}
        </>
      )}
    </div>
  )
}
