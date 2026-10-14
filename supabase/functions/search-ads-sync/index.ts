import { createClient } from 'jsr:@supabase/supabase-js@2'

// Weekly: every responsive search ad with its headlines and descriptions, Google's performance label
// per asset (BEST/GOOD/LOW/LEARNING/PENDING), pins, Ad Strength and the last 30 days' results, for the
// quarterly "Osvežavanje Search oglasa" task. Read-only against Windsor.

const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

const FIELDS = 'campaign,ad_group_name,ad_id,ad_type,ad_group_ad_status,ad_strength,ad_responsive_search_ad_headlines,' +
  'ad_responsive_search_ad_descriptions,ad_responsive_search_ad_path1,ad_responsive_search_ad_path2,ad_final_urls,' +
  'impressions,clicks,spend,conversions,conversion_value'

// Windsor returns the assets as a JSON string: [{text, assetPerformanceLabel, pinnedField?, policySummaryInfo}].
// Pins come as HEADLINE_1..3 / DESCRIPTION_1..2; only the position number is kept.
function assets(v: unknown): { text: string; label: string | null; pin: number | null }[] {
  let list: unknown = v
  if (typeof v === 'string') { try { list = JSON.parse(v) } catch { return [] } }
  if (!Array.isArray(list)) return []
  return list.filter((a) => a && typeof a.text === 'string').map((a) => ({
    text: a.text as string,
    label: (a.assetPerformanceLabel as string) ?? null,
    pin: a.pinnedField ? Number(String(a.pinnedField).match(/(\d+)$/)?.[1]) || null : null,
  }))
}
function firstUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null
  try { const a = JSON.parse(v); return Array.isArray(a) ? (a[0] ?? null) : v } catch { return v }
}

Deno.serve(async (req: Request) => {
  try {
    const { client_id, date_preset = 'last_30d' } = await req.json().catch(() => ({}))
    if (!client_id) return json({ error: 'client_id je obavezan' }, 400)
    const { data: sources, error } = await supabase.from('data_sources').select('id, windsor_connection_id')
      .eq('client_id', client_id).eq('provider', 'google_ads').not('windsor_connection_id', 'is', null)
    if (error) throw error
    const today = new Date().toISOString().slice(0, 10)
    const out: Record<string, unknown>[] = []

    for (const s of sources ?? []) {
      const account = s.windsor_connection_id.includes('__') ? s.windsor_connection_id.split('__')[1] : s.windsor_connection_id
      const params = new URLSearchParams({ api_key: WINDSOR_API_KEY, select_accounts: account, date_preset, fields: FIELDS })
      const r = await fetch(`https://connectors.windsor.ai/google_ads?${params}`, { signal: AbortSignal.timeout(120000) })
      if (!r.ok) throw new Error(`Windsor google_ads HTTP ${r.status}`)
      const rows = ((await r.json()).data ?? []) as Record<string, unknown>[]

      // One row per ad; results summed in case Windsor splits the period.
      const ads = new Map<string, Record<string, unknown> & { impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }>()
      for (const x of rows) {
        if (x.ad_type !== 'RESPONSIVE_SEARCH_AD' || x.ad_id == null) continue
        const id = String(x.ad_id)
        const a = ads.get(id) ?? {
          client_id, data_source_id: s.id, snapshot_date: today, ad_id: id,
          campaign: String(x.campaign ?? ''), ad_group: (x.ad_group_name as string) ?? null,
          ad_status: (x.ad_group_ad_status as string) ?? null, ad_strength: (x.ad_strength as string) ?? null,
          headlines: assets(x.ad_responsive_search_ad_headlines), descriptions: assets(x.ad_responsive_search_ad_descriptions),
          path1: (x.ad_responsive_search_ad_path1 as string) || null, path2: (x.ad_responsive_search_ad_path2 as string) || null,
          final_url: firstUrl(x.ad_final_urls),
          impressions: 0, clicks: 0, spend: 0, conversions: 0, conversion_value: 0,
        }
        a.impressions += num(x.impressions); a.clicks += num(x.clicks); a.spend += num(x.spend)
        a.conversions += num(x.conversions); a.conversion_value += num(x.conversion_value)
        ads.set(id, a)
      }
      const list = [...ads.values()]
      for (let i = 0; i < list.length; i += 300) {
        const { error: e } = await supabase.from('google_search_ads').upsert(list.slice(i, i + 300), { onConflict: 'client_id,snapshot_date,ad_id' })
        if (e) throw e
      }
      out.push({ source: s.windsor_connection_id, ads: list.length })
    }
    return json({ ok: true, results: out })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
