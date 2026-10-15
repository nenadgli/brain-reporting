import { supabase } from './supabase'
import { downloadText } from './creatives'
import { logAction, type TaskKey } from './ppcTasks'

// Ready account changes (ppc_changes): what Brain proposes, the team approves, and today goes to Google
// Ads Editor as a file. With the Google Ads API the approved rows will be sent directly instead.

export type Change = {
  id: string; client_id: string; task: string; finding_id: string | null
  kind: 'negative_keyword' | 'placement_exclusion' | 'daily_budget'; network: 'google' | 'meta'
  campaign: string | null; target: string | null; match_type: string | null; old_amount: number | null; new_amount: number | null
  reason: string | null; details: Record<string, unknown>; status: 'predlog' | 'odobreno' | 'odbijeno' | 'izvezeno' | 'poslato' | 'greska' | 'isteklo'
  comment: string | null; created_at: string; exported_at: string | null
}

const money = (n: number | null, cur: string) => (n == null ? '—' : `${Number(n).toLocaleString('sr-RS', { maximumFractionDigits: 2 })} ${cur}`)

// One plain sentence per change.
export function describeChange(c: Change, cur: string): string {
  if (c.kind === 'negative_keyword') return `Negativna reč „${c.target}“ (${(c.match_type ?? 'Exact').toLowerCase()}) u kampanji ${c.campaign}`
  if (c.kind === 'placement_exclusion') return `Isključiti plasman ${String(c.details.name ?? c.target)}`
  return `${c.network === 'meta' ? 'Meta' : 'Google'} dnevni budžet „${c.campaign}“: ${money(c.old_amount, cur)} → ${money(c.new_amount, cur)}`
}

export async function setChangeStatus(ids: string[], status: 'odobreno' | 'odbijeno' | 'predlog', comment: string | null) {
  if (!ids.length) return null
  const { data: u } = await supabase.auth.getUser()
  const { error } = await supabase.from('ppc_changes').update({
    status, comment, decided_by: status === 'predlog' ? null : u.user?.id ?? null, decided_at: status === 'predlog' ? null : new Date().toISOString(),
  }).in('id', ids)
  return error
}

const esc = (v: unknown) => { const s = v == null ? '' : String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s }
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// Everything approved for one client: an Editor CSV (negatives and Google daily budgets), the account
// placement exclusion list and Meta budgets. Marks the rows as exported. Returns a message for the user.
export async function exportApproved(clientId: string, clientName: string, list: Change[]): Promise<{ ok: boolean; text: string }> {
  if (!list.length) return { ok: false, text: 'Nema odobrenih izmena.' }
  const name = slug(clientName || 'klijent')
  const day = new Date().toISOString().slice(0, 10)
  const editor = list.filter((c) => c.kind === 'negative_keyword' || (c.kind === 'daily_budget' && c.network === 'google'))
  if (editor.length) {
    const lines = ['Campaign,Budget,Keyword,Criterion Type,Status', ...editor.map((c) => c.kind === 'negative_keyword'
      ? [esc(c.campaign), '', esc(c.target), `Campaign Negative ${c.match_type ?? 'Exact'}`, 'Enabled'].join(',')
      : [esc(c.campaign), Number(c.new_amount).toFixed(2), '', '', ''].join(','))]
    downloadText(`izmene_${name}_${day}_editor.csv`, lines.join('\r\n') + '\r\n')
  }
  const pl = list.filter((c) => c.kind === 'placement_exclusion')
  if (pl.length) downloadText(`izmene_${name}_${day}_iskljuceni-plasmani.csv`, ['Placement,Name,Type', ...pl.map((c) => [esc(c.target), esc(c.details.name), esc(c.details.type)].join(','))].join('\r\n') + '\r\n')
  const meta = list.filter((c) => c.kind === 'daily_budget' && c.network === 'meta')
  if (meta.length) downloadText(`izmene_${name}_${day}_meta-budzeti.csv`, ['Campaign,Daily budget', ...meta.map((c) => [esc(c.campaign), Number(c.new_amount).toFixed(2)].join(','))].join('\r\n') + '\r\n')
  const { error } = await supabase.from('ppc_changes').update({ status: 'izvezeno', exported_at: new Date().toISOString(), export_batch: crypto.randomUUID() }).in('id', list.map((c) => c.id))
  if (error) return { ok: false, text: error.message }
  for (const t of [...new Set(list.map((c) => c.task))]) logAction(clientId, t as TaskKey, 'editor_csv', `${list.filter((c) => c.task === t).length} odobrenih izmena izvezeno`)
  const parts = [editor.length && 'Editor: Import → From file → proveri → Post', pl.length && 'plasmani: Google Ads → Alati → Liste isključenja', meta.length && 'Meta budžeti ručno'].filter(Boolean)
  return { ok: true, text: `Preuzeto ${list.length} izmena. ${parts.join('; ')}.` }
}
