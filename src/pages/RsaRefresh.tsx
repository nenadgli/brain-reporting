import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { downloadText } from '../lib/creatives'
import { logAction } from '../lib/ppcTasks'

// "Osvežavanje Search oglasa": responsive search ads that need work (Ad Strength Poor/Average,
// assets Google labels LOW, too few assets), new texts from Claude for the ones the team picks, and a
// Google Ads Editor CSV that adds each refreshed ad as a new Paused ad next to the old one.

type Candidate = {
  ad_id: string; campaign: string; ad_group: string; ad_strength: string | null; n_headlines: number; n_descriptions: number
  low_headlines: string[]; low_descriptions: string[]; best_assets: string[]; reasons: string[]
  impressions: number; clicks: number; ctr: number | null; spend: number; conversions: number; roas: number | null; snapshot_date: string
}
type Asset = { text: string; pin: number | null; source: 'kept' | 'new'; replaces: string | null }
type Draft = {
  id: string; ad_id: string; campaign: string; ad_group: string; final_url: string; path1: string | null; path2: string | null
  headlines: Asset[]; descriptions: Asset[]; reasons: string[]; rationale: string | null; status: 'draft' | 'exported' | 'rejected'; created_at: string
}

const REASON: Record<string, string> = { ad_strength: 'slab Ad Strength', low_assets: 'LOW asseti', malo_asseta: 'malo asseta' }
const STRENGTH: Record<string, string> = { POOR: 'Poor', AVERAGE: 'Average', GOOD: 'Good', EXCELLENT: 'Excellent', PENDING: 'Pending' }
const n0 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('sr-RS', { maximumFractionDigits: 0 }))
const n2 = (v: number | null | undefined) => (v == null ? '—' : Number(v).toLocaleString('sr-RS', { maximumFractionDigits: 2 }))
const visibleLen = (s: string) => s.replace(/\{key[wW]ord:([^}]*)\}/gi, '$1').length
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

export default function RsaRefresh({ clientId, clientName }: { clientId: string; clientName: string }) {
  const [cands, setCands] = useState<Candidate[]>([])
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [picked, setPicked] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<'' | 'draft' | 'export'>('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  async function load() {
    if (!clientId) return
    setLoading(true)
    const [c, d] = await Promise.all([
      supabase.rpc('rsa_refresh_candidates', { p_client_id: clientId }),
      supabase.from('rsa_refresh_drafts').select('*').eq('client_id', clientId).in('status', ['draft', 'exported']).order('created_at', { ascending: false }).limit(30),
    ])
    setLoading(false)
    if (c.error) { setMessage({ kind: 'err', text: c.error.message }); return }
    setCands((c.data ?? []) as Candidate[])
    setDrafts((d.data ?? []) as Draft[])
  }
  useEffect(() => { setPicked([]); setMessage(null); load() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= 5 ? p : [...p, id]))
  }

  async function draft() {
    setBusy('draft'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('rsa-refresh', { body: { action: 'draft', client_id: clientId, ad_ids: picked } })
    setBusy('')
    if (error || data?.error) { setMessage({ kind: 'err', text: data?.error ?? error?.message ?? 'Greška' }); return }
    const res = (data.results ?? []) as { ad_id: string; draft?: Draft; skipped?: string; error?: string }[]
    const ok = res.filter((r) => r.draft).length
    const notes = res.filter((r) => !r.draft).map((r) => `${cands.find((c) => c.ad_id === r.ad_id)?.ad_group ?? r.ad_id}: ${r.skipped ?? r.error}`)
    if (ok) logAction(clientId, 'osvezavanje_oglasa', 'nacrt', `Novi tekstovi za ${ok} Search oglasa`)
    setMessage({ kind: ok ? 'ok' : 'err', text: `Nacrta: ${ok}.${notes.length ? ` ${notes.join(' · ')}` : ''}` })
    setPicked([])
    load()
  }

  async function exportCsv(ids?: string[]) {
    setBusy('export'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('rsa-refresh', { body: { action: 'export', client_id: clientId, ...(ids ? { draft_ids: ids } : {}) } })
    setBusy('')
    if (error || data?.error) { setMessage({ kind: 'err', text: data?.error ?? error?.message ?? 'Greška' }); return }
    downloadText(`osvezeni-search-oglasi_${slug(clientName)}_${new Date().toISOString().slice(0, 10)}.csv`, data.csv)
    logAction(clientId, 'osvezavanje_oglasa', 'editor_csv', `Editor CSV za ${data.count} osvežen${data.count === 1 ? 'i' : 'ih'} Search oglas${data.count === 1 ? '' : 'a'}`)
    setMessage({ kind: 'ok', text: `Preuzet CSV za ${data.count} oglasa. U Editoru: Import → From file → svaki oglas ulazi kao nov Paused oglas u istoj ad grupi. Posle provere uključi novi i pauziraj stari.` })
    load()
  }

  async function reject(id: string) {
    const { error } = await supabase.from('rsa_refresh_drafts').update({ status: 'rejected' }).eq('id', id)
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    logAction(clientId, 'osvezavanje_oglasa', 'odbijeno', 'Nacrt osveženog oglasa odbačen')
    load()
  }

  function editText(d: Draft, field: 'headlines' | 'descriptions', i: number, text: string) {
    const list = d[field].map((a, j) => (j === i ? { ...a, text } : a))
    setDrafts((all) => all.map((x) => (x.id === d.id ? { ...x, [field]: list } : x)))
  }
  async function saveDraft(d: Draft) {
    const bad = [...d.headlines.filter((a) => visibleLen(a.text) > 30), ...d.descriptions.filter((a) => visibleLen(a.text) > 90)]
    if (bad.length) { setMessage({ kind: 'err', text: `Predugačko: ${bad.map((a) => a.text).join('; ')}` }); return }
    const { error } = await supabase.from('rsa_refresh_drafts').update({ headlines: d.headlines, descriptions: d.descriptions }).eq('id', d.id)
    setMessage(error ? { kind: 'err', text: error.message } : { kind: 'ok', text: 'Izmene sačuvane.' })
  }

  const openDrafts = drafts.filter((d) => d.status === 'draft')

  return (
    <div>
      <p className="mb-6 max-w-3xl text-sm text-[var(--color-ink-soft)]">
        Oglasi iz poslednje nedeljne sinhronizacije koji troše, a imaju slab Ad Strength, assete koje Google ocenjuje kao LOW ili manje od 10 naslova i 4 opisa.
        Izaberi do 5 oglasa: Brain zadržava naslove i opise koji nisu LOW (sa pinovima), menja LOW i dopunjava do 15 naslova i 4 opisa, na jeziku i u stilu postojećeg oglasa.
        Novi oglas ulazi kao <b>Paused</b> pored starog.
      </p>

      {message && (
        <p className={`mb-6 rounded px-4 py-2 text-sm ${message.kind === 'ok' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-red-50 text-[var(--color-rust)]'}`}>{message.text}</p>
      )}
      {loading && <p className="mb-4 text-sm text-[var(--color-ink-soft)]">Učitavam…</p>}

      <section className="mb-10">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-display text-xl font-medium">Oglasi za osvežavanje</h2>
          <span className="text-sm text-[var(--color-ink-soft)]">{cands.length}{cands[0] ? ` · podaci od ${cands[0].snapshot_date}` : ''}</span>
          <button onClick={draft} disabled={!picked.length || !!busy} className="ml-auto rounded bg-[var(--color-indigo)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40">
            {busy === 'draft' ? 'Pišem tekstove…' : `Predloži nove tekstove${picked.length ? ` (${picked.length})` : ''}`}
          </button>
        </div>
        <div className="overflow-x-auto rounded border border-[var(--color-line)] bg-white">
          <table className="w-full text-xs">
            <thead className="bg-[var(--color-paper)] text-left text-[var(--color-ink-soft)]">
              <tr>
                <th className="px-3 py-2"></th>
                <th className="px-2">Kampanja · ad grupa</th>
                <th className="px-2">Razlog</th>
                <th className="px-2">Ad Strength</th>
                <th className="px-2 text-right">Naslova / opisa</th>
                <th className="px-2">LOW</th>
                <th className="px-2 text-right">Potrošnja 30d</th>
                <th className="px-2 text-right">CTR</th>
                <th className="px-2 text-right">Konv.</th>
                <th className="px-2 text-right">ROAS</th>
              </tr>
            </thead>
            <tbody>
              {cands.map((c) => (
                <tr key={c.ad_id} className="border-t border-[var(--color-line)] align-top">
                  <td className="px-3 py-1.5"><input type="checkbox" checked={picked.includes(c.ad_id)} onChange={() => toggle(c.ad_id)} disabled={!picked.includes(c.ad_id) && picked.length >= 5} /></td>
                  <td className="px-2 py-1.5">{c.campaign}<span className="block text-[var(--color-ink-soft)]">{c.ad_group}</span></td>
                  <td className="px-2 py-1.5">{c.reasons.map((r) => REASON[r] ?? r).join(', ')}</td>
                  <td className="px-2 py-1.5">{STRENGTH[c.ad_strength ?? ''] ?? c.ad_strength ?? '—'}</td>
                  <td className="px-2 py-1.5 text-right">{c.n_headlines} / {c.n_descriptions}</td>
                  <td className="max-w-xs px-2 py-1.5 text-[var(--color-ink-soft)]">{[...c.low_headlines, ...c.low_descriptions].join(' · ') || '—'}</td>
                  <td className="px-2 py-1.5 text-right">{n0(c.spend)}</td>
                  <td className="px-2 py-1.5 text-right">{c.ctr == null ? '—' : `${n2(c.ctr)}%`}</td>
                  <td className="px-2 py-1.5 text-right">{n2(c.conversions)}</td>
                  <td className="px-2 py-1.5 text-right">{n2(c.roas)}</td>
                </tr>
              ))}
              {!cands.length && !loading && <tr><td colSpan={10} className="px-3 py-4 text-sm text-[var(--color-ink-soft)]">Nema oglasa za osvežavanje (ili Search oglasi još nisu sinhronizovani; sinhronizacija ide ponedeljkom).</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="font-display text-xl font-medium">Nacrti</h2>
          <button onClick={() => exportCsv(openDrafts.map((d) => d.id))} disabled={!openDrafts.length || !!busy} className="ml-auto rounded border border-[var(--color-indigo)] px-4 py-1.5 text-sm text-[var(--color-indigo-dark)] disabled:opacity-40">
            {busy === 'export' ? 'Pravim CSV…' : `Editor CSV za nove nacrte (${openDrafts.length})`}
          </button>
        </div>
        <div className="space-y-6">
          {drafts.map((d) => (
            <div key={d.id} className="rounded border border-[var(--color-line)] bg-white p-4">
              <div className="mb-2 flex flex-wrap items-baseline gap-2">
                <span className="text-sm font-medium">{d.campaign} · {d.ad_group}</span>
                <span className={`rounded px-2 py-0.5 text-xs ${d.status === 'exported' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-amber-50 text-amber-800'}`}>{d.status === 'exported' ? 'izvezeno' : 'nacrt'}</span>
                <span className="text-xs text-[var(--color-ink-soft)]">{new Date(d.created_at).toLocaleDateString('sr-Latn-RS')}</span>
                <span className="ml-auto flex gap-2 text-xs">
                  <button onClick={() => saveDraft(d)} className="rounded border border-[var(--color-line)] px-2 py-0.5">Sačuvaj izmene</button>
                  <button onClick={() => exportCsv([d.id])} disabled={!!busy} className="rounded border border-[var(--color-line)] px-2 py-0.5">CSV</button>
                  <button onClick={() => reject(d.id)} className="rounded border border-[var(--color-line)] px-2 py-0.5 text-[var(--color-rust)]">Odbaci</button>
                </span>
              </div>
              {d.rationale && <p className="mb-3 text-xs text-[var(--color-ink-soft)]">{d.rationale}</p>}
              <div className="grid gap-4 md:grid-cols-2">
                {(['headlines', 'descriptions'] as const).map((f) => (
                  <div key={f}>
                    <p className="mb-1 text-xs font-medium">{f === 'headlines' ? 'Naslovi (max 30)' : 'Opisi (max 90)'}</p>
                    <ul className="space-y-1">
                      {d[f].map((a, i) => {
                        const len = visibleLen(a.text), max = f === 'headlines' ? 30 : 90
                        return (
                          <li key={i} className="flex items-center gap-2 text-xs">
                            <span className={`w-10 shrink-0 rounded px-1 text-center ${a.source === 'new' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-[var(--color-paper)] text-[var(--color-ink-soft)]'}`}>{a.source === 'new' ? 'novo' : 'ostaje'}</span>
                            <input value={a.text} onChange={(e) => editText(d, f, i, e.target.value)} disabled={d.status !== 'draft'}
                              title={a.replaces ? `Menja LOW: ${a.replaces}` : undefined}
                              className={`flex-1 rounded border px-2 py-0.5 ${len > max ? 'border-red-400' : 'border-[var(--color-line)]'}`} />
                            <span className={`w-6 text-right ${len > max ? 'text-[var(--color-rust)]' : 'text-[var(--color-ink-soft)]'}`}>{len}</span>
                            {a.pin && <span className="text-[var(--color-ink-soft)]" title="Pinovano na poziciju">📌{a.pin}</span>}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {!drafts.length && <p className="text-sm text-[var(--color-ink-soft)]">Još nema nacrta.</p>}
        </div>
      </section>
    </div>
  )
}
