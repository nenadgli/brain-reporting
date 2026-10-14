import { createClient } from 'jsr:@supabase/supabase-js@2'

const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function dateParams(body: { date_preset?: string; date_from?: string; date_to?: string }) {
  if (body.date_from && body.date_to) return { date_from: body.date_from, date_to: body.date_to }
  return { date_preset: body.date_preset ?? 'last_14d' }
}

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}))
    const { client_id } = body
    if (!client_id) return new Response(JSON.stringify({ error: 'client_id je obavezan' }), { status: 400, headers: { 'Content-Type': 'application/json' } })

    const { data: sources, error: sourcesError } = await supabase
      .from('data_sources').select('id, windsor_connection_id')
      .eq('client_id', client_id).eq('provider', 'google_ads').not('windsor_connection_id', 'is', null)
    if (sourcesError) throw sourcesError
    if (!sources || sources.length === 0) return new Response(JSON.stringify({ error: 'Nema Google Ads konekcije' }), { status: 404, headers: { 'Content-Type': 'application/json' } })

    const results = []
    for (const source of sources) {
      const rawAccountId = source.windsor_connection_id.includes('__') ? source.windsor_connection_id.split('__')[1] : source.windsor_connection_id
      const params = new URLSearchParams({
        ...dateParams(body), api_key: WINDSOR_API_KEY, select_accounts: rawAccountId,
        fields: 'date,campaign,auction_insight_domain',
      })
      const res = await fetch(`https://connectors.windsor.ai/google_ads?${params.toString()}`)
      if (!res.ok) { results.push({ source: source.windsor_connection_id, error: `HTTP ${res.status}` }); continue }
      const json = await res.json()
      const rows = (json.data ?? []).filter((r: Record<string, unknown>) => r.auction_insight_domain && String(r.auction_insight_domain).trim() !== '')
      const metricRows = rows.map((r: Record<string, unknown>) => ({
        client_id, data_source_id: source.id, report_date: r.date, campaign: r.campaign, domain: r.auction_insight_domain,
      }))
      if (metricRows.length > 0) {
        const dates = [...new Set(rows.map((r: Record<string, unknown>) => r.date))]
        await supabase.from('google_ads_competitors').delete().eq('data_source_id', source.id).in('report_date', dates)
        for (let i = 0; i < metricRows.length; i += 500) {
          await supabase.from('google_ads_competitors').insert(metricRows.slice(i, i + 500))
        }
      }
      results.push({ source: source.windsor_connection_id, rows: metricRows.length })
    }
    return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
