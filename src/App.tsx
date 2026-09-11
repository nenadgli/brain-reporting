import { useState } from 'react'
import Dashboard from './pages/Dashboard'
import AgencyReport from './pages/AgencyReport'
import GoogleAdsReport from './pages/GoogleAdsReport'
import FacebookAdsReport from './pages/FacebookAdsReport'
import BlendedReport from './pages/BlendedReport'
import Ga4Report from './pages/Ga4Report'
import './index.css'

type View = 'client' | 'agency' | 'google_ads' | 'facebook_ads' | 'blended' | 'ga4'

function App() {
  const [view, setView] = useState<View>('agency')

  const tabs: { key: View; label: string }[] = [
    { key: 'agency', label: 'Agencijski izveštaj' },
    { key: 'client', label: 'Po klijentu' },
    { key: 'google_ads', label: 'Google Ads' },
    { key: 'facebook_ads', label: 'Facebook Ads' },
    { key: 'blended', label: 'Blended' },
    { key: 'ga4', label: 'GA4' },
  ]

  return (
    <div className="min-h-screen bg-[var(--color-paper)]">
      <nav className="border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-5xl gap-6 px-8">
          {tabs.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setView(tab.key)}
              className={`border-b-2 py-4 text-sm ${
                view === tab.key
                  ? 'border-[var(--color-indigo)] text-[var(--color-indigo)]'
                  : 'border-transparent text-[var(--color-ink-soft)]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </nav>
      <div className="mx-auto max-w-5xl px-8 py-10">
        {view === 'agency' && <AgencyReport />}
        {view === 'client' && <Dashboard />}
        {view === 'google_ads' && <GoogleAdsReport />}
        {view === 'facebook_ads' && <FacebookAdsReport />}
        {view === 'blended' && <BlendedReport />}
        {view === 'ga4' && <Ga4Report />}
      </div>
    </div>
  )
}

export default App
