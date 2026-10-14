import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { TASKS, type TaskKey, type View } from '../lib/ppcTasks'

// "Taskovi": every client against every recurring PPC task, with when it was last done in Brain,
// what is waiting, and whether it is on time for the Productive task's cadence.

type Cell = { client_id: string; client_name: string; task: TaskKey; applies: boolean; last_done: string | null; open_items: number; status: 'u_roku' | 'kasni' | 'nikad' | 'ceka' | 'uskoro' }

const STATUS: Record<Cell['status'], { label: string; cls: string }> = {
  u_roku: { label: 'u roku', cls: 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' },
  ceka: { label: 'čeka', cls: 'bg-amber-50 text-amber-800' },
  uskoro: { label: 'uskoro', cls: 'bg-amber-50 text-amber-800' },
  kasni: { label: 'kasni', cls: 'bg-red-50 text-[var(--color-rust)]' },
  nikad: { label: 'nije rađeno', cls: 'bg-[var(--color-paper)] text-[var(--color-ink-soft)]' },
}

function ago(s: string | null) {
  if (!s) return ''
  const days = Math.floor((Date.now() - Date.parse(s)) / 864e5)
  return days <= 0 ? 'danas' : days === 1 ? 'juče' : `pre ${days} d`
}

export default function TaskBoard({ onOpen }: { onOpen: (view: View) => void }) {
  const [cells, setCells] = useState<Cell[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [onlyOpen, setOnlyOpen] = useState(false)

  useEffect(() => {
    supabase.rpc('ppc_task_board', {}).then(({ data, error: e }) => {
      setLoading(false)
      if (e) { setError(e.message); return }
      setCells((data ?? []) as Cell[])
    })
  }, [])

  const clients = useMemo(() => {
    const m = new Map<string, { name: string; cells: Record<string, Cell> }>()
    for (const c of cells) {
      const x = m.get(c.client_id) ?? { name: c.client_name, cells: {} }
      x.cells[c.task] = c
      m.set(c.client_id, x)
    }
    const list = [...m.entries()].map(([id, x]) => ({ id, ...x }))
    // Clients with something late or waiting first.
    const weight = (x: (typeof list)[number]) => Object.values(x.cells).filter((c) => c.applies && (c.status === 'kasni' || c.open_items > 0)).length
    return list.sort((a, b) => weight(b) - weight(a) || a.name.localeCompare(b.name))
  }, [cells])

  const counts = useMemo(() => {
    const applies = cells.filter((c) => c.applies)
    return {
      late: applies.filter((c) => c.status === 'kasni' || c.status === 'nikad').length,
      open: applies.reduce((n, c) => n + c.open_items, 0),
      ok: applies.filter((c) => c.status === 'u_roku').length,
      total: applies.length,
    }
  }, [cells])

  const shown = onlyOpen ? clients.filter((c) => Object.values(c.cells).some((x) => x.applies && (x.status !== 'u_roku' || x.open_items > 0))) : clients

  return (
    <div>
      <header className="mb-8 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Svi PPC taskovi, svi klijenti</p>
          <h1 className="font-display mt-1 text-4xl font-medium">Taskovi</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-ink-soft)]">
            Za svaki ponavljajući task iz Productive-a: kad je poslednji put urađen u Brain-u i da li je u roku. Broj u ćeliji je koliko stavki čeka odluku. Klik na ćeliju otvara ekran gde se task radi.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> samo klijenti sa otvorenim taskovima
        </label>
      </header>

      {error && <p className="mb-6 rounded bg-red-50 px-4 py-2 text-sm text-[var(--color-rust)]">{error}</p>}
      {loading && <p className="mb-4 text-sm text-[var(--color-ink-soft)]">Učitavam…</p>}

      <section className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4">
        {[
          ['U roku', `${counts.ok} / ${counts.total}`],
          ['Kasni ili nije rađeno', String(counts.late)],
          ['Stavki čeka odluku', String(counts.open)],
          ['Klijenata', String(clients.length)],
        ].map(([k, v]) => (
          <div key={k} className="rounded border border-[var(--color-line)] bg-white p-4">
            <p className="text-xs text-[var(--color-ink-soft)]">{k}</p>
            <p className="font-display mt-1 text-2xl">{v}</p>
          </div>
        ))}
      </section>

      <section className="overflow-x-auto rounded border border-[var(--color-line)] bg-white">
        <table className="w-full text-xs">
          <thead className="bg-[var(--color-paper)] text-left text-[var(--color-ink-soft)]">
            <tr>
              <th className="sticky left-0 bg-[var(--color-paper)] px-3 py-2">Klijent</th>
              {TASKS.map((t) => (
                <th key={t.key} className="min-w-[110px] px-2 py-2 align-bottom font-normal">
                  <span className="block font-medium text-[var(--color-ink)]">{t.label}</span>
                  <span>{t.cadence}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id} className="border-t border-[var(--color-line)]">
                <td className="sticky left-0 bg-white px-3 py-2 text-sm font-medium">{c.name}</td>
                {TASKS.map((t) => {
                  const x = c.cells[t.key]
                  if (!x || !x.applies) return <td key={t.key} className="px-2 text-[var(--color-ink-soft)]">—</td>
                  return (
                    <td key={t.key} className="px-2 py-1.5">
                      <button onClick={() => onOpen(t.view)} className="w-full text-left" title={`Otvori: ${t.label}`}>
                        <span className={`inline-block rounded px-1.5 py-0.5 ${STATUS[x.status].cls}`}>{STATUS[x.status].label}</span>
                        {x.open_items > 0 && <span className="ml-1 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-900">{x.open_items}</span>}
                        <span className="mt-0.5 block text-[var(--color-ink-soft)]">{ago(x.last_done)}</span>
                      </button>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <p className="mt-3 text-xs text-[var(--color-ink-soft)]">
        „Nije rađeno“ znači da u Brain-u još nema zabeleženog rada za taj task; ako se task i dalje radi van Brain-a (u Sheet-u ili u nalogu), ovde se ne vidi.
      </p>
    </div>
  )
}
