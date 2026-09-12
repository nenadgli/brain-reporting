import { useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'

type ChatMessage = { role: 'user' | 'assistant'; text: string }

const SUGGESTIONS = [
  'Uporedi Google Ads i Meta performanse za Fashion&Friends ovog perioda',
  'Koji Google Ads search termini troše novac bez konverzija?',
  'Koje su top 3 kampanje po ROAS-u za Planiku?',
  'Da li se GA4 slaže sa onim što Google Ads prijavljuje?',
]

export default function ChatAssistant() {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [history, setHistory] = useState<unknown[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  async function send(text: string) {
    if (!text.trim() || loading) return
    setError(null)
    setMessages((m) => [...m, { role: 'user', text }])
    setInput('')
    setLoading(true)

    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const token = sessionData.session?.access_token
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message: text, history }),
      })
      const json = await res.json()
      if (!res.ok || json.error) throw new Error(json.error ?? 'Nepoznata greška')

      setMessages((m) => [...m, { role: 'assistant', text: json.answer }])
      setHistory(json.history ?? [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="mx-auto flex h-[75vh] max-w-3xl flex-col">
      <header className="mb-4 border-b border-[var(--color-line)] pb-4">
        <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">AI asistent</p>
        <h1 className="font-display mt-1 text-3xl font-medium">Pitaj svoje podatke</h1>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto pr-1">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="mb-3 text-sm text-[var(--color-ink-soft)]">Probaj neko od ovih pitanja:</p>
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s)}
                className="block w-full rounded border border-[var(--color-line)] bg-white px-4 py-2.5 text-left text-sm hover:border-[var(--color-indigo)]"
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded px-4 py-2.5 text-sm ${
                m.role === 'user' ? 'bg-[var(--color-indigo)] text-white' : 'border border-[var(--color-line)] bg-white'
              }`}
            >
              {m.text}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="rounded border border-[var(--color-line)] bg-white px-4 py-2.5 text-sm text-[var(--color-ink-soft)]">
              Razmišljam…
            </div>
          </div>
        )}

        {error && <p className="text-sm text-[var(--color-rust)]">{error}</p>}
        <div ref={bottomRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          send(input)
        }}
        className="mt-4 flex gap-2 border-t border-[var(--color-line)] pt-4"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Postavi pitanje o podacima…"
          className="flex-1 rounded border border-[var(--color-line)] bg-white px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded bg-[var(--color-indigo)] px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Pošalji
        </button>
      </form>
    </div>
  )
}
