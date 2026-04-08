import { useEffect, useState } from 'react'
import './App.css'

declare global {
  interface Window {
    quickhide: {
      getSettings: () => Promise<{ lootFilterPath: string }>
      browseLootFilter: () => Promise<{ lootFilterPath: string | null }>
      setLootFilterPath: (value: string) => Promise<{ lootFilterPath: string }>
      testAppend: () => Promise<{ itemText: string; rule: string; path: string }>
      onAppended: (cb: (payload: { itemText: string; rule: string; path: string }) => void) => void
      onError: (cb: (payload: { message: string }) => void) => void
    }
  }
}

function App() {
  const [lootFilterPath, setLootFilterPath] = useState('')
  const [status, setStatus] = useState('Idle')
  const [lastItemText, setLastItemText] = useState('')
  const [lastRule, setLastRule] = useState('')

  useEffect(() => {
    void window.quickhide.getSettings().then(({ lootFilterPath }) => setLootFilterPath(lootFilterPath || ''))
    window.quickhide.onAppended(({ itemText, rule, path }) => {
      setStatus(`Appended hide rule to ${path}`)
      setLastItemText(itemText)
      setLastRule(rule)
    })
    window.quickhide.onError(({ message }) => {
      setStatus(`Error: ${message}`)
    })
  }, [])

  async function browse() {
    const result = await window.quickhide.browseLootFilter()
    if (result.lootFilterPath) {
      setLootFilterPath(result.lootFilterPath)
      setStatus('Loot filter path updated')
    }
  }

  async function savePath(value: string) {
    setLootFilterPath(value)
    await window.quickhide.setLootFilterPath(value)
    setStatus('Loot filter path saved')
  }

  async function testAppend() {
    setStatus('Waiting for hovered PoE item...')
    try {
      const result = await window.quickhide.testAppend()
      setLastItemText(result.itemText)
      setLastRule(result.rule)
      setStatus(`Appended hide rule to ${result.path}`)
    } catch (error) {
      setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return (
    <div className="app-shell">
      <h1>Poe Quickhide Filter</h1>
      <p>PoC: press <strong>Ctrl+H</strong> while hovering an item in PoE 1.</p>

      <section className="card">
        <h2>Settings</h2>
        <label>
          Loot filter path
          <div className="row">
            <input
              type="text"
              value={lootFilterPath}
              onChange={(e) => setLootFilterPath(e.target.value)}
              onBlur={(e) => void savePath(e.target.value)}
              placeholder="C:\\Path\\To\\Your.filter"
            />
            <button onClick={() => void browse()}>Browse</button>
          </div>
        </label>
      </section>

      <section className="card">
        <h2>Actions</h2>
        <div className="row">
          <button onClick={() => void testAppend()}>Test append from hovered item</button>
        </div>
        <p>{status}</p>
      </section>

      <section className="card">
        <h2>Last captured item text</h2>
        <pre>{lastItemText || 'None yet'}</pre>
      </section>

      <section className="card">
        <h2>Last appended rule</h2>
        <pre>{lastRule || 'None yet'}</pre>
      </section>
    </div>
  )
}

export default App
