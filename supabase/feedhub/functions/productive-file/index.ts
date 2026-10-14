import { createClient } from 'jsr:@supabase/supabase-js@2'

// Streams a Productive attachment to the browser without storing it.
// Links are minted by export-campaign-briefs: ?id=<attachment>&v=original|thumb&exp=<unix>&sig=<hmac>.
// The Productive token never leaves the server.

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'range',
  'Access-Control-Expose-Headers': 'content-length, content-range, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

let keyPromise: Promise<CryptoKey> | null = null
function signingKey() {
  keyPromise ??= (async () => {
    const { data, error } = await sb.from('internal_secrets').select('value').eq('name', 'productive_file_signing_key').single()
    if (error) throw error
    return crypto.subtle.importKey('raw', new TextEncoder().encode(data.value), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  })()
  return keyPromise
}
const fromHex = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((b) => parseInt(b, 16)))

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  const u = new URL(req.url)
  const id = u.searchParams.get('id') ?? ''
  const v = u.searchParams.get('v') === 'thumb' ? 'thumb' : 'original'
  const exp = Number(u.searchParams.get('exp'))
  const sig = u.searchParams.get('sig') ?? ''
  if (!/^\d+$/.test(id) || !exp || !/^[0-9a-f]{64}$/.test(sig)) return new Response('bad request', { status: 400, headers: cors })
  if (exp < Date.now() / 1000) return new Response('link expired', { status: 410, headers: cors })
  const ok = await crypto.subtle.verify('HMAC', await signingKey(), fromHex(sig), new TextEncoder().encode(`${id}.${v}.${exp}`))
  if (!ok) return new Response('forbidden', { status: 403, headers: cors })

  const { data: a } = await sb.from('productive_task_attachments').select('name, content_type, source_url, thumb_url').eq('productive_id', id).maybeSingle()
  const src = v === 'thumb' ? a?.thumb_url ?? a?.source_url : a?.source_url
  if (!a || !src) return new Response('not found', { status: 404, headers: cors })

  // files.productive.io only accepts the API token as a query param.
  const fileUrl = new URL(src)
  fileUrl.searchParams.set('token', Deno.env.get('PRODUCTIVE_API_TOKEN')!)
  const range = req.headers.get('range')
  const r = await fetch(fileUrl, { headers: range ? { range } : {}, redirect: 'manual' })
  if (r.status !== 200 && r.status !== 206) {
    await r.body?.cancel()
    return new Response(`Productive HTTP ${r.status}`, { status: 502, headers: cors })
  }
  const headers: Record<string, string> = {
    ...cors,
    'Content-Type': r.headers.get('content-type') ?? a.content_type ?? 'application/octet-stream',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.name ?? 'file')}`,
    'Cache-Control': 'private, max-age=3600',
  }
  for (const h of ['content-length', 'content-range', 'accept-ranges']) {
    const val = r.headers.get(h)
    if (val) headers[h] = val
  }
  return new Response(r.body, { status: r.status, headers })
})
