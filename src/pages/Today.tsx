import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { logAction, type TaskKey } from '../lib/ppcTasks'
import { type Change, describeChange, exportApproved, setChangeStatus } from '../lib/changes'
import { Evidence, SettingsPanel, type ClientOpt, type Finding, type Params } from './MorningReview'
import WeekPlan from './WeekPlan'

// "Danas": everything Brain checked for a client this morning (and the weekly checks), grouped by area.
// Each finding shows the ready account changes under it; the team approves, rejects (with a reason) or
// postpones, and downloads everything approved for Google Ads Editor in one go. Comments teach Brain.

type F = Finding & { run_date: string }
type Area = { key: string; label: string; checks: string[] }
const AREAS: Area[] = [
  { key: 'budget', label: 'Budžet', checks: ['pacing', 'campaign_budgets', 'meta_cap'] },
  { key: 'perf', label: 'Trošak i rezultati', checks: ['spend_anomaly', 'spend_stopped', 'roas_low', 'conv_drop', 'tracking', 'data'] },
  { key: 'terms', label: 'Search termini', checks: ['search_terms'] },
  { key: 'placements', label: 'Plasmani', checks: ['placements'] },
  { key: 'ads', label: 'Oglasi i preporuke', checks: ['ads_policy', 'recommendations'] },
  { key: 'products', label: 'Proizvodi i feed', checks: ['product_spend_no_sale', 'product_meta_no_sale', 'product_no_ads', 'product_gone_spending', 'product_price_drop', 'feed_wave'] },
  { key: 'actions', label: 'Akcije iz Productive-a', checks: ['brief_prep', 'brief_ended'] },
  { key: 'ga4', label: 'GA4 i tracking', checks: ['ga4_gap', 'ga4_tracking'] },
]
const areaOf = (check: string) => AREAS.find((a) => a.checks.includes(check)) ?? { key: 'other', label: 'Ostalo', checks: [] }
// History keeps the old task keys so the work log stays comparable.
const TASK_OF: Record<string, TaskKey> = {
  pacing: 'provera_budzeta', campaign_budgets: 'provera_budzeta', meta_cap: 'provera_budzeta', search_terms: 'search_terms', ads_policy: 'disapproved',
  recommendations: 'recommendations', placements: 'placements', ga4_tracking: 'ga4',
}
const taskOf = (check: string): TaskKey => TASK_OF[check] ?? (check.startsWith('product_') || check === 'feed_wave' ? 'proizvodi' : 'provera_naloga')
const DOT: Record<F['severity'], string> = { hitno: 'bg-red-500', visoko: 'bg-orange-500', srednje: 'bg-amber-400', info: 'bg-slate-300' }
const SEV_LABEL: Record<F['severity'], string> = { hitno: 'Hitno', visoko: 'Važno', srednje: 'Srednje', info: 'Info' }
const SEV_ORDER: Record<F['severity'], number> = { hitno: 0, visoko: 1, srednje: 2, info: 3 }
const STATUS_TEXT: Record<string, string> = { odobreno: 'Odobreno', odbijeno: 'Odbijeno', odlozeno: 'Kasnije', izvrseno: 'Urađeno' }

const weekAgo = () => new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10)

export default function Today() {
  const [clients, setClients] = useState<ClientOpt[]>([])
  const [counts, setCounts] = useState<Record<string, { open: number; urgent: number; approved: number }>>({})
  const [clientId, setClientId] = useState('')
  const [findings, setFindings] = useState<F[]>([])
  const [changes, setChanges] = useState<Change[]>([])
  const [comments, setComments] = useState<Record<string, string>>({})
  const [unchecked, setUnchecked] = useState<Record<string, boolean>>({})
  const [lastRun, setLastRun] = useState<{ run_date: string; data_date: string | null; status: string; finished_at: string | null } | null>(null)
  const [showDone, setShowDone] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [busy, setBusy] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  async function loadOverview() {
    const [{ data: cl }, { data: fo }, { data: ch }] = await Promise.all([
      supabase.from('review_settings').select('client_id, params, clients(name)').eq('enabled', true),
      supabase.from('review_findings').select('client_id, severity').eq('status', 'novo').gte('run_date', weekAgo()),
      supabase.from('ppc_changes').select('client_id, status').in('status', ['predlog', 'odobreno']),
    ])
    const list = ((cl ?? []) as unknown as ClientOpt[]).sort((a, b) => (a.clients?.name ?? '').localeCompare(b.clients?.name ?? ''))
    const c: Record<string, { open: number; urgent: number; approved: number }> = {}
    for (const f of fo ?? []) {
      const x = (c[f.client_id] ??= { open: 0, urgent: 0, approved: 0 })
      x.open++
      if (f.severity === 'hitno' || f.severity === 'visoko') x.urgent++
    }
    for (const r of ch ?? []) if (r.status === 'odobreno') (c[r.client_id] ??= { open: 0, urgent: 0, approved: 0 }).approved++
    setCounts(c)
    // Clients with the most urgent work first.
    list.sort((a, b) => (c[b.client_id]?.urgent ?? 0) - (c[a.client_id]?.urgent ?? 0) || (c[b.client_id]?.open ?? 0) - (c[a.client_id]?.open ?? 0) || (a.clients?.name ?? '').localeCompare(b.clients?.name ?? ''))
    setClients(list)
    if (!clientId && list.length) setClientId(list[0].client_id)
  }
  useEffect(() => { loadOverview() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  async function loadClient() {
    if (!clientId) return
    const cols = 'id, check_type, severity, impact_eur, title, detail, proposal, evidence, rank, status, decision_reason, decided_at, run_date'
    const [{ data: fs }, { data: ch }, { data: run }] = await Promise.all([
      supabase.from('review_findings').select(cols).eq('client_id', clientId).gte('run_date', weekAgo()).neq('status', 'isteklo').order('run_date', { ascending: false }).order('rank'),
      supabase.from('ppc_changes').select('*').eq('client_id', clientId).or(`status.in.(predlog,odobreno,greska),decided_at.gte.${weekAgo()}`).order('created_at', { ascending: false }).limit(2000),
      supabase.from('review_runs').select('run_date, data_date, status, finished_at').eq('client_id', clientId).order('started_at', { ascending: false }).limit(1),
    ])
    setFindings((fs ?? []) as F[])
    setChanges((ch ?? []) as Change[])
    setLastRun((run?.[0] ?? null) as typeof lastRun)
    setComments({}); setUnchecked({})
  }
  useEffect(() => { setMessage(null); setShowSettings(false); loadClient() }, [clientId]) // eslint-disable-line react-hooks/exhaustive-deps

  const client = clients.find((c) => c.client_id === clientId)
  const cur = String(client?.params?.currency ?? 'EUR')
  const open = findings.filter((f) => f.status === 'novo').sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity] || (b.impact_eur ?? 0) - (a.impact_eur ?? 0))
  const done = findings.filter((f) => f.status !== 'novo')
  const approved = changes.filter((c) => c.status === 'odobreno')
  // Proposals not tied to a finding (daily budgets).
  const loose = changes.filter((c) => c.status === 'predlog' && (!c.finding_id || !findings.some((f) => f.id === c.finding_id)))
  const grouped = useMemo(() => {
    const m = new Map<string, { area: Area; items: F[] }>()
    for (const f of open) {
      const a = areaOf(f.check_type)
      const g = m.get(a.key) ?? { area: a, items: [] }
      g.items.push(f)
      m.set(a.key, g)
    }
    return AREAS.map((a) => m.get(a.key)).filter(Boolean).concat(m.get('other') ? [m.get('other')!] : []) as { area: Area; items: F[] }[]
  }, [open])

  async function decide(f: F, status: 'odobreno' | 'odbijeno' | 'odlozeno') {
    const comment = (comments[f.id] ?? '').trim()
    if (status === 'odbijeno' && !comment) { setMessage({ kind: 'err', text: 'Za odbijanje napiši kratak razlog. Brain ga pamti i sledeći put ne predlaže isto.' }); return }
    setBusy(f.id)
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('review_findings').update({ status, decision_reason: comment || null, decided_by: u.user?.id ?? null, decided_at: new Date().toISOString() }).eq('id', f.id)
    const mine = changes.filter((c) => c.finding_id === f.id && c.status === 'predlog')
    if (!error && status === 'odobreno') {
      await setChangeStatus(mine.filter((c) => !unchecked[c.id]).map((c) => c.id), 'odobreno', comment || null)
      await setChangeStatus(mine.filter((c) => unchecked[c.id]).map((c) => c.id), 'odbijeno', comment || 'nije štiklirano pri odobravanju')
    }
    if (!error && status === 'odbijeno') await setChangeStatus(mine.map((c) => c.id), 'odbijeno', comment)
    setBusy('')
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    logAction(clientId, taskOf(f.check_type), status, f.title + (comment ? ` — ${comment}` : ''))
    await loadClient(); loadOverview()
  }

  async function decideLoose(status: 'odobreno' | 'odbijeno') {
    const comment = (comments.loose ?? '').trim()
    if (status === 'odbijeno' && !comment) { setMessage({ kind: 'err', text: 'Za odbijanje napiši kratak razlog.' }); return }
    const ids = loose.filter((c) => !unchecked[c.id]).map((c) => c.id)
    const err = await setChangeStatus(ids, status, comment || null)
    if (err) { setMessage({ kind: 'err', text: err.message }); return }
    logAction(clientId, 'optimizacija_budzeta', status, `${ids.length} predloga dnevnih budžeta`)
    await loadClient(); loadOverview()
  }

  async function undo(f: F) {
    await supabase.from('review_findings').update({ status: 'novo', decision_reason: null, decided_by: null, decided_at: null }).eq('id', f.id)
    const mine = changes.filter((c) => c.finding_id === f.id && (c.status === 'odobreno' || c.status === 'odbijeno'))
    await setChangeStatus(mine.map((c) => c.id), 'predlog', null)
    await loadClient(); loadOverview()
  }

  async function doExport() {
    const res = await exportApproved(clientId, client?.clients?.name ?? '', approved)
    setMessage({ kind: res.ok ? 'ok' : 'err', text: res.text })
    await loadClient(); loadOverview()
  }

  async function rerun() {
    setBusy('rerun'); setMessage(null)
    const { data, error } = await supabase.functions.invoke('morning-review', { body: { client_id: clientId } })
    await supabase.rpc('ppc_generate_changes', { p_client_id: clientId })
    setBusy('')
    const r = data?.results?.[0]
    setMessage(error || data?.error || r?.error ? { kind: 'err', text: `Provera nije uspela: ${data?.error ?? r?.error ?? error?.message}` } : { kind: 'ok', text: `Provera je završena: ${r?.findings ?? 0} nalaza.` })
    await loadClient(); loadOverview()
  }

  const totalOpen = Object.values(counts).reduce((n, c) => n + c.open, 0)

  return (
    <div className="flex gap-6">
      <aside className="w-60 shrink-0">
        <p className="mb-2 px-2 text-xs font-medium text-[var(--color-ink-soft)]">Klijenti · {totalOpen} otvorenih</p>
        <ul className="space-y-0.5">
          {clients.map((c) => {
            const x = counts[c.client_id]
            return (
              <li key={c.client_id}>
                <button onClick={() => setClientId(c.client_id)}
                  className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm ${clientId === c.client_id ? 'bg-white font-medium shadow-sm ring-1 ring-[var(--color-line)]' : 'hover:bg-white/70'}`}>
                  <span className="flex-1 truncate">{c.clients?.name}</span>
                  {x?.urgent ? <span className="h-2 w-2 rounded-full bg-orange-500" title={`${x.urgent} važnih`} /> : null}
                  {x?.open ? <span className="text-xs text-[var(--color-ink-soft)]">{x.open}</span> : <span className="text-xs text-emerald-600">✓</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="mb-6 flex flex-wrap items-center gap-3">
          <div className="flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{client?.clients?.name ?? 'Danas'}</h1>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">
              {lastRun ? <>Provera: {new Date(lastRun.finished_at ?? lastRun.run_date).toLocaleString('sr-Latn-RS', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}{lastRun.data_date ? ` · podaci do ${lastRun.data_date.slice(8, 10)}.${lastRun.data_date.slice(5, 7)}.` : ''}{lastRun.status === 'failed' ? ' · nije uspela' : ''}</> : 'Još nema provere'}
              {' · '}{open.length ? `${open.length} za odluku` : 'sve rešeno'}
            </p>
          </div>
          <button onClick={rerun} disabled={!!busy} className="btn-secondary">{busy === 'rerun' ? 'Proveravam…' : 'Proveri ponovo'}</button>
          <button onClick={() => setShowSettings(!showSettings)} className="btn-secondary">Podešavanja klijenta</button>
        </header>

        {showSettings && client && <div className="card mb-6 p-5"><SettingsPanel client={client} onSaved={(p: Params) => setClients(clients.map((c) => (c.client_id === clientId ? { ...c, params: p } : c)))} /></div>}

        {approved.length > 0 && (
          <div className="mb-6 flex flex-wrap items-center gap-3 rounded-xl bg-[var(--color-indigo)] px-5 py-3 text-white">
            <span className="text-sm"><b>{approved.length}</b> {approved.length % 10 === 1 && approved.length % 100 !== 11 ? 'odobrena izmena čeka' : 'odobrenih izmena čeka'} da uđe u nalog</span>
            <button onClick={doExport} className="ml-auto rounded-lg bg-white px-3 py-1.5 text-sm font-medium text-[var(--color-indigo-dark)]">Preuzmi za Google Ads Editor</button>
          </div>
        )}
        {message && <p className={`mb-6 rounded-lg px-4 py-2 text-sm ${message.kind === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{message.text}</p>}

        {clientId && <WeekPlan clientId={clientId} />}

        {!open.length && !loose.length && (
          <div className="card p-10 text-center">
            <p className="text-lg font-medium">Sve je pregledano</p>
            <p className="mt-1 text-sm text-[var(--color-ink-soft)]">Za ovog klijenta nema otvorenih nalaza ni predloga.</p>
          </div>
        )}

        {grouped.map(({ area, items }) => (
          <section key={area.key} className="mb-8">
            <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink-soft)]">{area.label} <span className="font-normal">· {items.length}</span></h2>
            <div className="space-y-3">
              {items.map((f) => {
                const mine = changes.filter((c) => c.finding_id === f.id && c.status === 'predlog')
                return (
                  <article key={f.id} className="card p-5">
                    <div className="flex items-start gap-3">
                      <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[f.severity]}`} title={SEV_LABEL[f.severity]} />
                      <div className="min-w-0 flex-1">
                        <h3 className="font-medium leading-snug">{f.title}</h3>
                        {f.detail && <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{f.detail}</p>}
                        {f.proposal && <p className="mt-2 text-sm"><span className="font-medium">Predlog:</span> {f.proposal}</p>}

                        {mine.length > 0 && (
                          <div className="mt-3 rounded-lg bg-[var(--color-paper)] p-3">
                            <p className="mb-2 text-xs font-medium text-[var(--color-ink-soft)]">Izmene za nalog ({mine.filter((c) => !unchecked[c.id]).length} od {mine.length}) · štiklirane se odobravaju</p>
                            <ul className="max-h-64 space-y-1 overflow-y-auto">
                              {mine.map((c) => (
                                <li key={c.id} className="flex items-start gap-2 text-sm">
                                  <input type="checkbox" className="mt-1" checked={!unchecked[c.id]} onChange={(e) => setUnchecked({ ...unchecked, [c.id]: !e.target.checked })} />
                                  <span>{describeChange(c, cur)}{c.reason ? <span className="block text-xs text-[var(--color-ink-soft)]">{c.reason}</span> : null}</span>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-[var(--color-ink-soft)]">Brojevi</summary>
                          <Evidence f={f} cur={cur} />
                        </details>

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <input value={comments[f.id] ?? ''} onChange={(e) => setComments({ ...comments, [f.id]: e.target.value })}
                            placeholder="Komentar (obavezan ako odbijaš)" className="input min-w-56 flex-1" />
                          <button onClick={() => decide(f, 'odobreno')} disabled={busy === f.id} className="btn-primary">Odobri{mine.length ? ` (${mine.filter((c) => !unchecked[c.id]).length})` : ''}</button>
                          <button onClick={() => decide(f, 'odbijeno')} disabled={busy === f.id} className="btn-secondary text-red-600">Odbij</button>
                          <button onClick={() => decide(f, 'odlozeno')} disabled={busy === f.id} className="btn-ghost" title="Nalaz se vraća za 3 dana ako problem i dalje postoji">Kasnije (3 dana)</button>
                        </div>
                      </div>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>
        ))}

        {loose.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-3 text-sm font-semibold text-[var(--color-ink-soft)]">{loose.every((c) => c.kind === 'daily_budget') ? 'Dnevni budžeti' : 'Ostale predložene izmene'} · {loose.length}</h2>
            <article className="card p-5">
              <ul className="space-y-1">
                {loose.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 text-sm">
                    <input type="checkbox" className="mt-1" checked={!unchecked[c.id]} onChange={(e) => setUnchecked({ ...unchecked, [c.id]: !e.target.checked })} />
                    <span>{describeChange(c, cur)}{c.reason ? <span className="block text-xs text-[var(--color-ink-soft)]">{c.reason}</span> : null}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <input value={comments.loose ?? ''} onChange={(e) => setComments({ ...comments, loose: e.target.value })} placeholder="Komentar (obavezan ako odbijaš)" className="input min-w-56 flex-1" />
                <button onClick={() => decideLoose('odobreno')} className="btn-primary">Odobri štiklirane</button>
                <button onClick={() => decideLoose('odbijeno')} className="btn-secondary text-red-600">Odbij štiklirane</button>
              </div>
            </article>
          </section>
        )}

        {done.length > 0 && (
          <section className="mb-8">
            <button onClick={() => setShowDone(!showDone)} className="mb-3 text-sm font-semibold text-[var(--color-ink-soft)]">
              {showDone ? '▾' : '▸'} Rešeno ove nedelje · {done.length}
            </button>
            {showDone && (
              <ul className="card divide-y divide-[var(--color-line)]">
                {done.map((f) => (
                  <li key={f.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                    <span className="w-20 shrink-0 text-xs text-[var(--color-ink-soft)]">{STATUS_TEXT[f.status] ?? f.status}</span>
                    <span className="flex-1">{f.title}{f.decision_reason ? <span className="block text-xs text-[var(--color-ink-soft)]">„{f.decision_reason}“</span> : null}</span>
                    <button onClick={() => undo(f)} className="text-xs text-[var(--color-ink-soft)] underline">vrati</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
