import { useState } from 'react'
import Dashboard from './pages/Dashboard'
import AgencyReport from './pages/AgencyReport'
import './index.css'

type View = 'client' | 'agency'

function App() {
  const [view, setView] = useState<View>('agency')

  return (
    <div className="min-h-screen bg-[var(--color-paper)]">
      <nav className="border-b border-[var(--color-line)] bg-white">
        <div className="mx-auto flex max-w-5xl gap-6 px-8">
          <button
            onClick={() => setView('agency')}
            className={`border-b-2 py-4 text-sm ${
              view === 'agency'
                ? 'border-[var(--color-indigo)] text-[var(--color-indigo)]'
                : 'border-transparent text-[var(--color-ink-soft)]'
            }`}
          >
            Agencijski izveštaj
          </button>
          <button
            onClick={() => setView('client')}
            className={`border-b-2 py-4 text-sm ${
              view === 'client'
                ? 'border-[var(--color-indigo)] text-[var(--color-indigo)]'
                : 'border-transparent text-[var(--color-ink-soft)]'
            }`}
          >
            Po klijentu
          </button>
        </div>
      </nav>
      <div className="mx-auto max-w-5xl px-8 py-10">
        {view === 'agency' ? <AgencyReport /> : <Dashboard />}
      </div>
    </div>
  )
}

export default App
