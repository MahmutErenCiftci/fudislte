# FUDISLTE Presence

Shows **Coding** as your FUDISLTE status while you actively work in VS Code, and nothing
more. Off until you turn it on.

## What is shared

- The status kind `coding` with the text `VS Code`. Only if you turn them on, the text
  also names the workspace folder (`fudislte.presence.shareProject`) and the language of
  the active editor (`fudislte.presence.shareLanguage`), for example
  `VS Code · fudislte-api · TypeScript`.
- The status is set on your first activity (typing, moving the cursor, scrolling, switching editors,
  focusing the window), refreshed at most every 5 minutes, and cleared after
  `fudislte.presence.idleMinutes` (default 10) without activity or when VS Code closes.
  Each status also expires by itself after 15 minutes.

## What is never shared

File names, paths, file contents, keystrokes or counts of anything, git data (branches,
commits, remotes), working hours. A folder name that looks like a path is dropped
entirely. The extension has no telemetry.

## Your own status wins

If you set a status in FUDISLTE yourself (a meeting, focus time, a custom text), the
extension neither replaces nor clears it.

## Connect

Requires a FUDISLTE server that issues personal access tokens with the `status:write`
scope.

1. Run **FUDISLTE: Connect** and enter your server address (`https://`; plain `http://`
   only for `localhost`) and your token. The token is kept only in VS Code's secret
   storage on this computer and sent only to that server.
2. Click **FUDISLTE** in the status bar, or run **FUDISLTE: Toggle Presence Sharing**.

**FUDISLTE: Disconnect** clears the status this extension set and removes the token.
Settings are read from your user settings only, so a workspace cannot turn sharing on
or redirect the token.

---

# FUDISLTE Durum Paylaşımı

VS Code'da etkin olarak çalışırken FUDISLTE durumunuzu **Kod yazıyor** olarak gösterir;
başka hiçbir şey göndermez. Siz açana kadar kapalıdır.

## Paylaşılanlar

- `coding` durum türü ve `VS Code` metni. Yalnızca siz açarsanız metne çalışma alanı
  klasörünün adı (`fudislte.presence.shareProject`) ve etkin düzenleyicinin dili
  (`fudislte.presence.shareLanguage`) eklenir; örneğin `VS Code · fudislte-api · TypeScript`.
- Durum ilk etkinliğinizde (yazma, imleci taşıma, kaydırma, düzenleyici değiştirme, pencereye
  odaklanma) ayarlanır, en fazla 5 dakikada bir yenilenir ve
  `fudislte.presence.idleMinutes` (varsayılan 10) dakika etkinlik olmazsa ya da VS Code
  kapanınca temizlenir. Her durum 15 dakika sonra kendiliğinden de sona erer.

## Asla paylaşılmayanlar

Dosya adları, yollar, dosya içerikleri, tuş vuruşları ya da herhangi bir sayım, git
verileri (dallar, commit'ler, uzak depolar), çalışma süreleri. Yol gibi görünen bir
klasör adı tümüyle atlanır. Eklentide telemetri yoktur.

## Sizin durumunuz önceliklidir

FUDISLTE'de kendiniz bir durum ayarladıysanız (toplantı, odaklanma, özel metin), eklenti
onu ne değiştirir ne de temizler.

## Bağlanma

`status:write` kapsamlı kişisel erişim belirteçleri veren bir FUDISLTE sunucusu gerekir.

1. **FUDISLTE: Bağlan** komutunu çalıştırın; sunucu adresinizi (`https://`; düz `http://`
   yalnızca `localhost` için) ve belirtecinizi girin. Belirteç yalnızca bu bilgisayardaki
   VS Code gizli depolamasında tutulur ve yalnızca o sunucuya gönderilir.
2. Durum çubuğundaki **FUDISLTE** öğesine tıklayın ya da **FUDISLTE: Durum paylaşımını
   aç/kapat** komutunu çalıştırın.

**FUDISLTE: Bağlantıyı kes** bu eklentinin ayarladığı durumu temizler ve belirteci siler.
Ayarlar yalnızca kullanıcı ayarlarınızdan okunur; bir çalışma alanı paylaşımı açamaz ya
da belirteci başka bir yere yönlendiremez.
