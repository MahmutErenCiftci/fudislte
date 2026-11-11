// The screen-share picker. It is part of the desktop app, not the server's page: the page
// asks to share, and only what the person picks here is handed to it. The page never sees
// the list of windows or their thumbnails.

export {}

interface PickerSource {
  id: string
  name: string
  kind: 'screen' | 'window'
  thumbnail: string
}

interface PickerRequest {
  server: string
  lang: 'tr' | 'en'
  sources: PickerSource[]
}

interface PickerApi {
  request(): Promise<PickerRequest | null>
  choose(sourceId: string | null): Promise<void>
}

const api = (window as unknown as { fudisltePicker: PickerApi }).fudisltePicker

const TEXT = {
  en: {
    title: 'Share your screen',
    screens: 'Screens',
    windows: 'Windows',
    none: 'Nothing to show.',
    cancel: 'Cancel',
    share: 'Share',
  },
  tr: {
    title: 'Ekranınızı paylaşın',
    screens: 'Ekranlar',
    windows: 'Pencereler',
    none: 'Gösterilecek bir şey yok.',
    cancel: 'Vazgeç',
    share: 'Paylaş',
  },
}

const LEAD: Record<PickerRequest['lang'], [string, string]> = {
  en: ['', ' wants to see your screen. Choose what to share.'],
  tr: ['', ' ekranınızı görmek istiyor. Neyi paylaşacağınızı seçin.'],
}

let selected: string | null = null
const shareButton = document.querySelector<HTMLButtonElement>('#share')!
const cancelButton = document.querySelector<HTMLButtonElement>('#cancel')!

function setText(id: string, text: string) {
  document.getElementById(id)!.textContent = text
}

function render(request: PickerRequest) {
  const t = TEXT[request.lang]
  document.documentElement.lang = request.lang
  document.title = t.title
  setText('title', t.title)
  setText('screens-title', t.screens)
  setText('windows-title', t.windows)
  cancelButton.textContent = t.cancel
  shareButton.textContent = t.share

  // Built with text nodes only: window titles come from other applications.
  const lead = document.getElementById('lead')!
  const strong = document.createElement('strong')
  strong.textContent = request.server
  lead.replaceChildren(LEAD[request.lang][0], strong, LEAD[request.lang][1])

  const buttons: HTMLButtonElement[] = []
  for (const kind of ['screen', 'window'] as const) {
    const grid = document.getElementById(kind === 'screen' ? 'screens' : 'windows')!
    const sources = request.sources.filter((s) => s.kind === kind)
    if (sources.length === 0) {
      const p = document.createElement('p')
      p.className = 'empty'
      p.textContent = t.none
      grid.replaceChildren(p)
      continue
    }
    grid.replaceChildren(
      ...sources.map((source) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'source'
        button.setAttribute('role', 'radio')
        button.setAttribute('aria-checked', 'false')
        button.dataset.id = source.id
        const img = document.createElement('img')
        img.alt = ''
        if (source.thumbnail.startsWith('data:image/')) img.src = source.thumbnail
        const label = document.createElement('span')
        label.textContent = source.name
        label.title = source.name
        button.append(img, label)
        button.addEventListener('click', () => select(source.id, buttons))
        button.addEventListener('dblclick', () => {
          select(source.id, buttons)
          void finish(source.id)
        })
        buttons.push(button)
        return button
      }),
    )
  }
  buttons[0]?.focus()
}

function select(id: string, buttons: HTMLButtonElement[]) {
  selected = id
  for (const b of buttons) b.setAttribute('aria-checked', String(b.dataset.id === id))
  shareButton.disabled = false
}

let finished = false
async function finish(sourceId: string | null) {
  if (finished) return
  finished = true
  await api.choose(sourceId)
}

shareButton.addEventListener('click', () => {
  if (selected) void finish(selected)
})
cancelButton.addEventListener('click', () => void finish(null))
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void finish(null)
})

void api.request().then((request) => {
  if (request) render(request)
  else void finish(null)
})
