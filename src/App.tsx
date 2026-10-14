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
import MorningReview from './pages/MorningReview'
import Budgets from './pages/Budgets'
import TaskBoard from './pages/TaskBoard'
import WorkLog from './pages/WorkLog'
import PpcTaskDesk from './pages/PpcTaskDesk'
import ProductFeeds from './pages/ProductFeeds'
import './index.css'

type View = 'summary' | 'client' | 'agency' | 'google_ads' | 'facebook_ads' | 'blended' | 'ga4' | 'owned' | 'chat' | 'ppc' | 'pacing' | 'campaigns' | 'proposal' | 'review' | 'budgets' | 'tasks' | 'done' | 'products' | 'desk'

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [view, setView] = useState<View>('desk')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  // Grouped side menu: the PPC team's daily work first, reports after.
  const groups: { title: string; tabs: { key: View; label: string }[] }[] = [
    { title: 'PPC rad', tabs: [
      { key: 'desk', label: 'PPC taskovi' },
      { key: 'review', label: 'Jutarnji pregled' },
      { key: 'budgets', label: 'Budžeti' },
      { key: 'campaigns', label: 'Nove kampanje' },
      { key: 'products', label: 'Proizvodi' },
      { key: 'done', label: 'Urađeno' },
      { key: 'tasks', label: 'Svi klijenti × taskovi' },
    ] },
    { title: 'Planiranje', tabs: [
      { key: 'proposal', label: 'Predlog plana' },
      { key: 'ppc', label: 'PPC Media Plan' },
      { key: 'pacing', label: 'Budget Pacing' },
    ] },
    { title: 'Izveštaji', tabs: [
      { key: 'summary', label: 'Sažetak za direktora' },
      { key: 'agency', label: 'Agencijski izveštaj' },
      { key: 'client', label: 'Po klijentu' },
      { key: 'google_ads', label: 'Google Ads' },
      { key: 'facebook_ads', label: 'Facebook Ads' },
      { key: 'blended', label: 'Blended' },
      { key: 'ga4', label: 'GA4' },
      { key: 'owned', label: 'Push & Newsletter' },
    ] },
    { title: 'Asistent', tabs: [{ key: 'chat', label: 'AI Chat' }] },
  ]

  // Still checking for an existing session — avoid flashing the login screen.
  if (session === undefined) {
    return <div className="flex min-h-screen items-center justify-center bg-[var(--color-paper)] text-[var(--color-ink-soft)]">Učitavanje…</div>
  }

  if (session === null) {
    return <Login />
  }

  return (
    <div className="flex min-h-screen bg-[var(--color-paper)]">
      <nav className="sticky top-0 flex h-screen w-56 shrink-0 flex-col overflow-y-auto bg-[var(--color-bar)] py-5">
        <p className="px-5 pb-4 text-sm font-semibold text-white">Brain</p>
        {groups.map((g) => (
          <div key={g.title} className="mb-4">
            <p className="px-5 pb-1 text-[11px] font-medium uppercase tracking-wide text-slate-500">{g.title}</p>
            {g.tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setView(tab.key)}
                className={`block w-full border-l-2 px-5 py-1.5 text-left text-sm ${
                  view === tab.key
                    ? 'border-[var(--color-indigo)] bg-white/10 text-white'
                    : 'border-transparent text-slate-400 hover:bg-white/5 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        ))}
        <div className="mt-auto px-5 pt-4 text-xs text-slate-400">
          <p className="truncate" title={session.user.email}>{session.user.email}</p>
          <button onClick={() => supabase.auth.signOut()} className="mt-1 rounded py-1 hover:text-white">Odjava</button>
        </div>
      </nav>
      <main className="min-w-0 flex-1">
      <div className="mx-auto max-w-6xl px-8 py-10">
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
        {view === 'review' && <MorningReview />}
        {view === 'budgets' && <Budgets />}
        {view === 'tasks' && <TaskBoard onOpen={setView} />}
        {view === 'done' && <WorkLog />}
        {view === 'products' && <ProductFeeds />}
        {view === 'proposal' && <PlanProposal />}
        {view === 'campaigns' && <CampaignBuilder />}
        {view === 'desk' && <PpcTaskDesk onOpen={setView} />}
      </div>
      </main>
    </div>
  )
}

export default App
