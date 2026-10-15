import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { TASKS, TASK_BY_KEY, type TaskKey } from '../lib/ppcTasks'

// "Urađeno": what the team did in Brain, grouped by the Productive task it replaces: decisions on
// review findings, budgets entered, campaign drafts drafted/exported/published, Editor CSVs downloaded.

type Entry = { at: string; client_id: string | null; client_name: string | null; task: TaskKey; action: string; detail: string | null; user_email: string | null }
type Client = { id: string; name: string }

const ACTION_LABEL: Record<string, string> = {
  odobreno: 'odobreno', odbijeno: 'odbijeno', odlozeno: 'odloženo', izvrseno: 'urađeno',
  budzet_unet: 'budžet unet', zavrseno: 'task završen', novo: 'čeka odluku', vraceno: 'vraćeno na odluku', nacrt: 'nacrt', izvezeno: 'izvezeno', objavljeno: 'objavljeno',
  editor_csv: 'Editor CSV', meta_csv: 'Meta CSV', izvestaj_csv: 'izveštaj preuzet', negativne_csv: 'negativne CSV', iskljucenja_csv: 'isključenja CSV',
}

const iso = (d: Date) => d.toISOString().slice(0, 10)
// Monday of the week that contains d.
function monday(d: Date) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7))
  return x
}
const fmtDay = (s: string) => new Date(s).toLocaleDateString('sr-Latn-RS', { weekday: 'short', day: 'numeric', month: 'numeric' })
const fmtTime = (s: string) => new Date(s).toLocaleTimeString('sr-Latn-RS', { hour: '2-digit', minute: '2-digit' })
const who = (e: string | null) => (e ? e.split('@')[0] : '—')

export default function WorkLog() {
  const [period, setPeriod] = useState<'this' | 'last' | 'four'>('this')
  const [clientId, setClientId] = useState('')
  const [clients, setClients] = useState<Client[]>([])
  const [entries, setEntries] = useState<Entry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const range = useMemo(() => {
    const thisMon = monday(new Date())
    const from = new Date(thisMon), to = new Date(thisMon)
    if (period === 'last') { from.setUTCDate(from.getUTCDate() - 7); to.setUTCDate(to.getUTCDate() - 1) }
    else if (period === 'four') { from.setUTCDate(from.getUTCDate() - 21); to.setUTCDate(to.getUTCDate() + 6) }
    else to.setUTCDate(to.getUTCDate() + 6)
    return { from: iso(from), to: iso(to) }
  }, [period])

  useEffect(() => {
    supabase.from('clients').select('id, name').order('name').then(({ data }) => setClients((data ?? []) as Client[]))
  }, [])

  useEffect(() => {
    setLoading(true); setError('')
    supabase.rpc('ppc_work_log', { p_from: range.from, p_to: range.to, p_client_id: clientId || null }).then(({ data, error: e }) => {
      setLoading(false)
      if (e) { setError(e.message); return }
      setEntries((data ?? []) as Entry[])
    })
  }, [range, clientId])

  // One task for one client on one day counts once toward time saved, however many clicks it took.
  const summary = useMemo(() => {
    const byTask: Record<string, { events: number; units: Set<string>; people: Set<string>; clients: Set<string> }> = {}
    for (const e of entries) {
      const s = (byTask[e.task] ??= { events: 0, units: new Set(), people: new Set(), clients: new Set() })
      s.events++
      s.units.add(`${e.client_id ?? 'all'}|${e.at.slice(0, 10)}`)
      if (e.user_email) s.people.add(who(e.user_email))
      if (e.client_name) s.clients.add(e.client_name)
    }
    const rows = TASKS.map((t) => ({ task: t, s: byTask[t.key] })).filter((r) => r.s)
    const minutes = rows.reduce((n, r) => n + r.s.units.size * r.task.minutes, 0)
    return { rows, minutes, people: new Set(entries.map((e) => who(e.user_email)).filter((x) => x !== '—')).size }
  }, [entries])

  const days = useMemo(() => {
    const m = new Map<string, Entry[]>()
    for (const e of entries) {
      const k = e.at.slice(0, 10)
      m.set(k, [...(m.get(k) ?? []), e])
    }
    return [...m.entries()]
  }, [entries])

  const inputCls = 'rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-line)] pb-6">
        <div>
          <h1 className="font-display text-4xl font-medium">Istorija</h1>
          <p className="mt-2 max-w-xl text-sm text-[var(--color-ink-soft)]">
            Šta je tim odlučio i uradio u Brain-u: odobrene i odbijene provere, izmene preuzete za Editor, budžeti i nacrti kampanja. Procena ušteđenog vremena računa jednu oblast po klijentu po danu.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3 text-sm">
          <div className="flex overflow-hidden rounded border border-[var(--color-line)]">
            {([['this', 'Ova nedelja'], ['last', 'Prošla nedelja'], ['four', 'Poslednje 4 nedelje']] as const).map(([k, l]) => (
              <button key={k} onClick={() => setPeriod(k)} className={`px-3 py-1.5 ${period === k ? 'bg-[var(--color-indigo)] text-white' : 'bg-white'}`}>{l}</button>
            ))}
          </div>
          <select value={clientId} onChange={(e) => setClientId(e.target.value)} className={inputCls}>
            <option value="">Svi klijenti</option>
            {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
      </header>

      {error && <p className="mb-6 rounded bg-red-50 px-4 py-2 text-sm text-[var(--color-rust)]">{error}</p>}
      {loading && <p className="mb-4 text-sm text-[var(--color-ink-soft)]">Učitavam…</p>}

      <section className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ['Period', `${range.from.slice(8, 10)}.${range.from.slice(5, 7)}. – ${range.to.slice(8, 10)}.${range.to.slice(5, 7)}.`],
          ['Akcija u Brain-u', String(entries.length)],
          ['Procena ušteđenog vremena', `${Math.floor(summary.minutes / 60)} h ${summary.minutes % 60} min`],
          ['Ljudi', String(summary.people)],
        ].map(([k, v]) => (
          <div key={k} className="rounded border border-[var(--color-line)] bg-white p-4">
            <p className="text-xs text-[var(--color-ink-soft)]">{k}</p>
            <p className="font-display mt-1 text-2xl">{v}</p>
          </div>
        ))}
      </section>

      <section className="mb-10 overflow-x-auto rounded border border-[var(--color-line)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-paper)] text-left text-xs text-[var(--color-ink-soft)]">
            <tr><th className="px-3 py-2">Oblast</th><th className="px-2 text-right">Akcija</th><th className="px-2 text-right">Klijent × dan</th><th className="px-2 text-right">Procena</th><th className="px-2">Klijenti</th><th className="px-2">Ko</th></tr>
          </thead>
          <tbody>
            {summary.rows.map(({ task, s }) => (
              <tr key={task.key} className="border-t border-[var(--color-line)]">
                <td className="px-3 py-2">{task.label}</td>
                <td className="px-2 text-right">{s.events}</td>
                <td className="px-2 text-right">{s.units.size}</td>
                <td className="px-2 text-right">{s.units.size * task.minutes} min</td>
                <td className="px-2 text-xs text-[var(--color-ink-soft)]">{[...s.clients].slice(0, 4).join(', ')}{s.clients.size > 4 ? ` i još ${s.clients.size - 4}` : ''}</td>
                <td className="px-2 text-xs text-[var(--color-ink-soft)]">{[...s.people].join(', ') || '—'}</td>
              </tr>
            ))}
            {!summary.rows.length && !loading && <tr><td colSpan={6} className="px-3 py-4 text-sm text-[var(--color-ink-soft)]">U ovom periodu nema zabeleženog rada u Brain-u.</td></tr>}
          </tbody>
        </table>
      </section>

      <section className="space-y-6">
        {days.map(([day, list]) => (
          <div key={day}>
            <h2 className="mb-2 text-sm font-medium">{fmtDay(day)} · {list.length}</h2>
            <ul className="divide-y divide-[var(--color-line)] rounded border border-[var(--color-line)] bg-white text-sm">
              {list.map((e, i) => (
                <li key={i} className="flex flex-wrap items-baseline gap-x-3 px-3 py-1.5">
                  <span className="w-12 text-xs text-[var(--color-ink-soft)]">{fmtTime(e.at)}</span>
                  <span className="w-40 text-xs">{e.client_name ?? 'svi klijenti'}</span>
                  <span className="w-56 text-xs text-[var(--color-ink-soft)]">{TASK_BY_KEY[e.task]?.label ?? e.task}</span>
                  <span className="rounded bg-[var(--color-indigo-soft)] px-2 text-xs text-[var(--color-indigo-dark)]">{ACTION_LABEL[e.action] ?? e.action}</span>
                  <span className="flex-1 truncate">{e.detail}</span>
                  <span className="text-xs text-[var(--color-ink-soft)]">{who(e.user_email)}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    </div>
  )
}
