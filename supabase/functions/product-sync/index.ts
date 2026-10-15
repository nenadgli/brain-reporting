import { createClient } from 'jsr:@supabase/supabase-js@2'

// Podaci po proizvodu, per day, for the markets a client has a product feed for:
// - GA4 items: views, add to cart, purchases, revenue (by country);
// - Google Ads products (Shopping and PMax): impressions, clicks, cost, conversions, value (by the
//   product's target country);
// - Meta catalog ads per product: impressions, clicks, cost, purchases, purchase value. Meta returns the
//   product as "ID, title" with the title in the market's language; a row belongs to the feed whose
//   product has that id and title.
// The requested period is replaced as a whole, so a re-run never double counts. Read-only against Windsor.

const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

// Feed market -> GA4 country name and Google Ads geo target id.
const MARKETS: Record<string, { ga4: string; geo: string }> = {
  DE: { ga4: 'Germany', geo: '2276' }, AT: { ga4: 'Austria', geo: '2040' }, CH: { ga4: 'Switzerland', geo: '2756' },
  IT: { ga4: 'Italy', geo: '2380' }, UK: { ga4: 'United Kingdom', geo: '2826' }, GB: { ga4: 'United Kingdom', geo: '2826' },
  FR: { ga4: 'France', geo: '2250' }, NL: { ga4: 'Netherlands', geo: '2528' }, BE: { ga4: 'Belgium', geo: '2056' },
  ES: { ga4: 'Spain', geo: '2724' }, PL: { ga4: 'Poland', geo: '2616' }, RS: { ga4: 'Serbia', geo: '2688' },
  HR: { ga4: 'Croatia', geo: '2191' }, BA: { ga4: 'Bosnia & Herzegovina', geo: '2070' }, ME: { ga4: 'Montenegro', geo: '2499' },
  SI: { ga4: 'Slovenia', geo: '2705' }, AL: { ga4: 'Albania', geo: '2008' }, MK: { ga4: 'North Macedonia', geo: '2807' },
}

async function windsor(connector: string, account: string, fields: string, from: string, to: string) {
  const params = new URLSearchParams({ api_key: WINDSOR_API_KEY, select_accounts: account, fields, date_from: from, date_to: to })
  const r = await fetch(`https://connectors.windsor.ai/${connector}?${params}`, { signal: AbortSignal.timeout(120000) })
  if (!r.ok) throw new Error(`Windsor ${connector} HTTP ${r.status}`)
  return ((await r.json()).data ?? []) as Record<string, unknown>[]
}
const accountOf = (id: string) => (id.includes('__') ? id.split('__')[1] : id)

type Row = {
  client_id: string; source: 'ga4' | 'google_ads' | 'meta'; report_date: string; market: string; item_id: string; campaign_type: string
  views: number; add_to_cart: number; purchases: number; revenue: number
  impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number
}

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}))
    const clientId = String(body.client_id ?? '')
    const today = new Date().toISOString().slice(0, 10)
    const from = String(body.date_from ?? new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10))
    const to = String(body.date_to ?? new Date(Date.now() - 864e5).toISOString().slice(0, 10))
    if (!clientId || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || to > today) return json({ error: 'client_id, date_from i date_to su obavezni' }, 400)

    const { data: feeds } = await sb.from('product_feeds').select('market').eq('client_id', clientId).eq('enabled', true)
    const markets = [...new Set((feeds ?? []).map((f) => String(f.market).toUpperCase()))].filter((m) => MARKETS[m])
    if (!markets.length) return json({ error: 'Klijent nema feed za poznato tržište' }, 400)
    const byCountry = new Map(markets.map((m) => [MARKETS[m].ga4, m]))
    const byGeo = new Map(markets.map((m) => [`geoTargetConstants/${MARKETS[m].geo}`, m]))

    const { data: sources } = await sb.from('data_sources').select('provider, windsor_connection_id')
      .eq('client_id', clientId).in('provider', ['ga4', 'google_ads', 'facebook']).not('windsor_connection_id', 'is', null)
    const out: Record<string, unknown> = { from, to, markets }
    const rows = new Map<string, Row>()
    const blank = (source: Row['source'], d: string, market: string, item: string, ct: string): Row => ({
      client_id: clientId, source, report_date: d, market, item_id: item, campaign_type: ct,
      views: 0, add_to_cart: 0, purchases: 0, revenue: 0, impressions: 0, clicks: 0, spend: 0, conversions: 0, conversion_value: 0,
    })
    const pulled = new Set<string>()

    for (const s of sources ?? []) {
      const account = accountOf(s.windsor_connection_id)
      if (s.provider === 'ga4') {
        const data = await windsor('googleanalytics4', account, 'date,country,item_id,items_viewed,items_added_to_cart,items_purchased,item_revenue', from, to)
        let n = 0
        for (const x of data) {
          const market = byCountry.get(String(x.country ?? ''))
          const item = String(x.item_id ?? '').trim().toUpperCase()
          if (!market || !item || item === '(NOT SET)' || !x.date) continue
          const k = `ga4|${x.date}|${market}|${item}|`
          const r = rows.get(k) ?? blank('ga4', String(x.date), market, item, '')
          r.views += num(x.items_viewed); r.add_to_cart += num(x.items_added_to_cart); r.purchases += num(x.items_purchased); r.revenue += num(x.item_revenue)
          rows.set(k, r); n++
        }
        out.ga4 = { rows: data.length, kept: n }
        pulled.add('ga4')
      } else if (s.provider === 'facebook') {
        // id|title (lower case) -> market, from the client's feeds.
        const titles = new Map<string, string>()
        const { data: fs } = await sb.from('product_feeds').select('id, market').eq('client_id', clientId).eq('enabled', true)
        for (const f of fs ?? []) {
          for (let off = 0; ; off += 1000) {
            const { data: its } = await sb.from('feed_items').select('item_id, title').eq('feed_id', f.id).order('item_id').range(off, off + 999)
            for (const it of its ?? []) if (it.title) titles.set(`${it.item_id}|${String(it.title).trim().toLowerCase()}`, String(f.market).toUpperCase())
            if (!its || its.length < 1000) break
          }
        }
        const data = await windsor('facebook', account, 'date,product_id,spend,impressions,clicks,actions_purchase,action_values_purchase', from, to)
        let n = 0
        for (const x of data) {
          const raw = String(x.product_id ?? '')
          const cut = raw.indexOf(', ')
          if (cut < 0 || !x.date) continue
          const item = raw.slice(0, cut).trim().toUpperCase()
          const market = titles.get(`${item}|${raw.slice(cut + 2).trim().toLowerCase()}`)
          if (!market || !markets.includes(market)) continue
          const k = `meta|${x.date}|${market}|${item}|`
          const r = rows.get(k) ?? blank('meta', String(x.date), market, item, '')
          r.impressions += num(x.impressions); r.clicks += num(x.clicks); r.spend += num(x.spend)
          r.conversions += num(x.actions_purchase); r.conversion_value += num(x.action_values_purchase)
          rows.set(k, r); n++
        }
        out.meta = { rows: data.length, kept: n }
        pulled.add('meta')
      } else {
        const data = await windsor('google_ads', account, 'date,campaign_type,product_country,product_item_id,impressions,clicks,spend,conversions,conversion_value', from, to)
        let n = 0
        for (const x of data) {
          const market = byGeo.get(String(x.product_country ?? ''))
          const item = String(x.product_item_id ?? '').trim().toUpperCase()
          if (!market || !item || !x.date) continue
          const ct = String(x.campaign_type ?? '')
          const k = `google_ads|${x.date}|${market}|${item}|${ct}`
          const r = rows.get(k) ?? blank('google_ads', String(x.date), market, item, ct)
          r.impressions += num(x.impressions); r.clicks += num(x.clicks); r.spend += num(x.spend)
          r.conversions += num(x.conversions); r.conversion_value += num(x.conversion_value)
          rows.set(k, r); n++
        }
        out.google_ads = { rows: data.length, kept: n }
        pulled.add('google_ads')
      }
    }

    // Replace the period for each source that was pulled.
    for (const src of pulled) {
      const { error } = await sb.from('product_daily').delete().eq('client_id', clientId).eq('source', src).in('market', markets).gte('report_date', from).lte('report_date', to)
      if (error) throw error
    }
    const list = [...rows.values()].map((r) => ({ ...r, revenue: Math.round(r.revenue * 100) / 100, spend: Math.round(r.spend * 100) / 100, conversion_value: Math.round(r.conversion_value * 100) / 100 }))
    for (let i = 0; i < list.length; i += 1000) {
      const { error } = await sb.from('product_daily').insert(list.slice(i, i + 1000))
      if (error) throw error
    }
    return json({ ok: true, ...out, stored: list.length })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
