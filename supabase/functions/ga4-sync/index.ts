import { createClient } from 'jsr:@supabase/supabase-js@2'

const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function clean(s: unknown): string | null {
  if (s == null) return null
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
}

function dateParams(body: { date_preset?: string; date_from?: string; date_to?: string }) {
  if (body.date_from && body.date_to) return { date_from: body.date_from, date_to: body.date_to }
  return { date_preset: body.date_preset ?? 'last_14d' }
}

Deno.serve(async (req: Request) => {
  try {
    const body = await req.json().catch(() => ({}))
    const { client_id, store = 'RS' } = body
    // store === '*' -> property has no customevent_store dimension; take all rows unfiltered
    const noStore = store === '*'
    if (!client_id) return new Response(JSON.stringify({ error: 'client_id je obavezan' }), { status: 400, headers: { 'Content-Type': 'application/json' } })

    const { data: sources, error: sourcesError } = await supabase
      .from('data_sources').select('id, windsor_connection_id')
      .eq('client_id', client_id).eq('provider', 'ga4').not('windsor_connection_id', 'is', null)
    if (sourcesError) throw sourcesError
    if (!sources || sources.length === 0) return new Response(JSON.stringify({ error: 'Nema GA4 konekcije za ovog klijenta' }), { status: 404, headers: { 'Content-Type': 'application/json' } })

    const results = []
    for (const source of sources) {
      const rawAccountId = source.windsor_connection_id.includes('__') ? source.windsor_connection_id.split('__')[1] : source.windsor_connection_id
      const baseFields = 'date,source,medium,campaign,' + (noStore ? '' : 'customevent_store,') + 'sessions,totalusers,newusers,engaged_sessions,engagement_rate,bounce_rate,conversions,totalrevenue'
      const fetchGa4 = (fields: string) => fetch(`https://connectors.windsor.ai/googleanalytics4?${new URLSearchParams({
        ...dateParams(body), api_key: WINDSOR_API_KEY, select_accounts: rawAccountId, fields,
      }).toString()}`)
      // transactions = GA4 purchases (the PPC team's conversion definition); fall back if the property rejects it
      let res = await fetchGa4(baseFields + ',transactions')
      if (!res.ok) res = await fetchGa4(baseFields)
      if (!res.ok) { results.push({ source: source.windsor_connection_id, error: `HTTP ${res.status}` }); continue }
      const json = await res.json()
      const allRows = json.data ?? []
      const rows = noStore ? allRows : allRows.filter((r: Record<string, unknown>) => r.customevent_store === store)

      await supabase.from('data_sources').update({ status: 'active', last_synced_at: new Date().toISOString() }).eq('id', source.id)

      const metricRows = rows.map((r: Record<string, unknown>) => ({
        client_id, data_source_id: source.id, report_date: r.date, source: clean(r.source), medium: clean(r.medium), campaign: clean(r.campaign),
        store: noStore ? null : clean(r.customevent_store), sessions: r.sessions ?? 0, total_users: r.totalusers ?? 0, new_users: r.newusers ?? 0,
        engaged_sessions: r.engaged_sessions ?? 0, engagement_rate: r.engagement_rate, bounce_rate: r.bounce_rate,
        conversions: r.conversions ?? 0, total_revenue: r.totalrevenue ?? 0,
        transactions: r.transactions ?? null,
      }))
      let insertedCount = 0
      let lastError: string | null = null
      if (metricRows.length > 0) {
        const dates = [...new Set(rows.map((r: Record<string, unknown>) => r.date))]
        await supabase.from('ga4_metrics').delete().eq('data_source_id', source.id).in('report_date', dates)
        for (let i = 0; i < metricRows.length; i += 500) {
          const insRes = await supabase.from('ga4_metrics').insert(metricRows.slice(i, i + 500))
          if (insRes.error) { lastError = insRes.error.message; break }
          insertedCount += metricRows.slice(i, i + 500).length
        }
      }
      results.push({ source: source.windsor_connection_id, rows: metricRows.length, inserted: insertedCount, filtered_out: allRows.length - rows.length, error: lastError })
    }
    return new Response(JSON.stringify({ ok: true, results }), { headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
