import { createClient } from 'jsr:@supabase/supabase-js@2'

// Responsive display ad drafts → Google Ads Editor CSV. An ad_group draft adds a Paused ad group with
// one responsive display ad to an existing Display campaign; a campaign draft also creates the Paused
// campaign (daily budget, flight dates, location, language). Images travel in the images/ folder of
// the package and are added in Editor by hand, as for PMax.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (obj: unknown, status: number) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// NOTE: campaign and status columns follow Editor's PMax export; the ad type value and ad columns
// are not yet checked against an Editor export of a responsive display ad.
const HEADLINES = Array.from({ length: 5 }, (_, i) => `Headline ${i + 1}`)
const DESCRIPTIONS = Array.from({ length: 5 }, (_, i) => `Description ${i + 1}`)
const VIDEOS = Array.from({ length: 5 }, (_, i) => `Video ID ${i + 1}`)
const HEADER = [
  'Campaign', 'Campaign Type', 'Networks', 'Budget', 'Budget type', 'Bid Strategy Type', 'Start Date', 'End Date', 'Languages', 'Location',
  'Ad Group', 'Ad type', ...HEADLINES, 'Long headline', ...DESCRIPTIONS, 'Business name', 'Call to action', ...VIDEOS, 'Final URL',
  'Campaign Status', 'Ad Group Status', 'Status',
]

function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// deno-lint-ignore no-explicit-any
function rowsFor(d: any): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  if (d.mode === 'campaign') {
    rows.push({
      Campaign: d.campaign_name, 'Campaign Type': 'Display', Networks: 'Display Network', Budget: d.daily_budget, 'Budget type': 'Daily',
      'Bid Strategy Type': 'Maximize conversions', 'Start Date': d.start_date, 'End Date': d.end_date, Languages: (d.languages ?? []).join(';'),
      'Campaign Status': 'Paused',
    })
    for (const loc of d.locations ?? []) rows.push({ Campaign: d.campaign_name, Location: loc })
  }
  rows.push({ Campaign: d.campaign_name, 'Ad Group': d.ad_group_name, 'Ad Group Status': 'Paused' })
  const ad: Record<string, unknown> = {
    Campaign: d.campaign_name, 'Ad Group': d.ad_group_name, 'Ad type': 'Responsive display ad', Status: 'Paused',
    'Long headline': d.long_headline, 'Business name': d.business_name, 'Call to action': d.call_to_action, 'Final URL': d.final_url,
  }
  ;(d.headlines ?? []).slice(0, 5).forEach((v: string, i: number) => { ad[HEADLINES[i]] = v })
  ;(d.descriptions ?? []).slice(0, 5).forEach((v: string, i: number) => { ad[DESCRIPTIONS[i]] = v })
  ;(d.video_ids ?? []).slice(0, 5).forEach((v: string, i: number) => { ad[VIDEOS[i]] = v })
  rows.push(ad)
  return rows
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const auth = req.headers.get('Authorization') ?? ''
    const body = await req.json().catch(() => ({}))
    const { client_id, draft_ids } = body
    if (!client_id) return json({ error: 'client_id je obavezan' }, 400)

    // Caller's own JWT -> RLS decides which drafts and campaigns are visible.
    const user = createClient(SUPABASE_URL, ANON_KEY, { global: { headers: { Authorization: auth } } })
    let q = user.from('display_ad_drafts').select('*').eq('client_id', client_id).in('status', ['draft', 'exported']).order('created_at')
    if (Array.isArray(draft_ids) && draft_ids.length) q = q.in('id', draft_ids)
    const { data: drafts, error } = await q
    if (error) throw error
    if (!drafts?.length) return json({ error: 'Nema Display nacrta za izvoz (ili nemate pristup)' }, 404)

    // Safety: new ad groups only go into Display campaigns that already exist for this client.
    const { data: camps, error: ce } = await user.rpc('display_campaigns', { p_client_id: client_id })
    if (ce) throw ce
    const known = new Set((camps ?? []).map((c: { campaign: string }) => c.campaign))
    const ok = drafts.filter((d) => d.mode === 'campaign' || known.has(d.campaign_name))
    if (!ok.length) return json({ error: 'Nijedan nacrt ne cilja postojeću Display kampanju ovog klijenta' }, 422)

    const lines = [HEADER.join(',')]
    for (const d of ok) for (const r of rowsFor(d)) lines.push(HEADER.map((h) => esc(r[h])).join(','))

    const ids = ok.map((d) => d.id)
    const { error: upErr } = await user.from('display_ad_drafts').update({ status: 'exported', exported_at: new Date().toISOString() }).in('id', ids)
    if (upErr) throw upErr
    const admin = createClient(SUPABASE_URL, SERVICE_KEY)
    await admin.from('automation_log').insert({ client_id, source: 'export-display-csv', action: 'export', target: `${ids.length} Display oglasa`, new_value: { draft_ids: ids }, mode: 'suggest' })

    return new Response(lines.join('\r\n') + '\r\n', { headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8' } })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
