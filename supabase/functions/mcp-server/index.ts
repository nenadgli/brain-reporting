import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const MCP_ACCESS_TOKEN = Deno.env.get('MCP_ACCESS_TOKEN')!

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

// ---- helpers ----------------------------------------------------------

function defaultRange(startDate?: string, endDate?: string) {
  const end = endDate ?? new Date().toISOString().slice(0, 10)
  const start = startDate ?? new Date(new Date(end).getTime() - 13 * 86400000).toISOString().slice(0, 10)
  return { start, end }
}

async function resolveClientId(clientName: string): Promise<{ id: string; name: string } | null> {
  const { data } = await supabase.from('clients').select('id, name').ilike('name', `%${clientName}%`).limit(1)
  return data && data.length > 0 ? data[0] : null
}

function toolError(msg: string) {
  return { content: [{ type: 'text', text: `Greška: ${msg}` }], isError: true }
}

function toolResult(data: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
}

// ---- tool definitions (JSON schema for tools/list) ---------------------

const TOOLS = [
  {
    name: 'list_clients',
    description: 'Lista svih klijenata agencije, sa informacijom koji marketing kanali su im povezani (Google Ads, Meta, GA4). Pozovi ovo prvo ako nisi siguran za tačan naziv klijenta.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_performance_summary',
    description: 'Ukupne performanse (potrošnja, klikovi, konverzije, ROAS, itd.) za jednog klijenta na jednom kanalu, za dati period. Kanal blended spaja Google Ads + Meta.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Naziv klijenta (delimično poklapanje je OK)' },
        channel: { type: 'string', enum: ['google_ads', 'meta', 'ga4', 'blended'] },
        start_date: { type: 'string', description: 'YYYY-MM-DD, opciono' },
        end_date: { type: 'string', description: 'YYYY-MM-DD, opciono' },
      },
      required: ['client_name', 'channel'],
    },
  },
  {
    name: 'get_daily_trend',
    description: 'Dnevni trend potrošnje i konverzija za klijenta na datom kanalu, za dati period.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        channel: { type: 'string', enum: ['google_ads', 'meta', 'blended', 'owned'] },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
      },
      required: ['client_name', 'channel'],
    },
  },
  {
    name: 'get_campaign_ranking',
    description: 'Rang kampanja po potrošnji za klijenta na datom kanalu, sa spend/konverzije/ROAS po kampanji.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        channel: { type: 'string', enum: ['google_ads', 'meta', 'blended'] },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'number', description: 'Podrazumevano 20' },
      },
      required: ['client_name', 'channel'],
    },
  },
  {
    name: 'get_top_keywords',
    description: 'Top Google Ads ključne reči po potrošnji, sa Quality Score-om, za klijenta i period.',
    inputSchema: {
      type: 'object',
      properties: { client_name: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, limit: { type: 'number' } },
      required: ['client_name'],
    },
  },
  {
    name: 'get_top_search_terms',
    description: 'Google Ads search termini (stvarne pretrage korisnika) po potrošnji. Postavi zero_conversions_only=true da nađeš kandidate za negativne ključne reči.',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        zero_conversions_only: { type: 'boolean' },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'get_top_competitors',
    description: 'Domeni konkurenata koji se najčešće pojavljuju u istim Google Ads aukcijama kao klijent (auction insights - samo prisustvo, ne overlap %).',
    inputSchema: {
      type: 'object',
      properties: { client_name: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, limit: { type: 'number' } },
      required: ['client_name'],
    },
  },
  {
    name: 'get_top_creatives',
    description: 'Top Facebook/Instagram kreative (konkretne reklame) po potrošnji, sa CTR-om.',
    inputSchema: {
      type: 'object',
      properties: { client_name: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, limit: { type: 'number' } },
      required: ['client_name'],
    },
  },
  {
    name: 'get_traffic_sources',
    description: 'GA4 raspodela sajt-saobraćaja po izvoru (Google, Facebook, direktan pristup, itd.) sa sesijama, angažovanošću i prihodom.',
    inputSchema: {
      type: 'object',
      properties: { client_name: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, limit: { type: 'number' } },
      required: ['client_name'],
    },
  },
  {
    name: 'get_ga4_verification',
    description: 'Poredi šta Google Ads/Meta SAMI prijavljuju (potrošnja, vrednost konverzija) naspram šta GA4 nezavisno meri da se desilo na sajtu za taj saobraćaj. Otkriva da li platforma precenjuje ili potcenjuje svoj doprinos.',
    inputSchema: {
      type: 'object',
      properties: { client_name: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' } },
      required: ['client_name'],
    },
  },
  {
    name: 'get_engagement_quality',
    description: 'GA4 bounce rate i engagement rate po izvoru saobraćaja — otkriva koji kanali dovode posetioce koji stvarno ostaju na sajtu.',
    inputSchema: {
      type: 'object',
      properties: { client_name: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, limit: { type: 'number' } },
      required: ['client_name'],
    },
  },
  {
    name: 'get_owned_channel_performance',
    description: 'Performanse push notifikacija i/ili newsletter-a (email) — sesije, prihod, broj slanja, top kampanje po tipu (broadcast vs. automatizacija napuštene korpe).',
    inputSchema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        channel: { type: 'string', enum: ['push_notification', 'newsletter', 'both'] },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
      },
      required: ['client_name'],
    },
  },
]

// ---- tool execution -----------------------------------------------------

async function callTool(name: string, args: Record<string, unknown>) {
  const clientName = args.client_name as string | undefined
  if (name !== 'list_clients') {
    if (!clientName) return toolError('client_name je obavezan')
  }

  if (name === 'list_clients') {
    const { data: clients } = await supabase.from('clients').select('id, name')
    const { data: sources } = await supabase.from('data_sources').select('client_id, provider')
    const out = (clients ?? []).map((c) => ({
      name: c.name,
      channels: [...new Set((sources ?? []).filter((s) => s.client_id === c.id).map((s) => s.provider))],
    }))
    return toolResult(out)
  }

  const client = await resolveClientId(clientName!)
  if (!client) return toolError(`Klijent "${clientName}" nije pronađen`)
  const { start, end } = defaultRange(args.start_date as string | undefined, args.end_date as string | undefined)
  const limit = (args.limit as number) ?? 20

  switch (name) {
    case 'get_performance_summary': {
      const channel = args.channel as string
      const fnMap: Record<string, string> = {
        google_ads: 'google_ads_period_totals',
        meta: 'facebook_ads_period_totals',
        ga4: 'ga4_period_totals',
        blended: 'blended_channel_summary',
      }
      const fn = fnMap[channel]
      if (!fn) return toolError('Nepoznat kanal')
      const { data, error } = await supabase.rpc(fn, { p_client_id: client.id, p_start: start, p_end: end })
      if (error) return toolError(error.message)
      return toolResult({ client: client.name, channel, period: { start, end }, data })
    }
    case 'get_daily_trend': {
      const channel = args.channel as string
      const fnMap: Record<string, string> = {
        google_ads: 'google_ads_daily_trend',
        meta: 'facebook_ads_daily_trend',
        blended: 'blended_daily_trend',
        owned: 'owned_channel_daily_trend',
      }
      const fn = fnMap[channel]
      if (!fn) return toolError('Nepoznat kanal')
      const { data, error } = await supabase.rpc(fn, { p_client_id: client.id, p_start: start, p_end: end })
      if (error) return toolError(error.message)
      return toolResult({ client: client.name, channel, period: { start, end }, data })
    }
    case 'get_campaign_ranking': {
      const channel = args.channel as string
      const fnMap: Record<string, string> = {
        google_ads: 'google_ads_campaign_summary',
        meta: 'facebook_ads_campaign_summary',
        blended: 'blended_campaign_summary',
      }
      const fn = fnMap[channel]
      if (!fn) return toolError('Nepoznat kanal')
      const { data, error } = await supabase.rpc(fn, { p_client_id: client.id, p_start: start, p_end: end })
      if (error) return toolError(error.message)
      return toolResult({ client: client.name, channel, period: { start, end }, data: (data ?? []).slice(0, limit) })
    }
    case 'get_top_keywords': {
      const { data, error } = await supabase.rpc('google_ads_top_keywords', { p_client_id: client.id, p_start: start, p_end: end, p_limit: limit })
      if (error) return toolError(error.message)
      return toolResult({ client: client.name, period: { start, end }, data })
    }
    case 'get_top_search_terms': {
      const { data, error } = await supabase.rpc('google_ads_top_search_terms', {
        p_client_id: client.id, p_start: start, p_end: end, p_zero_conv_only: !!args.zero_conversions_only, p_limit: limit,
      })
      if (error) return toolError(error.message)
      return toolResult({ client: client.name, period: { start, end }, data })
    }
    case 'get_top_competitors': {
      const { data, error } = await supabase.rpc('google_ads_top_competitors', { p_client_id: client.id, p_start: start, p_end: end, p_limit: limit })
      if (error) return toolError(error.message)
      return toolResult({ client: client.name, period: { start, end }, data })
    }
    case 'get_top_creatives': {
      const { data, error } = await supabase.rpc('facebook_ads_top_creatives', { p_client_id: client.id, p_start: start, p_end: end, p_limit: limit })
      if (error) return toolError(error.message)
      return toolResult({ client: client.name, period: { start, end }, data })
    }
    case 'get_traffic_sources': {
      const { data, error } = await supabase.rpc('ga4_source_summary', { p_client_id: client.id, p_start: start, p_end: end, p_limit: limit })
      if (error) return toolError(error.message)
      return toolResult({ client: client.name, period: { start, end }, data })
    }
    case 'get_ga4_verification': {
      const { data, error } = await supabase.rpc('ga4_paid_channel_verification', { p_client_id: client.id, p_start: start, p_end: end })
      if (error) return toolError(error.message)
      return toolResult({
        client: client.name,
        period: { start, end },
        note: 'GA4 "konverzije" broje sve key events, ne samo kupovine, pa se taj broj neće poklopiti sa ad-platform brojem. Fokus na sesije i prihod.',
        data,
      })
    }
    case 'get_engagement_quality': {
      const { data, error } = await supabase.rpc('ga4_engagement_by_channel', { p_client_id: client.id, p_start: start, p_end: end, p_limit: limit })
      if (error) return toolError(error.message)
      return toolResult({ client: client.name, period: { start, end }, data })
    }
    case 'get_owned_channel_performance': {
      const channel = (args.channel as string) ?? 'both'
      const { data: totals, error } = await supabase.rpc('owned_channel_period_totals', { p_client_id: client.id, p_start: start, p_end: end })
      if (error) return toolError(error.message)
      const filtered = channel === 'both' ? totals : (totals ?? []).filter((r: { source: string }) => r.source === channel)
      return toolResult({ client: client.name, period: { start, end }, totals: filtered })
    }
    default:
      return toolError(`Nepoznat alat: ${name}`)
  }
}

// ---- MCP JSON-RPC endpoint ------------------------------------------

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('MCP server — use POST', { status: 405 })
  }

  const auth = req.headers.get('Authorization') ?? ''
  if (auth !== `Bearer ${MCP_ACCESS_TOKEN}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
  }

  let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }), { status: 400, headers: { 'Content-Type': 'application/json' } })
  }

  const { id, method, params } = body

  if (method === 'initialize') {
    return Response.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: (params?.protocolVersion as string) ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'brain-reporting-mcp', version: '1.0.0' },
      },
    })
  }

  if (method === 'notifications/initialized') {
    return new Response(null, { status: 202 })
  }

  if (method === 'tools/list') {
    return Response.json({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  }

  if (method === 'tools/call') {
    const toolName = params?.name as string
    const toolArgs = (params?.arguments as Record<string, unknown>) ?? {}
    try {
      const result = await callTool(toolName, toolArgs)
      return Response.json({ jsonrpc: '2.0', id, result })
    } catch (err) {
      return Response.json({ jsonrpc: '2.0', id, result: toolError((err as Error).message) })
    }
  }

  return Response.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } }, { status: 404 })
})
