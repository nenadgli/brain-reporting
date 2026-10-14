import { createClient } from 'jsr:@supabase/supabase-js@2'

// Weekly: where Display, Demand Gen and YouTube ads ran in the last 30 days (Google Ads placement
// report), summed per campaign and placement, for the "Placement optimizacija" task. Read-only
// against Windsor. Performance Max placements are not reported by Google.

const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json' } })

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
      const params = new URLSearchParams({
        api_key: WINDSOR_API_KEY, select_accounts: account, date_preset,
        fields: 'campaign,group_placement_view_placement,group_placement_view_display_name,group_placement_view_placement_type,impressions,clicks,spend,conversions,conversion_value',
      })
      const r = await fetch(`https://connectors.windsor.ai/google_ads?${params}`, { signal: AbortSignal.timeout(120000) })
      if (!r.ok) throw new Error(`Windsor google_ads HTTP ${r.status}`)
      const rows = ((await r.json()).data ?? []) as Record<string, unknown>[]

      // Windsor may still split by date; sum per campaign and placement either way.
      const agg = new Map<string, Record<string, unknown> & { impressions: number; clicks: number; spend: number; conversions: number; conversion_value: number }>()
      for (const x of rows) {
        const placement = String(x.group_placement_view_placement ?? '')
        if (!placement) continue
        const k = `${x.campaign}|${placement}`
        const a = agg.get(k) ?? {
          client_id, data_source_id: s.id, snapshot_date: today, period: date_preset, campaign: String(x.campaign ?? ''), placement,
          display_name: (x.group_placement_view_display_name as string) ?? null, placement_type: (x.group_placement_view_placement_type as string) ?? null,
          impressions: 0, clicks: 0, spend: 0, conversions: 0, conversion_value: 0,
        }
        a.impressions += Number(x.impressions) || 0
        a.clicks += Number(x.clicks) || 0
        a.spend += Number(x.spend) || 0
        a.conversions += Number(x.conversions) || 0
        a.conversion_value += Number(x.conversion_value) || 0
        agg.set(k, a)
      }
      // Only placements that cost something are worth a decision.
      const keep = [...agg.values()].filter((a) => a.spend > 0).map((a) => ({ ...a, spend: Math.round(a.spend * 100) / 100 }))
      for (let i = 0; i < keep.length; i += 1000) {
        const { error: e } = await supabase.from('google_placements').upsert(keep.slice(i, i + 1000), { onConflict: 'client_id,snapshot_date,campaign,placement' })
        if (e) throw e
      }
      out.push({ account, rows: rows.length, placements: keep.length })
    }
    return json({ ok: true, results: out })
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
