import { useState } from 'react'
import { type Change, COMPETITOR_LIST, describeChange, isCompetitorNegative } from '../lib/changes'

// Proposed account changes grouped by what the team actually decides: one negative word (or one placement) in all its
// campaigns is one line, not one checkbox per campaign. Lines are sorted by the money behind them; only the first
// SHOWN are listed, the rest wait behind "show more", and the small ones (under SMALL_EUR in 30 days, mostly
// preventive competitor names) are one combined line. Approve and reject act only on what is on screen and ticked.

export const SHOWN = 8
export const SMALL_EUR = 5

export type Bundle = { key: string; rows: Change[]; spend: number; campaigns: string[] }

// Competitor-list negatives carry each campaign's own spend; the other proposals repeat the term's total on every row.
function spendOf(rows: Change[]) {
  const v = rows.map((r) => Number((r.details as { spend?: number })?.spend ?? 0))
  return (rows[0].details as { source?: string })?.source === 'lista_konkurenata' ? v.reduce((s, x) => s + x, 0) : Math.max(0, ...v)
}

export function bundleChanges(list: Change[]): Bundle[] {
  const m = new Map<string, Change[]>()
  for (const c of list) {
    const key = c.kind === 'daily_budget' ? c.id : `${c.kind}|${c.network}|${String(c.target).toLowerCase()}|${c.match_type ?? ''}`
    m.set(key, [...(m.get(key) ?? []), c])
  }
  return [...m.entries()].map(([key, rows]) => ({ key, rows, spend: spendOf(rows), campaigns: rows.map((r) => r.campaign).filter(Boolean) as string[] }))
    .sort((a, b) => b.spend - a.spend)
}

function split(list: Change[]) {
  const all = bundleChanges(list)
  const big = all.filter((b) => b.rows[0].kind === 'daily_budget' || b.spend >= SMALL_EUR)
  const small = all.filter((b) => !big.includes(b))
  return { big, small }
}

// The ids a decision applies to: the ticked rows of the lines on screen.
export function visibleIds(list: Change[], unchecked: Record<string, boolean>, showAll: boolean) {
  const { big, small } = split(list)
  return [...(showAll ? big : big.slice(0, SHOWN)), ...small].flatMap((b) => b.rows).filter((c) => !unchecked[c.id]).map((c) => c.id)
}

const eur = (n: number) => `${n.toLocaleString('sr-RS', { maximumFractionDigits: n < 10 ? 2 : 0 })} €`

function label(b: Bundle, cur: string) {
  const c = b.rows[0]
  if (isCompetitorNegative(c)) return `„${c.target}“ (${(c.match_type ?? 'Exact').toLowerCase()}) u listu ${COMPETITOR_LIST}, povezanu sa ${b.campaigns.length} ${b.campaigns.length === 1 ? 'kampanjom' : 'kampanja'}`
  if (c.kind === 'negative_keyword') {
    const n = b.campaigns.length
    return n > 1 ? `Negativna reč „${c.target}“ (${(c.match_type ?? 'Exact').toLowerCase()}) u ${n} kampanja` : describeChange(c, cur)
  }
  return describeChange(c, cur)
}

export default function ChangeBundles({ list, unchecked, setUnchecked, showAll, setShowAll, cur }: {
  list: Change[]; unchecked: Record<string, boolean>; setUnchecked: (u: Record<string, boolean>) => void
  showAll: boolean; setShowAll: (v: boolean) => void; cur: string
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const { big, small } = split(list)
  const shown = showAll ? big : big.slice(0, SHOWN)
  const hidden = big.slice(shown.length)
  const isOn = (rows: Change[]) => rows.some((r) => !unchecked[r.id])
  const toggle = (rows: Change[], on: boolean) => setUnchecked({ ...unchecked, ...Object.fromEntries(rows.map((r) => [r.id, !on])) })
  const smallRows = small.flatMap((b) => b.rows)

  return (
    <div>
      <ul className="space-y-2">
        {shown.map((b) => (
          <li key={b.key} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={isOn(b.rows)} onChange={(e) => toggle(b.rows, e.target.checked)} />
            <span className="flex-1">
              {label(b, cur)}{b.spend > 0 && <span className="ml-2 text-xs text-[var(--color-ink-soft)]">{eur(b.spend)} / 30 dana</span>}
              {b.rows[0].reason && <span className="block text-xs text-[var(--color-ink-soft)]">{b.rows[0].reason}</span>}
              {b.campaigns.length > 1 && (
                <button onClick={() => setOpen({ ...open, [b.key]: !open[b.key] })} className="text-xs text-[var(--color-indigo)]">{open[b.key] ? 'sakrij kampanje' : 'kampanje'}</button>
              )}
              {open[b.key] && <span className="block text-xs text-[var(--color-ink-soft)]">{b.campaigns.join(' · ')}</span>}
            </span>
          </li>
        ))}
        {small.length > 0 && (
          <li className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={isOn(smallRows)} onChange={(e) => toggle(smallRows, e.target.checked)} />
            <span className="flex-1">
              Sitno i preventivno: {small.length} {small.length === 1 ? 'predlog' : 'predloga'} ispod {SMALL_EUR} € za 30 dana (ukupno {eur(small.reduce((s, b) => s + b.spend, 0))})
              <button onClick={() => setOpen({ ...open, _small: !open._small })} className="ml-2 text-xs text-[var(--color-indigo)]">{open._small ? 'sakrij' : 'prikaži'}</button>
              {open._small && <span className="block text-xs text-[var(--color-ink-soft)]">{small.map((b) => `${label(b, cur)}${b.spend ? ` (${eur(b.spend)})` : ''}`).join(' · ')}</span>}
            </span>
          </li>
        )}
      </ul>
      {hidden.length > 0 && (
        <button onClick={() => setShowAll(true)} className="mt-3 text-xs text-[var(--color-indigo)]">
          Prikaži još {hidden.length} (ukupno {eur(hidden.reduce((s, b) => s + b.spend, 0))}) · skriveni se ne odobravaju dok se ne prikažu
        </button>
      )}
      {showAll && big.length > SHOWN && <button onClick={() => setShowAll(false)} className="mt-3 text-xs text-[var(--color-indigo)]">Prikaži samo najvažnijih {SHOWN}</button>}
    </div>
  )
}
