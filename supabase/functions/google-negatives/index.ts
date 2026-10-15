import { createClient } from 'jsr:@supabase/supabase-js@2'

// Campaign-level negative keywords and shared negative lists of a client's Google Ads campaigns (Windsor), so a new
// campaign can start with the same ones as an existing campaign (own brand, competitors, "polovno" lists).
// Read only. Only agency users may call it.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const WINDSOR_API_KEY = Deno.env.get('WINDSOR_API_KEY')!
const sb = createClient(SUPABASE_URL, SERVICE)

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-internal-key',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// Editor's match type names.
const MATCH: Record<string, string> = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad', '2': 'Exact', '3': 'Phrase', '4': 'Broad' }
const truthy = (v: unknown) => v === true || v === 'true' || v === 'True' || v === 1 || v === '1'

// deno-lint-ignore no-explicit-any
async function windsor(account: string, fields: string): Promise<any[]> {
  const to = new Date()
  const from = new Date(to.getTime() - 7 * 864e5)
  const params = new URLSearchParams({ api_key: WINDSOR_API_KEY, select_accounts: account, fields, date_from: from.toISOString().slice(0, 10), date_to: to.toISOString().slice(0, 10) })
  const r = await fetch(`https://connectors.windsor.ai/google_ads?${params}`, { signal: AbortSignal.timeout(120000) })
  if (!r.ok) throw new Error(`Windsor HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`)
  return (await r.json()).data ?? []
}

async function negatives(clientId: string) {
  const { data: sources, error } = await sb.from('data_sources').select('windsor_connection_id').eq('client_id', clientId).eq('provider', 'google_ads').not('windsor_connection_id', 'is', null)
  if (error) throw error
  if (!sources?.length) return { error: 'Klijent nema Google Ads nalog u Windsoru' }
  const account = String(sources[0].windsor_connection_id).split('__').pop()!
  const [crit, shared] = await Promise.all([
    windsor(account, 'campaign,campaign_status,campaign_criterion_keyword_text,campaign_criterion_keyword_match_type,campaign_criterion_negative,campaign_criterion_status'),
    windsor(account, 'campaign,campaign_shared_set_shared_set,campaign_shared_set_status,shared_set_name,shared_set_type').catch(() => []),
  ])
  const camps = new Map<string, { campaign: string; status: string | null; negatives: Map<string, { keyword: string; match_type: string }>; shared_sets: Set<string> }>()
  const get = (name: string, status: string | null) => {
    if (!camps.has(name)) camps.set(name, { campaign: name, status, negatives: new Map(), shared_sets: new Set() })
    return camps.get(name)!
  }
  for (const x of crit) {
    if (!x.campaign) continue
    const c = get(String(x.campaign), x.campaign_status ?? null)
    const text = String(x.campaign_criterion_keyword_text ?? '').trim()
    if (!text || !truthy(x.campaign_criterion_negative) || /REMOVED/i.test(String(x.campaign_criterion_status ?? ''))) continue
    const match = MATCH[String(x.campaign_criterion_keyword_match_type ?? '').toUpperCase()] ?? 'Phrase'
    c.negatives.set(`${match}|${text.toLowerCase()}`, { keyword: text, match_type: match })
  }
  for (const x of shared) {
    if (!x.campaign || !x.shared_set_name || /REMOVED/i.test(String(x.campaign_shared_set_status ?? ''))) continue
    if (x.shared_set_type && !/NEGATIVE_KEYWORDS/i.test(String(x.shared_set_type))) continue
    get(String(x.campaign), null).shared_sets.add(String(x.shared_set_name))
  }
  const campaigns = [...camps.values()]
    .filter((c) => c.negatives.size || c.shared_sets.size)
    .map((c) => ({ campaign: c.campaign, status: c.status, negatives: [...c.negatives.values()].sort((a, b) => a.keyword.localeCompare(b.keyword)), shared_sets: [...c.shared_sets] }))
    .sort((a, b) => b.negatives.length - a.negatives.length)
  return { account, campaigns }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const internal = req.headers.get('x-internal-key')
    if (internal) {
      const { data: secret } = await sb.from('integration_secrets').select('value').eq('name', 'feedhub_briefs_key').maybeSingle()
      if (!secret || internal !== secret.value) return json({ error: 'Pogrešan interni ključ' }, 403)
    } else {
      const jwt = (req.headers.get('Authorization') ?? '').replace('Bearer ', '')
      const { data: u, error: ue } = await sb.auth.getUser(jwt)
      if (ue || !u?.user) return json({ error: 'Niste ulogovani' }, 401)
      const { data: au } = await sb.from('app_users').select('agency_id, client_id').eq('id', u.user.id).maybeSingle()
      if (!au?.agency_id || au.client_id) return json({ error: 'Samo korisnici agencije' }, 403)
    }
    const body = await req.json().catch(() => ({}))
    if (!body.client_id) return json({ error: 'client_id je obavezan' }, 400)
    const out = await negatives(String(body.client_id))
    return json(out, 'error' in out ? 404 : 200)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
