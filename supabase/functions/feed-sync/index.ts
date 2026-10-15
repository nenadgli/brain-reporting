import { createClient } from 'jsr:@supabase/supabase-js@2'

// Praćenje product feeda. Downloads one feed (Meta or Google Merchant CSV/TSV), compares it with the
// products stored from the previous check and records every change per product in feed_changes.
// The first check only stores the baseline. A feed with less than half the products of the last
// check is recorded as "sumnjiv" and nothing is marked as gone. Read-only against the client's site.

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
const LABELS = ['custom_label_0', 'custom_label_1', 'custom_label_2', 'custom_label_3', 'custom_label_4']

type Item = {
  item_id: string; group_id: string | null; title: string | null; brand: string | null; category: string | null
  price: number | null; sale_price: number | null; currency: string | null; availability: string | null
  link: string | null; image: string | null; labels: Record<string, string>; attrs: Record<string, string>
}
type Stored = Item & { removed_at: string | null }

// RFC 4180: quoted fields may hold the delimiter, doubled quotes and line breaks.
function parseDelimited(text: string): string[][] {
  const delim = (text.slice(0, text.indexOf('\n')).match(/\t/g)?.length ?? 0) > 3 ? '\t' : ','
  const rows: string[][] = []
  let row: string[] = [], field = '', quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else quoted = false }
      else field += c
    } else if (c === '"' && field === '') quoted = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

// "59.00 EUR" or "59,00" -> 59, "EUR"
function money(v: string | undefined): { n: number | null; cur: string | null } {
  const s = (v ?? '').trim()
  if (!s) return { n: null, cur: null }
  const cur = s.match(/[A-Z]{3}/)?.[0] ?? null
  const num = Number(s.replace(/[A-Z]{3}/, '').trim().replace(/\s/g, '').replace(/,(\d{1,2})$/, '.$1').replace(/,/g, ''))
  return { n: Number.isFinite(num) ? num : null, cur }
}

// Attributes kept for segments (gender, color...); the category comes from settings.category_field
// (e.g. custom_label_1), else product_type, else google_product_category.
const ATTRS = ['gender', 'color', 'age_group', 'material', 'size', 'product_type', 'google_product_category']

function toItems(rows: string[][], categoryField?: string): Item[] {
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/^g:/, ''))
  const col = (r: string[], name: string) => { const i = head.indexOf(name); return i < 0 ? '' : (r[i] ?? '').trim() }
  const out = new Map<string, Item>()
  for (const r of rows.slice(1)) {
    const id = col(r, 'id').toUpperCase()
    if (!id) continue
    const p = money(col(r, 'price')), s = money(col(r, 'sale_price'))
    const labels: Record<string, string> = {}
    for (const l of LABELS) { const v = col(r, l); if (v) labels[l] = v }
    out.set(id, {
      item_id: id, group_id: col(r, 'item_group_id') || null, title: col(r, 'title') || null, brand: col(r, 'brand') || null,
      category: (categoryField ? col(r, categoryField.toLowerCase()) : '') || col(r, 'product_type') || col(r, 'google_product_category') || null,
      price: p.n, sale_price: s.n != null && p.n != null && s.n < p.n ? s.n : null, currency: p.cur ?? s.cur,
      availability: col(r, 'availability') || null, link: col(r, 'link') || null, image: col(r, 'image_link') || null, labels,
      attrs: Object.fromEntries(ATTRS.map((a) => [a, col(r, a)]).filter(([, v]) => v)),
    })
  }
  return [...out.values()]
}

const eff = (i: Pick<Item, 'price' | 'sale_price'>) => i.sale_price ?? i.price
const fmt = (n: number | null) => (n == null ? '' : n.toFixed(2))

async function storedItems(feedId: string): Promise<Map<string, Stored>> {
  const m = new Map<string, Stored>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb.from('feed_items').select('item_id, group_id, title, brand, category, price, sale_price, currency, availability, link, image, labels, attrs, removed_at')
      .eq('feed_id', feedId).order('item_id').range(from, from + 999)
    if (error) throw error
    for (const r of data ?? []) m.set(r.item_id, { ...r, price: r.price == null ? null : Number(r.price), sale_price: r.sale_price == null ? null : Number(r.sale_price) } as Stored)
    if (!data || data.length < 1000) break
  }
  return m
}

async function inBatches<T>(rows: T[], size: number, fn: (b: T[]) => Promise<{ error: unknown }>) {
  for (let i = 0; i < rows.length; i += size) {
    const { error } = await fn(rows.slice(i, i + size))
    if (error) throw error
  }
}

async function syncFeed(feed: { id: string; url: string; last_hash: string | null; settings?: { category_field?: string } | null }) {
  const started = Date.now()
  const now = new Date().toISOString()
  const snap: Record<string, unknown> = { feed_id: feed.id, checked_at: now }
  try {
    const r = await fetch(feed.url, { signal: AbortSignal.timeout(90000), headers: { 'User-Agent': 'Loft19-Brain-FeedMonitor/1.0' } })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const text = await r.text()
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map((b) => b.toString(16).padStart(2, '0')).join('')
    const items = toItems(parseDelimited(text.replace(/^\uFEFF/, '')), feed.settings?.category_field)
    if (!items.length) throw new Error('Feed nema nijedan proizvod (ili nema kolonu id)')
    const onSale = items.filter((i) => i.sale_price != null)
    Object.assign(snap, {
      bytes: text.length, items: items.length, on_sale: onSale.length,
      avg_discount_pct: onSale.length ? Math.round(onSale.reduce((s, i) => s + (1 - i.sale_price! / i.price!) * 100, 0) / onSale.length * 10) / 10 : null,
    })

    if (hash === feed.last_hash) {
      // Same file as last time: only last_seen moves.
      await sb.from('feed_snapshots').insert({ ...snap, status: 'nepromenjen', new_items: 0, removed_items: 0, back_items: 0, price_changes: 0, sale_changes: 0, other_changes: 0, duration_ms: Date.now() - started })
      await sb.from('product_feeds').update({ last_checked_at: now, last_status: 'nepromenjen', last_error: null }).eq('id', feed.id)
      return { feed_id: feed.id, status: 'nepromenjen', items: items.length }
    }

    const stored = await storedItems(feed.id)
    const active = [...stored.values()].filter((s) => !s.removed_at)
    const baseline = stored.size === 0
    const suspicious = !baseline && items.length < active.length * 0.5
    const changes: { feed_id: string; item_id: string; changed_at: string; kind: string; old_value: string | null; new_value: string | null }[] = []
    const add = (item_id: string, kind: string, old_value: string | null, new_value: string | null) =>
      changes.push({ feed_id: feed.id, item_id, changed_at: now, kind, old_value, new_value })
    // New and existing products go in separate batches: a mixed batch would send first_seen_at as null.
    const inserts: Record<string, unknown>[] = []
    const upserts: Record<string, unknown>[] = []
    const seen = new Set<string>()

    for (const it of items) {
      seen.add(it.item_id)
      const old = stored.get(it.item_id)
      const row = { feed_id: feed.id, ...it, last_seen_at: now, removed_at: null, updated_at: now }
      if (!old) {
        if (!baseline) add(it.item_id, 'new', null, fmt(eff(it)))
        inserts.push({ ...row, first_seen_at: now })
        continue
      }
      let changed = !!old.removed_at
      if (old.removed_at) add(it.item_id, 'back', null, fmt(eff(it)))
      // A sale starting or ending is recorded as such, not also as a price change.
      const oe = eff(old), ne = eff(it)
      if ((old.sale_price == null) !== (it.sale_price == null)) {
        add(it.item_id, it.sale_price != null ? 'sale_start' : 'sale_end', fmt(oe), fmt(ne)); changed = true
      } else if (oe != null && ne != null && Math.abs(oe - ne) >= 0.01) { add(it.item_id, ne > oe ? 'price_up' : 'price_down', fmt(oe), fmt(ne)); changed = true }
      if (old.price !== it.price || old.sale_price !== it.sale_price) changed = true
      if ((old.title ?? '') !== (it.title ?? '')) { add(it.item_id, 'title', old.title, it.title); changed = true }
      if ((old.availability ?? '') !== (it.availability ?? '')) { add(it.item_id, 'availability', old.availability, it.availability); changed = true }
      for (const l of LABELS) {
        const a = old.labels?.[l] ?? '', b = it.labels[l] ?? ''
        if (a !== b) { add(it.item_id, 'label', `${l}: ${a}`, `${l}: ${b}`); changed = true }
      }
      if (changed || old.link !== it.link || old.image !== it.image || old.group_id !== it.group_id || old.category !== it.category || old.brand !== it.brand || JSON.stringify(old.attrs ?? {}) !== JSON.stringify(it.attrs)) upserts.push(row)
    }

    const gone = suspicious ? [] : active.filter((s) => !seen.has(s.item_id))
    for (const g of gone) add(g.item_id, 'removed', fmt(eff(g)), null)

    await inBatches(inserts, 500, (b) => sb.from('feed_items').insert(b))
    await inBatches(upserts, 500, (b) => sb.from('feed_items').upsert(b, { onConflict: 'feed_id,item_id' }))
    await inBatches(gone.map((g) => g.item_id), 300, (b) => sb.from('feed_items').update({ removed_at: now, updated_at: now }).eq('feed_id', feed.id).in('item_id', b))
    // Products present but unchanged: last_seen only (one statement for the whole feed).
    await sb.from('feed_items').update({ last_seen_at: now }).eq('feed_id', feed.id).is('removed_at', null)
    await inBatches(changes, 1000, (b) => sb.from('feed_changes').insert(b))

    const count = (k: string[]) => changes.filter((c) => k.includes(c.kind)).length
    const status = baseline ? 'osnova' : suspicious ? 'sumnjiv' : 'ok'
    await sb.from('feed_snapshots').insert({
      ...snap, status, new_items: count(['new']), removed_items: count(['removed']), back_items: count(['back']),
      price_changes: count(['price_up', 'price_down']), sale_changes: count(['sale_start', 'sale_end']), other_changes: count(['title', 'label', 'availability']),
      duration_ms: Date.now() - started,
      error: suspicious ? `Feed ima ${items.length} proizvoda, a prošli put ${active.length}; nestali proizvodi nisu označeni.` : null,
    })
    // A suspicious file is not remembered, so the next check compares against the last good one.
    await sb.from('product_feeds').update({ last_checked_at: now, last_status: status, last_error: null, ...(suspicious ? {} : { last_hash: hash }) }).eq('id', feed.id)
    return { feed_id: feed.id, status, items: items.length, changes: changes.length }
  } catch (e) {
    const msg = (e as Error).message
    await sb.from('feed_snapshots').insert({ ...snap, status: 'greska', error: msg, duration_ms: Date.now() - started })
    await sb.from('product_feeds').update({ last_checked_at: now, last_status: 'greska', last_error: msg }).eq('id', feed.id)
    return { feed_id: feed.id, status: 'greska', error: msg }
  }
}

Deno.serve(async (req: Request) => {
  try {
    const { feed_id } = await req.json().catch(() => ({}))
    if (!feed_id) return json({ error: 'feed_id je obavezan' }, 400)
    const { data: feed, error } = await sb.from('product_feeds').select('id, url, last_hash, enabled, settings').eq('id', feed_id).maybeSingle()
    if (error) throw error
    if (!feed) return json({ error: 'Feed nije pronađen' }, 404)
    const res = await syncFeed(feed)
    // Today's per-segment state (category, price band, discount...) for the trend view.
    if (res.status !== 'greska') {
      const { error: se } = await sb.rpc('feed_segment_snapshot', { p_feed_id: feed.id })
      if (se) console.error('feed_segment_snapshot', se.message)
    }
    return json({ ok: res.status !== 'greska', ...res }, res.status === 'greska' ? 502 : 200)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
