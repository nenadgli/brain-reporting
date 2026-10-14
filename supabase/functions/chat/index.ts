import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!
const MCP_ACCESS_TOKEN = Deno.env.get('MCP_ACCESS_TOKEN')!
const MCP_URL = `${SUPABASE_URL}/functions/v1/mcp-server`
const MODEL = 'claude-sonnet-5'

// This function requires a logged-in Supabase session (verify_jwt stays true,
// unlike mcp-server which uses its own token) — only authenticated app users
// can reach the chat, matching the rest of the dashboard.
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
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
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
  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const jwt = authHeader.replace('Bearer ', '')
    const { data: userData, error: userError } = await supabase.auth.getUser(jwt)
    if (userError || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Niste ulogovani' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
    }

    const { message, history } = await req.json()
    if (!message) {
      return new Response(JSON.stringify({ error: 'message je obavezan' }), { status: 400, headers: { 'Content-Type': 'application/json' } })
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
        return new Response(JSON.stringify({ answer, history: [...messages, { role: 'assistant', content: response.content }] }), {
          headers: { 'Content-Type': 'application/json' },
        })
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

    return new Response(JSON.stringify({ error: 'Previše koraka, pokušaj preciznije pitanje.' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  }
})
