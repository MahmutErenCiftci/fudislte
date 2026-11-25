// A small notice that this is the demo, outside the React tree so the app stays as is.

const texts = {
  tr: { label: 'Demo', note: 'Veriler yalnızca bu tarayıcıda; yenileyince sıfırlanır.', reset: 'Sıfırla', hide: 'Gizle' },
  en: { label: 'Demo', note: 'Data stays in this browser and resets on reload.', reset: 'Reset', hide: 'Hide' },
}

export function showDemoBanner() {
  const bar = document.createElement('div')
  bar.setAttribute('role', 'status')
  Object.assign(bar.style, {
    position: 'fixed',
    // Bottom right, over the people panel rather than the message composer.
    right: '16px',
    bottom: '16px',
    zIndex: '2147483000',
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    maxWidth: 'calc(100vw - 32px)',
    padding: '6px 8px 6px 12px',
    borderRadius: '999px',
    background: 'rgba(17, 24, 39, 0.92)',
    color: '#f9fafb',
    font: '500 12px/1.3 "Inter Variable", system-ui, sans-serif',
    boxShadow: '0 6px 24px rgba(0, 0, 0, 0.25)',
    pointerEvents: 'auto',
  } satisfies Partial<CSSStyleDeclaration>)

  const button = (onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    Object.assign(b.style, {
      border: '0',
      borderRadius: '999px',
      padding: '4px 10px',
      background: 'rgba(255, 255, 255, 0.14)',
      color: 'inherit',
      font: 'inherit',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>)
    b.addEventListener('click', onClick)
    return b
  }
  const label = document.createElement('strong')
  Object.assign(label.style, { background: '#f97316', color: '#111827', borderRadius: '999px', padding: '2px 8px' })
  const note = document.createElement('span')
  const reset = button(() => window.location.assign('/'))
  const hide = button(() => bar.remove())

  const render = () => {
    const t = document.documentElement.lang === 'en' ? texts.en : texts.tr
    label.textContent = t.label
    note.textContent = t.note
    reset.textContent = t.reset
    hide.textContent = '✕'
    hide.setAttribute('aria-label', t.hide)
    hide.title = t.hide
  }
  render()
  new MutationObserver(render).observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })

  bar.append(label, note, reset, hide)
  document.body.append(bar)
}
