type ConnectResult = { ok: true; origin: string; version: string } | { ok: false; error: string }

interface ConnectApi {
  version: string
  probe(url: string): Promise<ConnectResult>
  connect(url: string, key?: string | null): Promise<ConnectResult>
}

const api = (window as unknown as { fudislteConnect: ConnectApi }).fudislteConnect

const TEXT = {
  en: {
    pageTitle: 'Connect to FUDISLTE',
    title: 'Connect to your workspace',
    lead: "Enter the address of your organization's FUDISLTE server.",
    server: 'Server address',
    serverExample: 'fudislte.your-company.com',
    key: 'Access key',
    keyHint: 'The single-use key your IT team gave you. It opens your account without an email code.',
    connect: 'Connect',
    connectWithKey: 'Connect and sign in',
    connecting: 'Connecting…',
    haveKey: 'I have an access key',
    noKey: 'Sign in with email instead',
    note: 'Your organization runs this server. FUDISLTE Desktop only connects to the address you enter.',
    keyIncomplete: 'Enter the whole key: 20 letters and digits, such as ABCDE-12345-FGHJK-67890.',
  },
  tr: {
    pageTitle: "FUDISLTE'ye bağlan",
    title: 'Çalışma alanınıza bağlanın',
    lead: 'Kurumunuzun FUDISLTE sunucusunun adresini girin.',
    server: 'Sunucu adresi',
    serverExample: 'fudislte.sirketiniz.com',
    key: 'Erişim anahtarı',
    keyHint: 'BT ekibinizin verdiği tek kullanımlık anahtar. Hesabınızı e-posta kodu beklemeden açar.',
    connect: 'Bağlan',
    connectWithKey: 'Bağlan ve giriş yap',
    connecting: 'Bağlanıyor…',
    haveKey: 'Erişim anahtarım var',
    noKey: 'E-postayla giriş yapacağım',
    note: 'Bu sunucuyu kurumunuz işletir. FUDISLTE Desktop yalnızca girdiğiniz adrese bağlanır.',
    keyIncomplete: 'Anahtarın tamamını girin: ABCDE-12345-FGHJK-67890 gibi 20 harf ve rakam.',
  },
}

const lang: keyof typeof TEXT = navigator.language.toLowerCase().startsWith('tr') ? 'tr' : 'en'
const t = TEXT[lang]

const form = document.querySelector('form')!
const server = document.querySelector<HTMLInputElement>('#server')!
const key = document.querySelector<HTMLInputElement>('#key')!
const keyRow = document.querySelector<HTMLDivElement>('#key-row')!
const toggle = document.querySelector<HTMLButtonElement>('#toggle-key')!
const error = document.querySelector<HTMLParagraphElement>('#error')!
const submit = document.querySelector<HTMLButtonElement>('#submit')!

document.documentElement.lang = lang
document.title = t.pageTitle
for (const el of document.querySelectorAll<HTMLElement>('[data-t]')) {
  const value = t[el.dataset.t as keyof typeof t]
  if (typeof value === 'string') el.textContent = value
}
server.placeholder = t.serverExample
// FUDISLTE is in beta ("Beta v0.1" for 0.1.x); drop the label here and in the release
// workflow when it is not.
const series = api.version.split('.').slice(0, 2).join('.')
document.querySelector('#version')!.textContent = `FUDISLTE Desktop Beta v${series} (${api.version})`

function usingKey() {
  return !keyRow.hidden
}

function label() {
  return usingKey() ? t.connectWithKey : t.connect
}

toggle.addEventListener('click', () => {
  keyRow.hidden = !keyRow.hidden
  toggle.setAttribute('aria-expanded', String(usingKey()))
  toggle.textContent = usingKey() ? t.noKey : t.haveKey
  submit.textContent = label()
  error.textContent = ''
  if (usingKey()) key.focus()
  else key.value = ''
})

// The same rules as the server: any case, spaces and dashes; O reads as 0, I and L as 1.
function keyLooksComplete(value: string) {
  const compact = value.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
  return /^[0-9A-HJKMNP-TV-Z]{20}$/.test(compact)
}

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  error.textContent = ''
  if (usingKey() && !keyLooksComplete(key.value)) {
    error.textContent = t.keyIncomplete
    key.focus()
    return
  }
  submit.disabled = true
  toggle.disabled = true
  submit.textContent = t.connecting
  // On success the main process replaces this page with the server's web app.
  const result = await api.connect(server.value, usingKey() ? key.value : null)
  if (!result.ok) {
    error.textContent = result.error
    submit.disabled = false
    toggle.disabled = false
    submit.textContent = label()
    ;(usingKey() && /key|anahtar/i.test(result.error) ? key : server).focus()
  }
})
