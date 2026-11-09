package main

import (
	"html/template"
	"log/slog"
	"net/http"
	"strings"
	"time"
)

// An instance counts as active while it keeps sending its daily report.
const activeWithin = 72 * time.Hour

var texts = map[string]map[string]string{
	"tr": {
		"title":     "FUDISLTE kurulumları",
		"summary":   "kurulum",
		"active":    "son 3 günde etkin",
		"users":     "kullanıcı (etkin kurulumlarda)",
		"org":       "Şirket",
		"contact":   "İletişim",
		"userCount": "Kullanıcı",
		"version":   "Sürüm",
		"first":     "İlk kayıt",
		"last":      "Son bildirim",
		"empty":     "Henüz kayıtlı kurulum yok. Kurulumlar, yöneticileri kaydı onayladığında burada görünür.",
		"export":    "CSV olarak indir",
		"note":      "Yalnızca yöneticilerin onayladığı bilgiler: şirket adı, iletişim e-postası, kullanıcı sayısı ve sürüm. Saatler UTC.",
	},
	"en": {
		"title":     "FUDISLTE installations",
		"summary":   "installations",
		"active":    "active in the last 3 days",
		"users":     "users (in active installations)",
		"org":       "Organization",
		"contact":   "Contact",
		"userCount": "Users",
		"version":   "Version",
		"first":     "Registered",
		"last":      "Last report",
		"empty":     "No installations yet. They appear here once their administrators agree to register.",
		"export":    "Download CSV",
		"note":      "Only what administrators agreed to share: organization name, contact email, number of users and version. Times are UTC.",
	},
}

func language(r *http.Request) string {
	for part := range strings.SplitSeq(r.Header.Get("Accept-Language"), ",") {
		tag := strings.ToLower(strings.TrimSpace(part))
		if strings.HasPrefix(tag, "tr") {
			return "tr"
		}
		if strings.HasPrefix(tag, "en") {
			return "en"
		}
	}
	return "tr"
}

type row struct {
	Instance
	Active bool
}

type pageData struct {
	Lang        string
	T           map[string]string
	Rows        []row
	Total       int
	ActiveCount int
	ActiveUsers int
}

var pageTemplate = template.Must(template.New("page").Funcs(template.FuncMap{
	"date": func(t time.Time) string { return t.UTC().Format("2006-01-02 15:04") },
}).Parse(`<!doctype html>
<html lang="{{.Lang}}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>{{.T.title}}</title>
<style>
:root { color-scheme: light dark; --bg: #f7f8fa; --card: #fff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --accent: #2563eb; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b0f17; --card: #111827; --fg: #f3f4f6; --muted: #9ca3af; --line: #1f2937; --accent: #60a5fa; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px 16px; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 1100px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
.logo { display: inline-flex; width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: #fff; align-items: center; justify-content: center; font-weight: 700; }
.summary { color: var(--muted); margin: 0 0 16px; }
.summary b { color: var(--fg); }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); white-space: nowrap; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
tr:last-child td { border-bottom: 0; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
tr.idle td { color: var(--muted); }
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 8px; background: var(--line); }
tr:not(.idle) .dot { background: #16a34a; }
a { color: var(--accent); }
.empty { padding: 32px 16px; text-align: center; color: var(--muted); }
footer { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; margin-top: 12px; color: var(--muted); font-size: 12px; }
</style>
</head>
<body>
<main>
<h1><span class="logo">F</span>{{.T.title}}</h1>
<p class="summary"><b>{{.Total}}</b> {{.T.summary}} · <b>{{.ActiveCount}}</b> {{.T.active}} · <b>{{.ActiveUsers}}</b> {{.T.users}}</p>
<div class="card">
{{if .Rows}}
<table>
<thead><tr><th>{{.T.org}}</th><th>{{.T.contact}}</th><th class="num">{{.T.userCount}}</th><th>{{.T.version}}</th><th>{{.T.first}}</th><th>{{.T.last}}</th></tr></thead>
<tbody>
{{range .Rows}}<tr{{if not .Active}} class="idle"{{end}}>
<td><span class="dot"></span>{{.OrganizationName}}</td>
<td><a href="mailto:{{.ContactEmail}}">{{.ContactEmail}}</a></td>
<td class="num">{{.UserCount}}</td>
<td>{{.Version}}</td>
<td>{{date .FirstSeen}}</td>
<td>{{date .LastSeen}}</td>
</tr>
{{end}}
</tbody>
</table>
{{else}}<p class="empty">{{.T.empty}}</p>{{end}}
</div>
<footer><span>{{.T.note}}</span><a href="/instances.csv">{{.T.export}}</a></footer>
</main>
</body>
</html>
`))

func (s *Server) page(w http.ResponseWriter, r *http.Request) {
	lang := language(r)
	data := pageData{Lang: lang, T: texts[lang]}
	now := s.now()
	for _, in := range s.store.List() {
		active := now.Sub(in.LastSeen) <= activeWithin
		data.Rows = append(data.Rows, row{Instance: in, Active: active})
		if active {
			data.ActiveCount++
			data.ActiveUsers += in.UserCount
		}
	}
	data.Total = len(data.Rows)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	if err := pageTemplate.Execute(w, data); err != nil {
		slog.Error("rendering the list failed", "error", err)
	}
}
