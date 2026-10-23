import { useState } from 'react'
import DataWorkspace from '../components/upload/DataWorkspace'
import { Badge, Button, Card, Modal, Skeleton, Tabs, Toast } from '../components/ui'

function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><span /><span /><span /><span /></span>
}

function DocsPreview() {
  const [modalOpen, setModalOpen] = useState(false)
  return (
    <main className="docs-page">
      <a className="back-link" href="/">← Back to workspace</a>
      <p className="eyebrow">DESIGN SYSTEM</p>
      <h1>Component preview</h1>
      <p className="muted">A small reference for the reusable interface building blocks.</p>
      <section className="preview-grid">
        <Card><h2>Actions</h2><div className="row"><Button>Primary action</Button><Button variant="secondary">Secondary</Button><Button variant="ghost">Quiet action</Button></div></Card>
        <Card><h2>Status</h2><div className="row"><Badge tone="success">Ready</Badge><Badge tone="warning">Review</Badge><Badge tone="danger">Issue</Badge><Badge>Neutral</Badge></div></Card>
        <Card><h2>Tabs</h2><Tabs items={['Overview', 'Columns', 'History']} /></Card>
        <Card><h2>Loading</h2><Skeleton /><Skeleton width="70%" /></Card>
        <Card><h2>Dialog</h2><Button onClick={() => setModalOpen(true)}>Open dialog</Button><Modal open={modalOpen} title="Example dialog" onClose={() => setModalOpen(false)}>Dialogs keep focus on a single task.</Modal></Card>
        <Card><h2>Toast</h2><Toast>Changes saved locally</Toast></Card>
      </section>
    </main>
  )
}

function Workspace() {
  const [dark, setDark] = useState(false)
  return <div className={dark ? 'app-shell dark transition-colors' : 'app-shell transition-colors'}>
    <header className="topbar">
      <a className="brand" href="/" aria-label="DataCleaner home"><BrandMark /><span>DataCleaner</span><span className="beta">BETA</span></a>
      <button className="theme-toggle" onClick={() => setDark(!dark)} aria-label={`Switch to ${dark ? 'light' : 'dark'} mode`} title="Toggle theme">{dark ? '☼' : '◐'}<span>{dark ? 'Light' : 'Dark'} mode</span></button>
    </header>
    <main className="workspace-main"><DataWorkspace /><div className="privacy-callout"><span aria-hidden="true">◇</span><p><strong>Private by design.</strong> Your data never leaves your browser.</p></div></main>
    <footer className="site-footer"><span>© 2026 DataCleaner</span><span>Thoughtful tools for better data</span><a href="/docs/components">Components</a></footer>
  </div>
}

export default function App() {
  return window.location.pathname === '/docs/components' ? <DocsPreview /> : <Workspace />
}
