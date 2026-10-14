import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function callFn(name: string, body: Record<string, unknown>) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({ error: 'invalid json response' }))
  return { fn: name, client_id: body.client_id, status: res.status, ok: res.ok, result: json }
}

Deno.serve(async (req: Request) => {
  try {
    const { date_preset = 'last_14d' } = await req.json().catch(() => ({}))

    const { data: sources, error } = await supabase.from('data_sources').select('client_id, provider')
    if (error) throw error

    // GA4 property is shared across markets; each client reads its own market via customevent_store (clients.ga4_store)
    const { data: clientRows, error: clientsError } = await supabase.from('clients').select('id, ga4_store')
    if (clientsError) throw clientsError
    const storeByClient = new Map<string, string>()
    for (const c of clientRows ?? []) if (c.ga4_store) storeByClient.set(c.id, c.ga4_store)

    const clientProviders = new Map<string, Set<string>>()
    for (const s of sources ?? []) {
      if (!clientProviders.has(s.client_id)) clientProviders.set(s.client_id, new Set())
      clientProviders.get(s.client_id)!.add(s.provider)
    }

    const jobs: Promise<unknown>[] = []
    for (const [clientId, providers] of clientProviders) {
      jobs.push(callFn('windsor-sync', { client_id: clientId, date_preset: 'last_7d' }))

      if (providers.has('google_ads')) {
        jobs.push(callFn('google-ads-sync', { client_id: clientId, date_preset }))
        jobs.push(callFn('google-ads-keywords-sync', { client_id: clientId, date_preset }))
        jobs.push(callFn('google-ads-search-terms-sync', { client_id: clientId, date_preset }))
        jobs.push(callFn('google-ads-competitors-sync', { client_id: clientId, date_preset }))
        jobs.push(callFn('google-granular-sync', { client_id: clientId, date_preset }))
      }
      if (providers.has('facebook')) {
        jobs.push(callFn('facebook-ads-sync', { client_id: clientId, date_preset }))
        jobs.push(callFn('facebook-ads-placements-sync', { client_id: clientId, date_preset }))
        jobs.push(callFn('facebook-ads-creatives-sync', { client_id: clientId, date_preset }))
        jobs.push(callFn('meta-adset-sync', { client_id: clientId, date_preset }))
      }
      if (providers.has('ga4')) {
        const store = storeByClient.get(clientId)
        if (store) {
          jobs.push(callFn('ga4-sync', { client_id: clientId, date_preset, store }))
        } else {
          console.warn(`ga4-sync skipped for ${clientId}: clients.ga4_store is not set`)
        }
      }
    }

    const settled = await Promise.allSettled(jobs)
    const results = settled.map((s) => (s.status === 'fulfilled' ? s.value : { error: String(s.reason) }))
    const failures = results.filter((r: unknown) => {
      const rr = r as { ok?: boolean; error?: unknown }
      return rr.ok === false || rr.error
    })

    return new Response(JSON.stringify({ ok: true, total_jobs: jobs.length, failures: failures.length, results }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
