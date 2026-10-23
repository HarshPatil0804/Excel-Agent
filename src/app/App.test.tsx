import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import App from './App'

describe('workspace shell', () => {
  it('shows the uploader and privacy promise', () => {
    window.history.pushState({}, '', '/')
    render(<App />)
    expect(screen.getByText('Drop your file here')).toBeInTheDocument()
    expect(screen.getByText('CSV, TSV, Excel, or JSON')).toBeInTheDocument()
    expect(screen.getByText(/Your data never leaves your browser/)).toBeInTheDocument()
  })
})
