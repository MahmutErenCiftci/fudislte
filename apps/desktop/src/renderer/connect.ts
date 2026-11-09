type ConnectResult = { ok: true; origin: string; version: string } | { ok: false; error: string }

interface ConnectApi {
  version: string
  probe(url: string): Promise<ConnectResult>
  connect(url: string): Promise<ConnectResult>
}

const api = (window as unknown as { fudislteConnect: ConnectApi }).fudislteConnect

const form = document.querySelector('form')!
const input = document.querySelector<HTMLInputElement>('#server')!
const error = document.querySelector<HTMLParagraphElement>('#error')!
const button = document.querySelector<HTMLButtonElement>('button')!

document.querySelector('#version')!.textContent = `FUDISLTE Desktop ${api.version}`

form.addEventListener('submit', async (event) => {
  event.preventDefault()
  error.textContent = ''
  button.disabled = true
  button.textContent = 'Connecting…'
  // On success the main process replaces this page with the server's web app.
  const result = await api.connect(input.value)
  if (!result.ok) {
    error.textContent = result.error
    button.disabled = false
    button.textContent = 'Connect'
    input.focus()
  }
})
