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
import './index.css'

type View = 'summary' | 'client' | 'agency' | 'google_ads' | 'facebook_ads' | 'blended' | 'ga4' | 'owned' | 'chat'

function App() {
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [view, setView] = useState<View>('summary')

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
    })
    return () => listener.subscription.unsubscribe()
  }, [])

  const tabs: { key: View; label: string }[] = [
    { key: 'summary', label: 'Sažetak za direktora' },
    { key: 'chat', label: 'AI Chat' },
    { key: 'agency', label: 'Agencijski izveštaj' },
    { key: 'client', label: 'Po klijentu' },
    { key: 'google_ads', label: 'Google Ads' },
    { key: 'facebook_ads', label: 'Facebook Ads' },
    { key: 'blended', label: 'Blended' },
    { key: 'ga4', label: 'GA4' },
    { key: 'owned', label: 'Push & Newsletter' },
  ]

  // Still checking for an existing session — avoid flashing the login screen.
  if (session === undefined) {
    return <div className="flex min-h-screen items-center justify-center bg-[var(--color-paper)] text-[var(--color-ink-soft)]">Učitavanje…</div>
  }

  if (session === null) {
    return <Login />
  }

  return (
    <div className="min-h-screen bg-[var(--color-paper)]">
      <nav className="bg-[var(--color-bar)]">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-8">
          <div className="flex gap-6 overflow-x-auto">
            {tabs.map((tab) => (
              <button
                key={tab.key}
                onClick={() => setView(tab.key)}
                className={`whitespace-nowrap border-b-2 py-4 text-sm font-medium ${
                  view === tab.key
                    ? 'border-[var(--color-indigo)] text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-400">
            <span>{session.user.email}</span>
            <button onClick={() => supabase.auth.signOut()} className="rounded px-2 py-1 hover:bg-white/10 hover:text-white">
              Odjava
            </button>
          </div>
        </div>
      </nav>
      <div className="mx-auto max-w-5xl px-8 py-10">
        {view === 'summary' && <ExecutiveSummary />}
        {view === 'chat' && <ChatAssistant />}
        {view === 'agency' && <AgencyReport />}
        {view === 'client' && <Dashboard />}
        {view === 'google_ads' && <GoogleAdsReport />}
        {view === 'facebook_ads' && <FacebookAdsReport />}
        {view === 'blended' && <BlendedReport />}
        {view === 'ga4' && <Ga4Report />}
        {view === 'owned' && <OwnedChannelsReport />}
      </div>
    </div>
  )
}

export default App
