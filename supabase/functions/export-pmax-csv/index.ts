import { createClient } from 'jsr:@supabase/supabase-js@2'

// Performance Max asset group drafts → Google Ads Editor CSV (one Paused asset group per draft,
// added to an existing PMax campaign). Images are referenced as images/<file>, packed next to the CSV.

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (obj: unknown, status: number) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

// NOTE: column names are not yet checked against a real Editor export of a PMax asset group.
// Adjust them here once a sample export is available; nothing else depends on the names.
const HEADLINES = Array.from({ length: 15 }, (_, i) => `Headline ${i + 1}`)
const LONG_HEADLINES = Array.from({ length: 5 }, (_, i) => `Long headline ${i + 1}`)
const DESCRIPTIONS = Array.from({ length: 5 }, (_, i) => `Description ${i + 1}`)
const HEADER = [
  'Campaign', 'Asset group', 'Status', 'Final URL', 'Path 1', 'Path 2',
  ...HEADLINES, ...LONG_HEADLINES, ...DESCRIPTIONS,
  'Business name', 'Call to action', 'Image', 'Logo', 'Landscape logo', 'Video ID', 'Search theme',
]
// Image field → CSV column.
const IMAGE_COLUMN: Record<string, string> = {
  MARKETING_IMAGE: 'Image',
  SQUARE_MARKETING_IMAGE: 'Image',
  PORTRAIT_MARKETING_IMAGE: 'Image',
  LOGO: 'Logo',
  LANDSCAPE_LOGO: 'Landscape logo',
}

function esc(v: unknown): string {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

// deno-lint-ignore no-explicit-any
function rowsFor(d: any): Record<string, unknown>[] {
  const key = { Campaign: d.campaign_name, 'Asset group': d.asset_group_name }
  const main: Record<string, unknown> = {
    ...key, Status: 'Paused', 'Final URL': d.final_url, 'Path 1': d.path1, 'Path 2': d.path2,
    'Business name': d.business_name, 'Call to action': d.call_to_action,
  }
  ;(d.headlines ?? []).slice(0, 15).forEach((h: string, i: number) => { main[HEADLINES[i]] = h })
  ;(d.long_headlines ?? []).slice(0, 5).forEach((h: string, i: number) => { main[LONG_HEADLINES[i]] = h })
  ;(d.descriptions ?? []).slice(0, 5).forEach((x: string, i: number) => { main[DESCRIPTIONS[i]] = x })
  const rows = [main]
  for (const img of d.images ?? []) {
    const col = IMAGE_COLUMN[img?.field]
    if (col && img.file && !/[\\/]/.test(img.file)) rows.push({ ...key, [col]: `images/${img.file}` })
  }
  for (const v of d.video_ids ?? []) rows.push({ ...key, 'Video ID': v })
  for (const t of d.search_themes ?? []) rows.push({ ...key, 'Search theme': t })
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
    let q = user.from('pmax_asset_group_drafts').select('*').eq('client_id', client_id).in('status', ['draft', 'exported']).order('created_at')
    if (Array.isArray(draft_ids) && draft_ids.length) q = q.in('id', draft_ids)
    const { data: drafts, error } = await q
    if (error) throw error
    if (!drafts?.length) return json({ error: 'Nema PMax nacrta za izvoz (ili nemate pristup)' }, 404)

    // Safety: asset groups only go into PMax campaigns that already exist for this client.
    const { data: camps, error: ce } = await user.rpc('pmax_campaigns', { p_client_id: client_id })
    if (ce) throw ce
    const known = new Set((camps ?? []).map((c: { campaign: string }) => c.campaign))
    const ok = drafts.filter((d) => known.has(d.campaign_name))
    if (!ok.length) return json({ error: 'Nijedan nacrt ne cilja postojeću PMax kampanju ovog klijenta' }, 422)

    const lines = [HEADER.join(',')]
    for (const d of ok) for (const r of rowsFor(d)) lines.push(HEADER.map((h) => esc(r[h])).join(','))

    const ids = ok.map((d) => d.id)
    const { error: upErr } = await user.from('pmax_asset_group_drafts').update({ status: 'exported', exported_at: new Date().toISOString() }).in('id', ids)
    if (upErr) throw upErr
    const admin = createClient(SUPABASE_URL, SERVICE_KEY)
    await admin.from('automation_log').insert({ client_id, source: 'export-pmax-csv', action: 'export', target: `${ids.length} asset grupa`, new_value: { draft_ids: ids }, mode: 'suggest' })

    return new Response(lines.join('\r\n') + '\r\n', { headers: { ...CORS, 'Content-Type': 'text/csv; charset=utf-8' } })
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})
