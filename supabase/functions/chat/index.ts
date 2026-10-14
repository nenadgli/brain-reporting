import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!
const MCP_ACCESS_TOKEN = Deno.env.get('MCP_ACCESS_TOKEN')!
const MCP_URL = `${SUPABASE_URL}/functions/v1/mcp-server`
const MODEL = 'claude-opus-5-5'
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

// The function checks the caller itself: only logged-in agency users (the tools see every client's
// data). The Anthropic key is the project's ANTHROPIC_API_KEY secret, as for the other functions.
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function mcpCall(method: string, params?: Record<string, unknown>) {
  const res = await fetch(MCP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${MCP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json()
  return json.result
}

type AnthropicTool = { name: string; description: string; input_schema: Record<string, unknown> }

async function getTools(): Promise<AnthropicTool[]> {
  const result = await mcpCall('tools/list')
  return (result?.tools ?? []).map((t: { name: string; description: string; inputSchema: Record<string, unknown> }) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))
}

type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }

async function callAnthropic(messages: AnthropicMessage[], tools: AnthropicTool[]) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'server-side-fallback-2026-07-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      fallbacks: 'default',
      max_tokens: 4000,
      system:
        'Ti si analitičar za marketing agenciju koja koristi Brain Reporting Platform. ' +
        'Odgovaraj na srpskom, kratko i konkretno, sa brojevima iz alata koje pozivaš. ' +
        'Nikad ne izmišljaj brojeve — ako alat ne vrati podatak, reci da ga nema. ' +
        'Kad porediš periode ili kanale, izračunaj razliku i objasni šta znači za klijenta.',
      messages,
      tools,
    }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Anthropic API HTTP ${res.status}: ${text.slice(0, 500)}`)
  }
  return res.json()
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    if (!ANTHROPIC_API_KEY) return json({ error: 'Nedostaje ANTHROPIC_API_KEY u Supabase secrets' }, 500)
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace('Bearer ', '')
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt)
    if (userError || !userData?.user) {
      return json({ error: 'Niste ulogovani' }, 401)
    }
    const { data: au } = await supabase.from('app_users').select('agency_id, client_id').eq('id', userData.user.id).maybeSingle()
    if (!au?.agency_id || au.client_id) return json({ error: 'AI Chat je dostupan samo korisnicima agencije' }, 403)

    const { message, history } = await req.json()
    if (!message) {
      return json({ error: 'message je obavezan' }, 400)
    }

    const tools = await getTools()
    const messages: AnthropicMessage[] = [...(history ?? []), { role: 'user', content: message }]

    let loopCount = 0
    while (loopCount < 6) {
      loopCount++
      const response = await callAnthropic(messages, tools)

      if (response.stop_reason !== 'tool_use') {
        const textBlocks = (response.content ?? []).filter((b: { type: string }) => b.type === 'text')
        const answer = textBlocks.map((b: { text: string }) => b.text).join('\n')
        return json({ answer, history: [...messages, { role: 'assistant', content: response.content }] })
      }

      // Claude wants to call one or more tools — execute each via the MCP server, feed results back.
      messages.push({ role: 'assistant', content: response.content })
      const toolUseBlocks = response.content.filter((b: { type: string }) => b.type === 'tool_use')
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block: { id: string; name: string; input: Record<string, unknown> }) => {
          const result = await mcpCall('tools/call', { name: block.name, arguments: block.input })
          return {
            type: 'tool_result',
            tool_use_id: block.id,
            content: result?.content ?? [{ type: 'text', text: 'Greška pri pozivu alata' }],
          }
        })
      )
      messages.push({ role: 'user', content: toolResults })
    }

    return json({ error: 'Previše koraka, pokušaj preciznije pitanje.' }, 500)
  } catch (err) {
    return json({ error: (err as Error).message }, 500)
  }
})

