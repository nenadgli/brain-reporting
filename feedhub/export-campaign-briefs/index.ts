import { createClient } from 'jsr:@supabase/supabase-js@2'

// Read-only export of Productive "akcija" briefs for other Loft19 tools (Brain).
// Auth: x-api-key header, checked against a SHA-256 hash in external_api_keys.

const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
const SCOPE = 'campaign_briefs:read'

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'x-api-key, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

async function sha256(s: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Brief template labels (two template versions are in use; labels vary in case and trailing ':' / '?').
const LABELS: Record<string, string> = {
  'TERITORY': 'territory',
  'TERRITORY': 'territory',
  'HEADLINE - NAZIV AKCIJE': 'headline',
  'TRAJANJE AKCIJE': 'duration',
  'PUSH - DATUM ZAKAZIVANJA': 'push_date',
  'PERCENAT POPUSTA': 'discount',
  'DA LI SE POPUST DODAJE NA VEĆ POSTOJEĆI': 'stacks_with_existing',
  'NA ŠTO SE ODNOSI AKCIJA': 'applies_to',
  'ŠTO ISKLJUČUJE': 'excludes',
  'DA LI JE AKCIJA AKTUELNA I U RADNJAMA': 'in_stores',
  'LANDING PAGE': 'landing_page',
  'COPY': 'copy',
  'LEGAL LINE': 'legal_line',
  'NAPOMENA': 'note',
}
// Headers of the channel table and other blocks whose content is not a brief field.
const SKIP_BLOCKS = new Set(['CHANNEL', 'START', 'COMMUNICATION CHANNELS', 'DODATNI FORMATI'])
const CHANNELS: Record<string, string> = {
  'KEY VISUAL': 'key_visual',
  'PAID GOOGLE': 'paid_google',
  'PAID META': 'paid_meta',
  'PAID TIK TOK': 'paid_tiktok',
  'PUSH NOTIFICATION': 'push_notification',
  'O&O': 'owned',
  'NL': 'newsletter',
}

const normLabel = (s: string) => s.replace(/\s+/g, ' ').replace(/[:?]+$/, '').trim().toUpperCase()

function toLines(html: string): string[] {
  return html
    .replace(/@\[\{.*?\}\]/g, ' ') // Productive @mentions
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0)
}

// "8.10.2026. - 11.10.2026." or "15.10. - 18.10." → ISO dates; year from the task when missing.
function parseRange(s: string | undefined, fallbackYear: number): { start: string | null; end: string | null } {
  if (!s) return { start: null, end: null }
  const ds = [...s.matchAll(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?/g)].map((m) => {
    const y = m[3] ? Number(m[3]) : fallbackYear
    return `${y}-${String(Number(m[2])).padStart(2, '0')}-${String(Number(m[1])).padStart(2, '0')}`
  })
  return { start: ds[0] ?? null, end: ds[1] ?? ds[0] ?? null }
}

function parseBrief(html: string, createdAt: string) {
  const lines = toLines(html)
  const fields: Record<string, string[]> = {}
  const channels: Record<string, { on: boolean; date: string | null }> = {}
  let current: string | null = null
  let channel: string | null = null
  const intro: string[] = []
  let skipping = false
  for (const line of lines) {
    const label = normLabel(line)
    // "Copy: -20% na sve" — label and value on one line
    const inline = line.match(/^([^:]{2,45}):\s*(.+)$/)
    if (inline && LABELS[normLabel(inline[1])]) {
      current = LABELS[normLabel(inline[1])]
      channel = null
      skipping = false
      ;(fields[current] ??= []).push(inline[2].trim())
      continue
    }
    if (LABELS[label]) {
      current = LABELS[label]
      channel = null
      skipping = false
      fields[current] ??= []
      continue
    }
    if (CHANNELS[label]) {
      channel = CHANNELS[label]
      current = null
      skipping = false
      channels[channel] = { on: false, date: null }
      continue
    }
    if (SKIP_BLOCKS.has(label)) {
      current = null
      channel = null
      skipping = true
      continue
    }
    if (channel) {
      if (line.includes('✅')) channels[channel].on = true
      const d = parseRange(line, new Date(createdAt).getFullYear()).start
      if (d) channels[channel].date = d
      continue
    }
    if (skipping) continue
    if (current) fields[current].push(line)
    else intro.push(line)
  }
  const one = (k: string) => (fields[k]?.length ? fields[k].join(' / ') : null)
  const year = new Date(createdAt).getFullYear()
  // Briefs written as free text, without the template ("Akcija važi online od 20.10.2026. do 18.11.2026."):
  // the period comes from the line that says when the offer runs, the discount from the first percentages.
  const freeForm = !fields.duration && !fields.headline
  if (!fields.duration) {
    const when = lines.find((l) => /(važi|traje|trajanje|period)/i.test(l) && /\d{1,2}\.\s*\d{1,2}\./.test(l))
      ?? lines.find((l) => (l.match(/\d{1,2}\.\s*\d{1,2}\./g) ?? []).length >= 2)
    if (when) fields.duration = [when]
  }
  if (!fields.discount) {
    const pct = lines.map((l) => l.match(/-?\d{1,2}\s?%(?:\s*[-–/i]*\s*-?\d{1,2}\s?%)*/)?.[0]).find(Boolean)
    if (pct) fields.discount = [pct.trim()]
  }
  if (!fields.legal_line && freeForm) {
    const legal = lines.find((l) => /(važi|odnosi se|ne odnosi)/i.test(l))
    if (legal) fields.legal_line = [legal]
  }
  if (!fields.copy && freeForm && intro.length) fields.copy = intro.filter((l) => !/(molba|primer teksta|šaljem|saljem|spustam|po dogovoru)/i.test(l) && !(fields.legal_line ?? []).includes(l))
  const range = parseRange(one('duration') ?? undefined, year)
  // "6.8.2026. - do daljnjeg" has no end date
  if (/dalj/i.test(one('duration') ?? '') && range.start === range.end) range.end = null
  const landing = one('landing_page')
  return {
    territory: one('territory'),
    headline: one('headline'),
    duration_text: one('duration'),
    start_date: range.start,
    end_date: range.end,
    push_date: parseRange(one('push_date') ?? undefined, year).start,
    discount: one('discount'),
    stacks_with_existing: one('stacks_with_existing'),
    applies_to: one('applies_to'),
    excludes: one('excludes'),
    in_stores: one('in_stores'),
    landing_page: landing?.match(/https?:\/\/\S+/)?.[0] ?? null,
    landing_page_note: landing,
    copy: fields.copy?.length ? fields.copy.join('\n') : null,
    legal_line: one('legal_line'),
    note: one('note'),
    channels,
    intro: intro.join(' ') || null,
    free_form: freeForm,
  }
}

// ---- Productive attachments (brief task, its subtasks and their comments) ----
// Only metadata is kept here; files are streamed from Productive by productive-file through signed links.
const LEGACY_BUCKET = 'productive-attachments'
const PRODUCTIVE = 'https://api.productive.io/api/v2'
const FILE_PROXY = 'https://bagpjjejeuteojpsufto.supabase.co/functions/v1/productive-file'
const LINK_TTL_S = 2 * 3600

function productiveHeaders() {
  return {
    'X-Auth-Token': Deno.env.get('PRODUCTIVE_API_TOKEN')!,
    'X-Organization-Id': Deno.env.get('PRODUCTIVE_ORGANIZATION_ID')!,
    'Content-Type': 'application/vnd.api+json',
  }
}

// deno-lint-ignore no-explicit-any
async function productiveList(path: string): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const out: any[] = []
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes('?') ? '&' : '?'
    const r = await fetch(`${PRODUCTIVE}${path}${sep}page[number]=${page}&page[size]=200`, { headers: productiveHeaders(), signal: AbortSignal.timeout(30000) })
    if (!r.ok) throw new Error(`Productive ${path} HTTP ${r.status}`)
    const j = await r.json()
    out.push(...(j.data ?? []))
    if ((j.data ?? []).length < 200) break
  }
  return out
}

let signKey: Promise<CryptoKey> | null = null
function signingKey() {
  signKey ??= (async () => {
    const { data, error } = await sb.from('internal_secrets').select('value').eq('name', 'productive_file_signing_key').single()
    if (error) throw error
    return crypto.subtle.importKey('raw', new TextEncoder().encode(data.value), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  })()
  return signKey
}

async function fileLink(id: string, v: 'original' | 'thumb') {
  const exp = Math.floor(Date.now() / 1000) + LINK_TTL_S
  const sig = await crypto.subtle.sign('HMAC', await signingKey(), new TextEncoder().encode(`${id}.${v}.${exp}`))
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${FILE_PROXY}?id=${id}&v=${v}&exp=${exp}&sig=${hex}`
}

async function syncTaskAttachments(briefTaskId: string) {
  const subtasks = await productiveList(`/tasks?filter[parent_task_id]=${briefTaskId}`).catch(() => [])
  const tasks = [...subtasks.map((t) => ({ id: String(t.id), title: t.attributes?.title ?? null })), { id: briefTaskId, title: null as string | null }]
  const seen = new Set<string>()
  const rows: Record<string, unknown>[] = []
  for (const t of tasks) {
    const comments = await productiveList(`/comments?filter[task_id]=${t.id}&include=attachments`).catch(() => [])
    const commentOf = new Map<string, string>()
    for (const c of comments) for (const a of c.relationships?.attachments?.data ?? []) commentOf.set(String(a.id), String(c.id))
    for (const a of await productiveList(`/attachments?filter[task_id]=${t.id}`)) {
      const id = String(a.id)
      const at = a.attributes ?? {}
      if (seen.has(id) || at.deleted_at) continue
      seen.add(id)
      rows.push({
        productive_id: id,
        task_productive_id: t.id,
        brief_task_productive_id: briefTaskId,
        task_title: t.title,
        comment_productive_id: commentOf.get(id) ?? null,
        name: at.name ?? null,
        content_type: at.content_type ?? null,
        size_bytes: at.size ?? null,
        source_created_at: at.created_at ?? null,
        source_url: at.url ?? null,
        thumb_url: at.thumb ?? null,
        raw_json: a,
        updated_at: new Date().toISOString(),
      })
    }
  }
  if (rows.length) {
    const { error } = await sb.from('productive_task_attachments').upsert(rows, { onConflict: 'productive_id' })
    if (error) throw error
  }
  // Copies made by the first version (files stored in Supabase) are no longer needed.
  const { data: legacy } = await sb.from('productive_task_attachments').select('productive_id, storage_path').eq('brief_task_productive_id', briefTaskId).not('storage_path', 'is', null)
  if (legacy?.length) {
    const { error } = await sb.storage.from(LEGACY_BUCKET).remove(legacy.map((l) => l.storage_path as string))
    if (!error) await sb.from('productive_task_attachments').update({ storage_path: null }).in('productive_id', legacy.map((l) => l.productive_id))
  }
  return { found: rows.length, legacy_copies_removed: legacy?.length ?? 0 }
}

// ---- On-demand task refresh for one project (the daily sync-productive run covers everything else) ----
// Same row shape as sync-productive's syncTasks, so both writers agree.
const REFRESH_COOLDOWN_MS = 60_000

async function refreshProjectTasks(projectId: string) {
  const entity = `tasks:project:${projectId}`
  const { data: last } = await sb.from('productive_sync_runs').select('finished_at').eq('entity_type', entity).eq('status', 'success').order('finished_at', { ascending: false }).limit(1).maybeSingle()
  if (last?.finished_at && Date.now() - new Date(last.finished_at).getTime() < REFRESH_COOLDOWN_MS) {
    return { skipped: true, refreshed_at: last.finished_at }
  }
  const start = Date.now()
  // deno-lint-ignore no-explicit-any
  const data: any[] = []
  // deno-lint-ignore no-explicit-any
  const included: any[] = []
  for (let page = 1; page <= 20; page++) {
    const q = `filter[project_id]=${projectId}&filter[status]=1,2,3&include=assignee,creator,task_list,workflow_status&page[number]=${page}&page[size]=200`
    const r = await fetch(`${PRODUCTIVE}/tasks?${q}`, { headers: productiveHeaders(), signal: AbortSignal.timeout(30000) })
    if (!r.ok) throw new Error(`Productive /tasks HTTP ${r.status}`)
    const j = await r.json()
    data.push(...(j.data ?? []))
    included.push(...(j.included ?? []))
    if (page >= (j.meta?.total_pages ?? 1) || !(j.data ?? []).length) break
  }
  const workflow = new Map<string, { name: string | null; category: string | null }>()
  const people = new Map<string, { name: string | null; email: string | null }>()
  for (const inc of included) {
    const a = inc.attributes ?? {}
    if (inc.type === 'workflow_statuses') workflow.set(String(inc.id), { name: a.name ?? null, category: a.category_id != null ? String(a.category_id) : (a.category ?? null) })
    if (inc.type === 'people') people.set(String(inc.id), { name: a.name ?? ([a.first_name, a.last_name].filter(Boolean).join(' ') || null), email: a.email ?? null })
  }
  const { data: project } = await sb.from('productive_projects').select('id, client_id, client_name').eq('productive_id', projectId).maybeSingle()
  const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const rows = data.map((t) => {
    const a = t.attributes ?? {}
    const r = t.relationships ?? {}
    const assigneeId = r.assignee?.data?.id ?? null
    const creatorId = r.creator?.data?.id ?? null
    const taskListId = r.task_list?.data?.id ?? null
    const wf = r.workflow_status?.data?.id ? workflow.get(String(r.workflow_status.data.id)) : null
    const isClosed = !!a.closed_at || a.status === 2 || a.status === 'closed' || a.closed === true
    const isArchived = !!a.archived_at || a.status === 3
    return {
      productive_id: String(t.id),
      productive_project_id: projectId,
      productive_task_list_id: taskListId ? String(taskListId) : null,
      productive_assignee_id: assigneeId ? String(assigneeId) : null,
      productive_creator_id: creatorId ? String(creatorId) : null,
      project_id: project?.id ?? null,
      client_id: project?.client_id ?? null,
      client_name: project?.client_name ?? null,
      title: a.title ?? a.name ?? 'Untitled task',
      description: a.description ?? a.note ?? null,
      task_number: a.task_number ?? null,
      status: isArchived ? 'archived' : isClosed ? 'closed' : 'open',
      workflow_status_name: wf?.name ?? a.workflow_status_name ?? null,
      workflow_status_category: wf?.category ?? a.workflow_status_category ?? null,
      priority: a.priority ?? null,
      due_date: a.due_date ?? null,
      start_date: a.start_date ?? null,
      closed_at: a.closed_at ?? null,
      is_closed: isClosed,
      is_archived: isArchived,
      task_list_name: a.task_list_name ?? null,
      assignee_name: (assigneeId ? people.get(String(assigneeId))?.name : null) ?? a.assignee_name ?? null,
      assignee_email: assigneeId ? people.get(String(assigneeId))?.email ?? null : null,
      creator_name: creatorId ? people.get(String(creatorId))?.name ?? null : null,
      estimated_minutes: num(a.initial_estimate ?? a.estimated_time) || null,
      worked_minutes: num(a.worked_time) || null,
      remaining_minutes: num(a.remaining_time) || null,
      tags: Array.isArray(a.tag_list) ? a.tag_list : [],
      raw_json: { ...a, _relationships: r },
      last_synced_at: new Date().toISOString(),
    }
  })
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await sb.from('productive_tasks').upsert(rows.slice(i, i + 500), { onConflict: 'productive_id' })
    if (error) throw error
  }
  const finished = new Date().toISOString()
  await sb.from('productive_sync_runs').insert({
    entity_type: entity, status: 'success', records_fetched: data.length, records_upserted: rows.length,
    records_failed: 0, duration_ms: Date.now() - start, finished_at: finished,
  })
  return { skipped: false, refreshed_at: finished, tasks: rows.length }
}


// ---- Comments and links: the approved copy is often a comment on the brief or a subtask, or a Google Sheet ----
// linked in the description or a comment (the account manager then says which version is approved).
const URL_RE = /https?:\/\/[^\s"'<>\]]+/g
const linksOf = (html: string) => [...new Set([...html.replace(/&amp;/g, '&').matchAll(URL_RE)].map((m) => m[0].replace(/[.,;)]+$/, '')))]
// Keeps the mentioned person's name ("@Ana: odobrena verzija 2"), unlike the brief parser.
const commentText = (html: string) =>
  toLines(html.replace(/@\[\{.*?\}\]/g, (m) => {
    try { return '@' + (JSON.parse(m.slice(2, -1)).label ?? '') } catch { return ' ' }
  })).join('\n')

async function taskComments(briefTaskId: string, description: string) {
  const subtasks = await productiveList(`/tasks?filter[parent_task_id]=${briefTaskId}`).catch(() => [])
  const tasks = [{ id: briefTaskId, title: null as string | null, description: null as string | null }, ...subtasks.map((t) => ({ id: String(t.id), title: t.attributes?.title ?? null, description: t.attributes?.description ?? null }))]
  const comments: Record<string, unknown>[] = []
  for (const t of tasks) {
    const r = await fetch(`${PRODUCTIVE}/comments?filter[task_id]=${t.id}&include=creator&page[size]=200`, { headers: productiveHeaders(), signal: AbortSignal.timeout(30000) })
    if (!r.ok) throw new Error(`Productive /comments HTTP ${r.status}`)
    const j = await r.json()
    const people = new Map<string, string>()
    for (const inc of j.included ?? []) {
      const a = inc.attributes ?? {}
      if (inc.type === 'people') people.set(String(inc.id), a.name ?? ([a.first_name, a.last_name].filter(Boolean).join(' ') || ''))
    }
    for (const c of j.data ?? []) {
      const a = c.attributes ?? {}
      if (a.deleted_at || !a.body) continue
      const creator = c.relationships?.creator?.data?.id
      comments.push({
        id: String(c.id), task_id: t.id, task_title: t.title, from_subtask: t.id !== briefTaskId,
        author: creator ? people.get(String(creator)) ?? null : null, created_at: a.created_at ?? null,
        text: commentText(a.body), links: linksOf(a.body),
      })
    }
  }
  comments.sort((x, y) => String(x.created_at).localeCompare(String(y.created_at)))
  return {
    description_links: linksOf(description),
    subtasks: tasks.slice(1).map((t) => ({ task_id: t.id, title: t.title, text: t.description ? commentText(t.description) : null, links: t.description ? linksOf(t.description) : [] })),
    comments,
  }
}

type AttRow = { productive_id: string; task_productive_id: string; brief_task_productive_id: string | null; task_title: string | null; comment_productive_id: string | null; name: string | null; content_type: string | null; size_bytes: number | null; source_url: string | null; source_created_at: string | null }
const ATT_COLS = 'productive_id, task_productive_id, brief_task_productive_id, task_title, comment_productive_id, name, content_type, size_bytes, source_url, source_created_at'

async function present(r: AttRow) {
  const isImage = (r.content_type ?? '').startsWith('image/')
  return {
    id: r.productive_id,
    task_id: r.task_productive_id,
    task_title: r.task_title,
    from_subtask: r.task_productive_id !== r.brief_task_productive_id,
    in_comment: !!r.comment_productive_id,
    name: r.name,
    content_type: r.content_type,
    size_bytes: r.size_bytes,
    created_at: r.source_created_at,
    url: await fileLink(r.productive_id, 'original'),
    thumb_url: isImage ? await fileLink(r.productive_id, 'thumb') : null,
    // Opens with the viewer's own Productive login.
    productive_url: r.source_url,
  }
}

async function listAttachments(briefTaskId: string) {
  const { data, error } = await sb.from('productive_task_attachments').select(ATT_COLS).eq('brief_task_productive_id', briefTaskId).order('source_created_at', { ascending: true })
  if (error) throw error
  return Promise.all(((data ?? []) as AttRow[]).map(present))
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  try {
    const key = req.headers.get('x-api-key') ?? ''
    if (!key) return json({ error: 'missing x-api-key' }, 401)
    const { data: k } = await sb.from('external_api_keys').select('id').eq('key_sha256', await sha256(key)).eq('scope', SCOPE).eq('active', true).maybeSingle()
    if (!k) return json({ error: 'invalid key' }, 403)

    const body = await req.json().catch(() => ({}))
    const action = body.action ?? 'briefs'

    if (action === 'projects') {
      const { data, error } = await sb.from('productive_projects').select('productive_id, name, client_name, is_archived').eq('is_archived', false).order('name')
      if (error) throw error
      return json({ projects: data })
    }

    if (action === 'refresh_project') {
      const projectId = String(body.project_id ?? '')
      if (!/^\d+$/.test(projectId)) return json({ error: 'project_id je obavezan' }, 400)
      const { data: p } = await sb.from('productive_projects').select('productive_id').eq('productive_id', projectId).maybeSingle()
      if (!p) return json({ error: 'nepoznat projekat' }, 404)
      return json(await refreshProjectTasks(projectId))
    }

    if (action === 'briefs') {
      const sinceDays = Math.min(Number(body.since_days) || 120, 400)
      const limit = Math.min(Number(body.limit) || 40, 100)
      const since = new Date(Date.now() - sinceDays * 864e5).toISOString()
      let q = sb
        .from('productive_tasks')
        .select('productive_id, productive_project_id, title, description, created_at, due_date, workflow_status_name, is_closed, client_name')
        .or('description.ilike.%TRAJANJE AKCIJE%,description.ilike.%HEADLINE - NAZIV AKCIJE%,description.ilike.%LEGAL LINE%,description.ilike.%akcija važi%,description.ilike.%ponuda važi%,title.ilike.%akcij%,title.ilike.%sale%,title.ilike.%halloween%,title.ilike.%black friday%,title.ilike.%popust%')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(limit)
      if (body.project_id) q = q.eq('productive_project_id', String(body.project_id))
      const { data: tasks, error } = await q
      if (error) throw error
      const projIds = [...new Set((tasks ?? []).map((t) => t.productive_project_id))]
      const { data: projs } = await sb.from('productive_projects').select('productive_id, name').in('productive_id', projIds.length ? projIds : ['-'])
      const projName = new Map((projs ?? []).map((p) => [p.productive_id, p.name]))
      const taskIds = (tasks ?? []).map((t) => t.productive_id)
      const { data: atts } = await sb.from('productive_task_attachments').select('brief_task_productive_id').in('brief_task_productive_id', taskIds.length ? taskIds : ['-'])
      const attCount = new Map<string, number>()
      for (const a of atts ?? []) attCount.set(a.brief_task_productive_id, (attCount.get(a.brief_task_productive_id) ?? 0) + 1)
      const briefs = (tasks ?? []).map((t) => ({
        task_id: t.productive_id,
        task_url: `https://app.productive.io/2006-loft-19-d-o-o/tasks/${t.productive_id}`,
        title: t.title,
        project_id: t.productive_project_id,
        project_name: projName.get(t.productive_project_id) ?? null,
        client_name: t.client_name,
        created_at: t.created_at,
        due_date: t.due_date,
        status: t.workflow_status_name,
        is_closed: t.is_closed,
        attachment_count: attCount.get(t.productive_id) ?? null,
        ...parseBrief(t.description ?? '', t.created_at),
      }))
      // Not briefs for paid campaigns: newsletters, stories, rules. Undated tasks only while recent (a brief may still
      // be in its comments). Running and upcoming actions first (soonest start), then past ones (latest first).
      const today = new Date().toISOString().slice(0, 10)
      const recent = new Date(Date.now() - 30 * 864e5).toISOString()
      const keep = briefs.filter((b) => !/(\bNL\b|newsletter|story|stori|pravilnik)/i.test(b.title ?? '') && (b.start_date || (b.created_at ?? '') >= recent))
      const live = (b: { start_date: string | null; end_date: string | null }) => !!b.start_date && (b.end_date ?? b.start_date) >= today
      keep.sort((x, y) => {
        if (live(x) !== live(y)) return live(x) ? -1 : 1
        if (live(x)) return String(x.start_date).localeCompare(String(y.start_date))
        if (!x.start_date !== !y.start_date) return x.start_date ? 1 : -1
        return String(y.start_date ?? y.created_at).localeCompare(String(x.start_date ?? x.created_at))
      })
      return json({ briefs: keep })
    }

    if (action === 'attachments') {
      const taskId = String(body.task_id ?? '')
      if (!/^\d+$/.test(taskId)) return json({ error: 'task_id je obavezan' }, 400)
      // Only tasks already synced into productive_tasks can be pulled through this key.
      const { data: t } = await sb.from('productive_tasks').select('productive_id').eq('productive_id', taskId).maybeSingle()
      if (!t) return json({ error: 'nepoznat task' }, 404)
      const sync = body.sync === false ? null : await syncTaskAttachments(taskId)
      return json({ task_id: taskId, sync, attachments: await listAttachments(taskId) })
    }

    // Comment text (read-only; nothing is written to Productive).
    if (action === 'comments') {
      const taskId = String(body.task_id ?? '')
      if (!/^\d+$/.test(taskId)) return json({ error: 'task_id je obavezan' }, 400)
      const { data: t } = await sb.from('productive_tasks').select('productive_id, description').eq('productive_id', taskId).maybeSingle()
      if (!t) return json({ error: 'nepoznat task' }, 404)
      return json({ task_id: taskId, ...(await taskComments(taskId, t.description ?? '')) })
    }

    // Fresh links for attachments chosen earlier (e.g. images saved in a draft, exported days later).
    if (action === 'file_urls') {
      const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((x: string) => /^\d+$/.test(x)).slice(0, 100)
      if (!ids.length) return json({ files: [] })
      const { data, error } = await sb.from('productive_task_attachments').select(ATT_COLS).in('productive_id', ids)
      if (error) throw error
      return json({ files: await Promise.all(((data ?? []) as AttRow[]).map(present)) })
    }

    return json({ error: `unknown action ${action}` }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
