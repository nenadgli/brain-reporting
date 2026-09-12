import { useState } from 'react'
import { supabase } from '../lib/supabase'

export default function Login() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [errorMsg, setErrorMsg] = useState('')

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setStatus('sending')
    setErrorMsg('')
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin },
    })
    if (error) {
      setStatus('error')
      setErrorMsg(error.message)
    } else {
      setStatus('sent')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[var(--color-paper)] px-6">
      <div className="w-full max-w-sm">
        <p className="font-mono text-xs uppercase tracking-wide text-[var(--color-ink-soft)]">Brain Reporting Platform</p>
        <h1 className="font-display mt-1 mb-8 text-3xl font-medium">Prijava</h1>

        {status === 'sent' ? (
          <div className="rounded border border-[var(--color-line)] bg-white p-5">
            <p className="text-sm">
              Poslali smo link za prijavu na <strong>{email}</strong>. Otvori mejl i klikni na link — vratićeš se ovde ulogovan.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1 block text-sm text-[var(--color-ink-soft)]">Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ime@agencija.com"
                className="w-full rounded border border-[var(--color-line)] bg-white px-3 py-2 text-sm"
              />
            </div>
            {status === 'error' && <p className="text-sm text-[var(--color-rust)]">{errorMsg}</p>}
            <button
              type="submit"
              disabled={status === 'sending'}
              className="w-full rounded bg-[var(--color-indigo)] py-2 text-sm text-white disabled:opacity-50"
            >
              {status === 'sending' ? 'Šaljem…' : 'Pošalji link za prijavu'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
