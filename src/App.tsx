import { useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import AgencyReport from './pages/AgencyReport'
import GoogleAdsReport from './pages/GoogleAdsReport'
import FacebookAdsReport from './pages/FacebookAdsReport'
import BlendedReport from './pages/BlendedReport'
import Ga4Report from './pages/Ga4Report'
import ExecutiveSummary from './pages/ExecutiveSummary'
import OwnedChannelsReport from './pages/OwnedChannelsReport'
import ChatAssistant from './pages/ChatAssistant'
import PpcMediaReport from './pages/PpcMediaReport'
import BudgetPacingReport from './pages/BudgetPacingReport'
import CampaignBuilder from './pages/CampaignBuilder'
import PlanProposal from './pages/PlanProposal'
import Budgets from './pages/Budgets'
import WorkLog from './pages/WorkLog'
import Today from './pages/Today'
import ProductFeeds from './pages/ProductFeeds'
import './index.css'

type View = 'today' | 'summary' | 'client' | 'agency' | 'google_ads' | 'facebook_ads' | 'blended' | 'ga4' | 'owned' | 'chat' | 'ppc' | 'pacing' | 'campaigns' | 'proposal' | 'budgets' | 'done' | 'products'

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [view, setView] = useState<View>('today')
  const [reportsOpen, setReportsOpen] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  // Daily work first; reports are one click away but out of the way.
  const work: { key: View; label: string; hint: string }[] = [
    { key: 'today', label: 'Danas', hint: 'provere i odobravanje' },
    { key: 'budgets', label: 'Budžeti', hint: 'plan, alokacija, potrošnja' },
    { key: 'campaigns', label: 'Kampanje', hint: 'nove kampanje i oglasi' },
    { key: 'products', label: 'Proizvodi', hint: 'feed i prodaja po proizvodu' },
    { key: 'done', label: 'Istorija', hint: 'šta je urađeno' },
  ]
  const reports: { key: View; label: string }[] = [
    { key: 'summary', label: 'Sažetak za direktora' }, { key: 'agency', label: 'Agencijski izveštaj' }, { key: 'client', label: 'Po klijentu' },
    { key: 'google_ads', label: 'Google Ads' }, { key: 'facebook_ads', label: 'Facebook Ads' }, { key: 'blended', label: 'Blended' },
    { key: 'ga4', label: 'GA4' }, { key: 'owned', label: 'Push & Newsletter' }, { key: 'ppc', label: 'PPC Media Plan' },
    { key: 'pacing', label: 'Budget Pacing' }, { key: 'proposal', label: 'Predlog plana' },
  ]
  const item = (active: boolean) => `flex w-full items-center rounded-lg px-3 py-2 text-left text-sm ${active ? 'bg-[var(--color-indigo-soft)] font-medium text-[var(--color-indigo-dark)]' : 'text-slate-600 hover:bg-slate-100'}`

  // Still checking for an existing session — avoid flashing the login screen.
  if (session === undefined) {
    return <div className="flex min-h-screen items-center justify-center bg-[var(--color-paper)] text-[var(--color-ink-soft)]">Učitavanje…</div>
  }

  if (session === null) {
    return <Login />
  }

  return (
    <div className="flex min-h-screen bg-[var(--color-paper)]">
      <nav className="sticky top-0 flex h-screen w-60 shrink-0 flex-col overflow-y-auto border-r border-[var(--color-line)] bg-white px-3 py-5">
        <div className="mb-6 flex items-center gap-2 px-3">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[var(--color-indigo)] text-sm font-semibold text-white">B</span>
          <span className="text-sm font-semibold">Brain</span>
        </div>
        <div className="space-y-0.5">
          {work.map((t) => (
            <button key={t.key} onClick={() => setView(t.key)} className={item(view === t.key)} title={t.hint}>{t.label}</button>
          ))}
        </div>
        <button onClick={() => setReportsOpen(!reportsOpen)} className="mt-6 px-3 py-1 text-left text-xs font-medium text-slate-400 hover:text-slate-600">
          {reportsOpen || reports.some((r) => r.key === view) ? '▾' : '▸'} Izveštaji
        </button>
        {(reportsOpen || reports.some((r) => r.key === view)) && (
          <div className="space-y-0.5">
            {reports.map((t) => <button key={t.key} onClick={() => setView(t.key)} className={item(view === t.key)}>{t.label}</button>)}
          </div>
        )}
        <div className="mt-4 space-y-0.5">
          <button onClick={() => setView('chat')} className={item(view === 'chat')}>AI asistent</button>
        </div>
        <div className="mt-auto border-t border-[var(--color-line)] px-3 pt-4 text-xs text-slate-500">
          <p className="truncate" title={session.user.email}>{session.user.email}</p>
          <button onClick={() => supabase.auth.signOut()} className="mt-1 hover:text-slate-800">Odjava</button>
        </div>
      </nav>
      <main className="min-w-0 flex-1">
      <div className="mx-auto max-w-6xl px-8 py-8">
        {view === 'summary' && <ExecutiveSummary />}
        {view === 'chat' && <ChatAssistant />}
        {view === 'agency' && <AgencyReport />}
        {view === 'client' && <Dashboard />}
        {view === 'google_ads' && <GoogleAdsReport />}
        {view === 'facebook_ads' && <FacebookAdsReport />}
        {view === 'blended' && <BlendedReport />}
        {view === 'ga4' && <Ga4Report />}
        {view === 'owned' && <OwnedChannelsReport />}
        {view === 'ppc' && <PpcMediaReport />}
        {view === 'pacing' && <BudgetPacingReport />}
        {view === 'budgets' && <Budgets />}
        {view === 'done' && <WorkLog />}
        {view === 'products' && <ProductFeeds />}
        {view === 'proposal' && <PlanProposal />}
        {view === 'campaigns' && <CampaignBuilder />}
        {view === 'today' && <Today />}
      </div>
      </main>
    </div>
  )
}

export default App
