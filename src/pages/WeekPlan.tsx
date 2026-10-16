import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'

// "Ova nedelja po media planu" in Danas: what the media plan puts in this week per network and campaign (each line's
// budget spread evenly over its days), the flights that start or end this week, and last week's plan against spend.

type Line = { network: 'google' | 'meta'; flight_type: string | null; campaign: string; start: string | null; end: string | null; budget: number; week_budget: number; starts: boolean; ends: boolean }
type Outside = { network: string; campaign: string; start: string; end: string; budget: number }
type Plan = { week: string; lines: Line[]; outside: Outside[]; last_week: Record<'google' | 'meta', { plan: number; spend: number }> }

const NET = { google: 'Google', meta: 'Meta' } as const
const eur = (n: number) => `${Math.round(n).toLocaleString('sr-RS')} €`
const dm = (d: string | null) => (d ? `${Number(d.slice(8, 10))}.${Number(d.slice(5, 7))}.` : '—')

// Monday of the current week, as YYYY-MM-DD in local time.
function monday() {
  const d = new Date()
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function WeekPlan({ clientId }: { clientId: string }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setPlan(null)
    supabase.rpc('week_plan', { p_client_id: clientId, p_week: monday() }).then(({ data }) => setPlan((data as Plan) ?? null))
  }, [clientId])

  if (!plan || !plan.lines.length) return null
  const total = (n: 'google' | 'meta') => plan.lines.filter((l) => l.network === n).reduce((s, l) => s + Number(l.week_budget), 0)
  const changes = plan.lines.filter((l) => l.starts || l.ends)
  const nets = (['google', 'meta'] as const).filter((n) => plan.lines.some((l) => l.network === n))

  return (
    <section className="card mb-6 p-5">
      <button onClick={() => setOpen(!open)} className="flex w-full flex-wrap items-baseline gap-x-4 gap-y-1 text-left">
        <h2 className="text-sm font-semibold">Ova nedelja po media planu <span className="font-normal text-[var(--color-ink-soft)]">· od {dm(plan.week)}</span></h2>
        {nets.map((n) => <span key={n} className="text-sm">{NET[n]} <b>{eur(total(n))}</b></span>)}
        <span className="ml-auto text-xs text-[var(--color-ink-soft)]">{open ? 'Sakrij' : 'Prikaži kampanje'}</span>
      </button>

      {changes.length > 0 && (
        <p className="mt-2 text-sm">
          {changes.map((l, i) => (
            <span key={i}>{i > 0 && ' · '}{NET[l.network]} {l.campaign}: {l.starts ? `počinje ${dm(l.start)}` : ''}{l.starts && l.ends ? ', ' : ''}{l.ends ? `završava ${dm(l.end)}` : ''}</span>
          ))}
        </p>
      )}

      <p className="mt-2 text-xs text-[var(--color-ink-soft)]">
        Prošla nedelja: {nets.map((n) => {
          const x = plan.last_week?.[n]
          if (!x) return null
          const pct = x.plan ? Math.round((x.spend / x.plan) * 100) : null
          return <span key={n} className="mr-3">{NET[n]} potrošeno {eur(x.spend)} od {eur(x.plan)} planiranih{pct != null ? ` (${pct}%)` : ''}</span>
        })}
      </p>

      {plan.outside.length > 0 && (
        <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
          U media planu za ovaj mesec {plan.outside.length === 1 ? 'je red' : 'su redovi'} sa datumima iz drugog meseca, pa nisu uračunati: {plan.outside.map((o) => `${NET[o.network as 'google' | 'meta'] ?? o.network} ${o.campaign} (${dm(o.start)}–${dm(o.end)}, ${eur(o.budget)})`).join(', ')}. Proveriti datume u sheetu.
        </p>
      )}

      {open && (
        <table className="mt-4 w-full text-sm">
          <thead className="text-left text-xs text-[var(--color-ink-soft)]">
            <tr><th className="py-1 pr-3">Mreža</th><th className="pr-3">Kampanja</th><th className="pr-3">Tip</th><th className="pr-3">Period</th><th className="pr-3 text-right">Budžet reda</th><th className="text-right">Ove nedelje</th></tr>
          </thead>
          <tbody>
            {plan.lines.map((l, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="py-1 pr-3">{NET[l.network]}</td>
                <td className="pr-3">{l.campaign}{l.starts && <span className="ml-2 rounded bg-emerald-50 px-1.5 text-xs text-emerald-800">počinje</span>}{l.ends && <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs">završava</span>}</td>
                <td className="pr-3">{l.flight_type ?? '—'}</td>
                <td className="pr-3">{dm(l.start)}–{dm(l.end)}</td>
                <td className="pr-3 text-right">{eur(l.budget)}</td>
                <td className="text-right font-medium">{eur(l.week_budget)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
