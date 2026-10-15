import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { TASKS, TASK_BY_KEY, logAction, type TaskKey, type View } from '../lib/ppcTasks'
import { CHECK_LABEL, Evidence, SEVERITY, STATUS_LABEL, type Finding, type Status } from './MorningReview'

// "PPC taskovi": one place per client for every recurring Productive task. For each task: Brain's
// analysis (findings of the checks behind it), a decision with a comment on every finding, and
// closing the task with a comment. Closed tasks are listed in Urađeno; comments are what the morning
// review learns from. Nothing is written to Productive.

type Client = { client_id: string; clients: { name: string } | null; params: { currency?: string } }
type Cell = { client_id: string; task: TaskKey; applies: boolean; last_done: string | null; open_items: number; status: 'u_roku' | 'kasni' | 'nikad' | 'ceka' | 'uskoro' }
type Review = { id: string; task: string; created_at: string; user_email: string | null; n_findings: number; n_approved: number; n_rejected: number; n_postponed: number; n_open: number; comment: string; findings: { title: string; status: string; comment: string | null }[] }
type WorkEntry = { at: string; task: string; action: string; detail: string | null; user_email: string | null }

const CELL: Record<Cell['status'], { label: string; cls: string }> = {
  u_roku: { label: 'u roku', cls: 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' },
  ceka: { label: 'čeka', cls: 'bg-amber-50 text-amber-800' },
  uskoro: { label: 'uskoro', cls: 'bg-amber-50 text-amber-800' },
  kasni: { label: 'kasni', cls: 'bg-red-50 text-[var(--color-rust)]' },
  nikad: { label: 'nije rađeno', cls: 'bg-[var(--color-paper)] text-[var(--color-ink-soft)]' },
}
// What Brain prepares for each task and where the rest of the work happens.
const HOW: Record<TaskKey, { analysis: string; screen?: View; screenLabel?: string }> = {
  provera_budzeta: { analysis: 'Jutarnji pregled svaki dan proverava trošenje prema planu i mesečnim budžetima i Meta limit naloga.', screen: 'budgets', screenLabel: 'Budžeti' },
  optimizacija_budzeta: { analysis: 'Brain računa dnevni budžet po kampanji iz mesečnog budžeta i potrošnje; tROAS prema ROAS-u 30 dana.', screen: 'budgets', screenLabel: 'Budžeti' },
  provera_naloga: { analysis: 'Jutarnji pregled: kampanje bez troška, odstupanja troška, pad konverzija, tracking, akcije iz Productive-a.', screen: 'review', screenLabel: 'Jutarnji pregled' },
  search_terms: { analysis: 'Search termini koji troše bez konverzije, razvrstani (konkurent, nebitno, relevantno) sa predlogom negativnih reči.', screen: 'review', screenLabel: 'Jutarnji pregled' },
  disapproved: { analysis: 'Nedeljna provera odbijenih i ograničenih oglasa sa razlogom.', screen: 'review', screenLabel: 'Jutarnji pregled' },
  recommendations: { analysis: 'Nedeljni optimization score i preporuke Google-a sa ocenom šta prihvatiti.', screen: 'review', screenLabel: 'Jutarnji pregled' },
  placements: { analysis: 'Nedeljno: plasmani (Display, Demand Gen, YouTube) koji troše bez konverzije, sa predlogom isključenja.', screen: 'review', screenLabel: 'Jutarnji pregled' },
  ga4: { analysis: 'Nedeljno: promene u GA4 izvorima (direct/unassigned, plaćene sesije po kliku).', screen: 'review', screenLabel: 'Jutarnji pregled' },
  mesecna_potrosnja: { analysis: 'Potrošnja svih klijenata po mrežama za mesec.', screen: 'budgets', screenLabel: 'Budžeti → Potrošnja svih klijenata' },
  kampanje: { analysis: 'Nacrti kampanja iz Productive briefova (Search, PMax, Demand Gen, Video, Display) i Editor fajlovi.', screen: 'campaigns', screenLabel: 'Nove kampanje' },
  alokacija_budzeta: { analysis: 'Predlog raspodele mesečnog budžeta po kampanjama iz potrošnje i ROAS-a.', screen: 'budgets', screenLabel: 'Budžeti → Alokacija za mesec' },
  proizvodi: { analysis: 'Brain svako jutro ukršta product feed sa GA4 i Google Ads po proizvodu: troši bez prodaje, prodaje se bez oglasa, van stanja a troši, pad prodaje posle promene cene, velike promene u feedu.', screen: 'products', screenLabel: 'Proizvodi' },
  osvezavanje_oglasa: { analysis: 'Search oglasi sa slabim Ad Strength-om, LOW assetima ili malo asseta, sa novim tekstovima.', screen: 'campaigns', screenLabel: 'Nove kampanje → Osvežavanje Search oglasa' },
}
const ACTION: Record<string, string> = {
  odobreno: 'odobreno', odbijeno: 'odbijeno', odlozeno: 'odloženo', izvrseno: 'urađeno', zavrseno: 'task završen', budzet_unet: 'budžet unet',
  nacrt: 'nacrt', izvezeno: 'izvezeno', objavljeno: 'objavljeno', editor_csv: 'Editor CSV', meta_csv: 'Meta CSV', izvestaj_csv: 'izveštaj',
  negativne_csv: 'negativne CSV', iskljucenja_csv: 'isključenja CSV',
}
const when = (s: string) => new Date(s).toLocaleString('sr-Latn-RS', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })
const ago = (s: string | null) => {
  if (!s) return 'nikad'
  const d = Math.floor((Date.now() - Date.parse(s)) / 864e5)
  return d <= 0 ? 'danas' : d === 1 ? 'juče' : `pre ${d} dana`
}
const who = (e: string | null) => (e ? e.split('@')[0] : '—')

export default function PpcTaskDesk({ onOpen }: { onOpen: (v: View) => void }) {
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState('')
  const [cells, setCells] = useState<Cell[]>([])
  const [task, setTask] = useState<TaskKey>('provera_naloga')
  const [findings, setFindings] = useState<Finding[]>([])
  const [reviews, setReviews] = useState<Review[]>([])
  const [work, setWork] = useState<WorkEntry[]>([])
  const [comments, setComments] = useState<Record<string, string>>({})
  const [closing, setClosing] = useState('')
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    supabase.from('review_settings').select('client_id, params, clients(name)').eq('enabled', true).then(({ data }) => {
      const list = ((data ?? []) as unknown as Client[]).sort((a, b) => (a.clients?.name ?? '').localeCompare(b.clients?.name ?? ''))
      setClients(list)
      if (list.length) setClientId(list[0].client_id)
    })
  }, [])

  async function loadBoard() {
    const { data, error } = await supabase.rpc('ppc_task_board', {})
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    setCells((data ?? []) as Cell[])
  }
  useEffect(() => { loadBoard() }, [])

  async function loadTask() {
    if (!clientId) return
    const from = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10)
    const to = new Date().toISOString().slice(0, 10)
    const [f, r, w] = await Promise.all([
      supabase.rpc('ppc_task_findings', { p_client_id: clientId, p_task: task, p_days: 14 }),
      supabase.rpc('ppc_task_reviews_list', { p_from: from, p_to: to, p_client_id: clientId }),
      supabase.rpc('ppc_work_log', { p_from: new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10), p_to: to, p_client_id: clientId }),
    ])
    if (f.error) { setMessage({ kind: 'err', text: f.error.message }); return }
    const list = (f.data ?? []) as Finding[]
    setFindings(list)
    setComments(Object.fromEntries(list.map((x) => [x.id, x.decision_reason ?? ''])))
    setReviews(((r.data ?? []) as Review[]).filter((x) => x.task === task))
    setWork(((w.data ?? []) as WorkEntry[]).filter((x) => x.task === task).slice(0, 15))
  }
  useEffect(() => { setMessage(null); setClosing(''); loadTask() }, [clientId, task]) // eslint-disable-line react-hooks/exhaustive-deps

  const mine = useMemo(() => Object.fromEntries(cells.filter((c) => c.client_id === clientId).map((c) => [c.task, c])) as Record<string, Cell>, [cells, clientId])
  const client = clients.find((c) => c.client_id === clientId)
  const cur = client?.params?.currency ?? 'EUR'
  const info = TASK_BY_KEY[task]
  const how = HOW[task]
  const open = findings.filter((f) => f.status === 'novo')

  async function decide(f: Finding, status: Status) {
    const comment = (comments[f.id] ?? '').trim()
    if (status === 'odbijeno' && !comment) { setMessage({ kind: 'err', text: 'Za odbijanje napiši komentar: zašto nalaz nije tačan ili koristan. Brain uči iz toga.' }); return }
    const { data: u } = await supabase.auth.getUser()
    const { error } = await supabase.from('review_findings').update({
      status, decision_reason: comment || null, decided_by: u.user?.id ?? null, decided_at: new Date().toISOString(),
    }).eq('id', f.id)
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    setMessage(null)
    loadTask(); loadBoard()
  }

  async function saveComment(f: Finding) {
    const { error } = await supabase.from('review_findings').update({ decision_reason: (comments[f.id] ?? '').trim() || null }).eq('id', f.id)
    setMessage(error ? { kind: 'err', text: error.message } : { kind: 'ok', text: 'Komentar sačuvan.' })
  }

  async function closeTask() {
    const comment = closing.trim()
    if (!comment) { setMessage({ kind: 'err', text: 'Napiši komentar: šta je urađeno i šta Brain treba da zna za sledeći put.' }); return }
    setBusy(true)
    const count = (s: Status[]) => findings.filter((f) => s.includes(f.status)).length
    const { error } = await supabase.from('ppc_task_reviews').insert({
      client_id: clientId, task,
      period_from: findings.length ? findings.map((f) => (f as unknown as { run_date: string }).run_date).sort()[0] : null,
      period_to: new Date().toISOString().slice(0, 10),
      findings: findings.map((f) => ({ id: f.id, check_type: f.check_type, title: f.title, status: f.status, comment: f.decision_reason })),
      n_findings: findings.length, n_approved: count(['odobreno', 'izvrseno']), n_rejected: count(['odbijeno']), n_postponed: count(['odlozeno']), n_open: count(['novo']),
      comment,
    })
    setBusy(false)
    if (error) { setMessage({ kind: 'err', text: error.message }); return }
    logAction(clientId, task, 'zavrseno', comment)
    setClosing('')
    setMessage({ kind: 'ok', text: `Task „${info.label}“ za ${client?.clients?.name} je završen i vidi se u Urađeno.` })
    loadTask(); loadBoard()
  }

  const inputCls = 'w-full rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm'

  return (
    <div>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4 border-b border-[var(--color-line)] pb-6">
        <div>
          <p className="eyebrow-label">Ponavljajući taskovi iz Productive-a · ništa se ne upisuje u Productive</p>
          <h1 className="font-display mt-1 text-4xl font-medium">PPC taskovi</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-ink-soft)]">
            Izaberi klijenta i task. Brain je već uradio analizu; ti odobriš, odbiješ ili odložiš svaki nalaz uz komentar, pa završiš task komentarom. Iz komentara Brain uči za sledeći pregled.
          </p>
        </div>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} className="rounded border border-[var(--color-line)] bg-white px-3 py-1.5 text-sm">
          {clients.map((c) => <option key={c.client_id} value={c.client_id}>{c.clients?.name}</option>)}
        </select>
      </header>

      <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="space-y-1">
          {TASKS.map((t) => {
            const c = mine[t.key]
            if (c && !c.applies) return null
            return (
              <button key={t.key} onClick={() => setTask(t.key)}
                className={`w-full rounded border px-3 py-2 text-left text-sm ${task === t.key ? 'border-[var(--color-indigo)] bg-white' : 'border-transparent hover:bg-white'}`}>
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium">{t.label}</span>
                  {c && c.open_items > 0 && <span className="rounded bg-amber-100 px-1.5 text-xs font-medium text-amber-900">{c.open_items}</span>}
                </span>
                <span className="mt-0.5 flex items-center gap-2 text-xs text-[var(--color-ink-soft)]">
                  {c && <span className={`rounded px-1.5 ${CELL[c.status].cls}`}>{CELL[c.status].label}</span>}
                  <span>{t.cadence}</span>
                </span>
              </button>
            )
          })}
        </aside>

        <main>
          <div className="mb-4 flex flex-wrap items-baseline gap-3">
            <h2 className="font-display text-2xl font-medium">{info.label}</h2>
            <span className="text-sm text-[var(--color-ink-soft)]">{info.cadence} · poslednji put završen: {ago(mine[task]?.last_done ?? null)}</span>
          </div>
          {message && <p className={`mb-4 rounded px-4 py-2 text-sm ${message.kind === 'ok' ? 'bg-[var(--color-indigo-soft)] text-[var(--color-indigo-dark)]' : 'bg-red-50 text-[var(--color-rust)]'}`}>{message.text}</p>}

          <section className="mb-6 rounded border border-[var(--color-line)] bg-white p-4 text-sm">
            <p className="mb-1 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">1 · Analiza Brain-a</p>
            <p>{how.analysis}</p>
            {how.screen && <button onClick={() => onOpen(how.screen!)} className="mt-2 text-xs text-[var(--color-indigo-dark)] underline">Rad za ovaj task: {how.screenLabel} →</button>}
          </section>

          <section className="mb-6">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">2 · Nalazi iz poslednjih 14 dana ({findings.length}, čeka odluku {open.length})</p>
            {!findings.length && <p className="rounded border border-dashed border-[var(--color-line)] bg-white p-4 text-sm text-[var(--color-ink-soft)]">Brain za ovaj task nema nalaza u poslednjih 14 dana. {how.screen ? 'Rad se radi na ekranu iznad; kad završiš, zatvori task ispod.' : ''}</p>}
            <div className="space-y-3">
              {findings.map((f) => (
                <article key={f.id} className={`rounded border bg-white p-4 ${f.status === 'novo' ? 'border-[var(--color-line)]' : 'border-dashed border-[var(--color-line)]'}`}>
                  <p className="mb-1 flex flex-wrap items-center gap-2 text-xs">
                    <span className={`rounded px-2 py-0.5 font-medium ${SEVERITY[f.severity].cls}`}>{SEVERITY[f.severity].label}</span>
                    <span className="text-[var(--color-ink-soft)]">{CHECK_LABEL[f.check_type] ?? f.check_type} · {(f as unknown as { run_date: string }).run_date}</span>
                    <span className={`ml-auto rounded px-2 py-0.5 ${f.status === 'novo' ? 'bg-amber-50 text-amber-800' : 'bg-[var(--color-paper)]'}`}>{STATUS_LABEL[f.status]}</span>
                  </p>
                  <h3 className="font-medium">{f.title}</h3>
                  {f.detail && <p className="mt-1 text-sm text-[var(--color-ink-soft)]">{f.detail}</p>}
                  {f.proposal && <p className="mt-1 text-sm"><span className="font-medium">Predlog: </span>{f.proposal}</p>}
                  <details className="mt-2">
                    <summary className="cursor-pointer text-xs text-[var(--color-ink-soft)]">Brojevi na koje se nalaz oslanja</summary>
                    <Evidence f={f} cur={cur} />
                  </details>
                  <div className="mt-3 flex flex-wrap items-end gap-2">
                    <label className="min-w-64 flex-1 text-xs">
                      <span className="mb-1 block text-[var(--color-ink-soft)]">Komentar (obavezan kod odbijanja; Brain uči iz njega)</span>
                      <input value={comments[f.id] ?? ''} onChange={(e) => setComments({ ...comments, [f.id]: e.target.value })} className={inputCls}
                        placeholder="npr. konkurente namerno gađamo; planirani kraj flighta; uradjeno u nalogu" />
                    </label>
                    {f.status === 'novo' ? (
                      <>
                        <button onClick={() => decide(f, 'odobreno')} className="rounded bg-[var(--color-indigo)] px-3 py-1.5 text-xs font-medium text-white">Odobri</button>
                        <button onClick={() => decide(f, 'odbijeno')} className="rounded border border-[var(--color-line)] px-3 py-1.5 text-xs text-[var(--color-rust)]">Odbij</button>
                        <button onClick={() => decide(f, 'odlozeno')} className="rounded border border-[var(--color-line)] px-3 py-1.5 text-xs">Odloži</button>
                      </>
                    ) : (
                      <>
                        <button onClick={() => saveComment(f)} className="rounded border border-[var(--color-line)] px-3 py-1.5 text-xs">Sačuvaj komentar</button>
                        {f.status === 'odobreno' && <button onClick={() => decide(f, 'izvrseno')} className="rounded border border-[var(--color-line)] px-3 py-1.5 text-xs">Urađeno u nalogu</button>}
                        <button onClick={() => decide(f, 'novo')} className="px-2 py-1.5 text-xs text-[var(--color-ink-soft)] underline">Vrati na odluku</button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="mb-8 rounded border border-[var(--color-indigo)] bg-white p-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">3 · Završi task</p>
            {open.length > 0 && <p className="mb-2 text-xs text-amber-800">Još {open.length} nalaza čeka odluku; ostaće otvoreni i vide se u zapisu.</p>}
            <textarea value={closing} onChange={(e) => setClosing(e.target.value)} rows={3} className={inputCls}
              placeholder="Šta je urađeno, šta je odlučeno i šta Brain treba da zna sledeći put (npr. „za ovog klijenta ne predlagati isključivanje brend termina“)." />
            <button onClick={closeTask} disabled={busy || !closing.trim()} className="mt-2 rounded bg-[var(--color-indigo)] px-4 py-1.5 text-sm font-medium text-white disabled:opacity-40">
              Odobri analizu i završi task
            </button>
          </section>

          <section className="grid gap-6 md:grid-cols-2">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Završeno ranije</p>
              {!reviews.length && <p className="text-sm text-[var(--color-ink-soft)]">Još nije završen u Brain-u.</p>}
              <ul className="space-y-2">
                {reviews.map((r) => (
                  <li key={r.id} className="rounded border border-[var(--color-line)] bg-white p-3 text-sm">
                    <p className="text-xs text-[var(--color-ink-soft)]">{when(r.created_at)} · {who(r.user_email)} · nalaza {r.n_findings}: odobreno {r.n_approved}, odbijeno {r.n_rejected}, odloženo {r.n_postponed}{r.n_open ? `, otvoreno ${r.n_open}` : ''}</p>
                    <p className="mt-1">„{r.comment}“</p>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-ink-soft)]">Rad na ovom tasku (30 dana)</p>
              {!work.length && <p className="text-sm text-[var(--color-ink-soft)]">Nema zabeleženog rada.</p>}
              <ul className="divide-y divide-[var(--color-line)] rounded border border-[var(--color-line)] bg-white text-xs">
                {work.map((w, i) => (
                  <li key={i} className="flex gap-2 px-3 py-1.5">
                    <span className="w-24 shrink-0 text-[var(--color-ink-soft)]">{when(w.at)}</span>
                    <span className="shrink-0 rounded bg-[var(--color-paper)] px-1.5">{ACTION[w.action] ?? w.action}</span>
                    <span className="flex-1 truncate">{w.detail}</span>
                    <span className="text-[var(--color-ink-soft)]">{who(w.user_email)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </main>
      </div>
    </div>
  )
}
