import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'

// "Proizvodi": product feeds Brain checks on a schedule, each check's totals, and every change per
// product (new, out of stock, back, price, sale, title, custom labels). Read-only.

type Feed = { id: string; market: string; url: string; interval_hours: number; enabled: boolean; last_checked_at: string | null; last_status: string | null; last_error: string | null; clients: { name: string } | null }
type Snapshot = { id: number; checked_at: string; status: string; items: number | null; on_sale: number | null; avg_discount_pct: number | null; new_items: number | null; removed_items: number | null; back_items: number | null; price_changes: number | null; sale_changes: number | null; other_changes: number | null; error: string | null }
type Change = { id: number; item_id: string; changed_at: string; kind: string; old_value: string | null; new_value: string | null }
type Item = { item_id: string; title: string | null; price: number | null; sale_price: number | null; link: string | null; removed_at: string | null }

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
        </>
      )}
    </div>
  )
}
