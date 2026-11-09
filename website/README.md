# FUDISLTE website

The public landing page: what FUDISLTE is, its features, security model, architecture,
system requirements, installation steps, status and FAQ. Plain HTML, CSS and JavaScript —
no build step, no dependencies, no requests to other origins.

| File | Purpose |
| --- | --- |
| `index.html` | The page, written in Turkish (the default language) |
| `script.js` | English text (`EN`, same keys as the `data-i18n` attributes), language and theme switch, menu, tabs, copy buttons, repository links |
| `styles.css` | Styles; colours follow the product's tokens in `packages/ui/src/styles.css` |
| `theme-init.js` | Applies the saved or system theme before the first paint |
| `_headers` | Security headers for Cloudflare Pages |

## Before publishing

Set `REPO_URL` at the top of `script.js` to the public repository. Every GitHub link on the
page and the `git clone` command use it.

## Editing text

Change Turkish text in `index.html` and the English text under the same key in `script.js`.
A new translatable element needs a `data-i18n="key"` attribute (or
`data-i18n-attr="attribute:key"` for attributes) and an `EN` entry; without one the Turkish
text stays when English is selected. Measured numbers (memory, latency) come from
[docs/architecture/load-testing.md](../docs/architecture/load-testing.md) and the sizing
table from [docs/deployment/docker-compose.md](../docs/deployment/docker-compose.md); update
the page when those change.

Add `?lang=en` or `?lang=tr` to a link to open the page in that language.

## Preview locally

```bash
python3 -m http.server 8000 --directory website
```

Then open `http://localhost:8000`.

## Deploy to Cloudflare Pages

Connect the repository in the Cloudflare dashboard (*Workers & Pages → Create → Pages →
Connect to Git*) with:

- Framework preset: **None**
- Build command: *(empty)*
- Build output directory: **`website`**

Or upload the folder directly with Wrangler:

```bash
npx wrangler pages deploy website --project-name fudislte
```
