// Sample workspace for the browser-only demo: people, channels, conversations and
// messages in Turkish and English. Times are relative to when the demo opens.

export type DemoLanguage = 'tr' | 'en'

type Text = { tr: string; en: string }
const L = (tr: string, en: string): Text => ({ tr, en })

export const ME = '0a000000-0000-4000-8000-000000000001'

export interface SeedPerson {
  id: string
  name: Text
  email: string
  roleKey: 'owner' | 'member'
  presence: 'online' | 'away' | 'offline'
  status?: { kind: 'meeting' | 'coding' | 'focus' | 'call' | 'custom'; text: Text }
}

export const people: SeedPerson[] = [
  { id: ME, name: L('Demo Kullanıcı', 'Demo User'), email: 'demo@nova.example', roleKey: 'member', presence: 'online' },
  {
    id: '0a000000-0000-4000-8000-000000000002',
    name: L('Elif Kaya', 'Elif Kaya'),
    email: 'elif@nova.example',
    roleKey: 'owner',
    presence: 'online',
    status: { kind: 'focus', text: L('Yol haritası üzerinde', 'Working on the roadmap') },
  },
  {
    id: '0a000000-0000-4000-8000-000000000003',
    name: L('Can Demir', 'Can Demir'),
    email: 'can@nova.example',
    roleKey: 'member',
    presence: 'online',
    status: { kind: 'coding', text: L('API sürüm 2', 'API version 2') },
  },
  {
    id: '0a000000-0000-4000-8000-000000000004',
    name: L('Zeynep Arslan', 'Zeynep Arslan'),
    email: 'zeynep@nova.example',
    roleKey: 'member',
    presence: 'away',
  },
  {
    id: '0a000000-0000-4000-8000-000000000005',
    name: L('Mert Yılmaz', 'Mert Yılmaz'),
    email: 'mert@nova.example',
    roleKey: 'member',
    presence: 'online',
    status: { kind: 'meeting', text: L('Sprint planlaması', 'Sprint planning') },
  },
  {
    id: '0a000000-0000-4000-8000-000000000006',
    name: L('Ayşe Öztürk', 'Ayşe Öztürk'),
    email: 'ayse@nova.example',
    roleKey: 'member',
    presence: 'offline',
  },
  {
    id: '0a000000-0000-4000-8000-000000000007',
    name: L('Burak Şahin', 'Burak Şahin'),
    email: 'burak@nova.example',
    roleKey: 'member',
    presence: 'online',
  },
]

const [, elif, can, zeynep, mert, ayse, burak] = people.map((p) => p.id) as [string, string, string, string, string, string, string]
const everyone = people.map((p) => p.id)
const m = (id: string) => `<@${id}>`

export const workspaceName = L('Nova Yazılım', 'Nova Software')
export const workspaceSlug = 'nova'

export interface SeedMessage {
  key?: string
  author: string
  /** Minutes before the demo opened. */
  ago: number
  text: Text
  /** Key of the thread root this message replies to. */
  replyTo?: string
  reactions?: [emoji: string, userIds: string[]][]
  pinnedBy?: string
}

export interface SeedChannel {
  id: string
  kind: 'channel' | 'direct'
  name: Text
  topic: Text
  visibility: 'public' | 'private'
  isDefault?: boolean
  createdBy: string
  members: string[]
  /** The demo user has read up to this many messages from the end unread. */
  unread?: number
  messages: SeedMessage[]
}

const H = 60
const D = 24 * H

export const channels: SeedChannel[] = [
  {
    id: '0c000000-0000-4000-8000-000000000001',
    kind: 'channel',
    name: L('genel', 'general'),
    topic: L('Şirket geneli duyurular ve sohbet', 'Company-wide announcements and chat'),
    visibility: 'public',
    isDefault: true,
    createdBy: elif,
    members: everyone,
    messages: [
      {
        author: elif,
        ago: 2 * D + 30,
        text: L(
          'Herkese merhaba! FUDISLTE artık resmi çalışma alanımız 🎉 Kanallar, odalar, projeler ve beyaz tahtalar hepsi burada, hem de kendi sunucumuzda.',
          'Hi everyone! FUDISLTE is now our official workspace 🎉 Channels, rooms, projects and whiteboards all live here, on our own server.',
        ),
        reactions: [
          ['🎉', [can, zeynep, mert, burak]],
          ['🚀', [can, ayse]],
        ],
        pinnedBy: elif,
      },
      {
        author: burak,
        ago: 2 * D + 20,
        text: L(
          'Yedekler her gece 03:00’te alınıyor, geri yükleme testi de geçti. Sorun görürseniz bana yazın.',
          'Backups run every night at 03:00 and the restore drill passed. Ping me if anything looks off.',
        ),
        reactions: [['👍', [elif, can]]],
      },
      {
        author: mert,
        ago: D + 3 * H,
        text: L('Masaüstü uygulamasını kuran var mı? Windows’ta çok hızlı açılıyor.', 'Has anyone installed the desktop app? It opens really fast on Windows.'),
      },
      {
        author: zeynep,
        ago: D + 3 * H - 5,
        text: L('Ben Mac’te kullanıyorum, karanlık tema çok güzel olmuş 🌙', 'I use it on my Mac — the dark theme looks great 🌙'),
        reactions: [['❤️', [mert]]],
      },
      {
        author: elif,
        ago: 50,
        text: L(
          `Hatırlatma: Cuma 14:00’te demo günü var. ${m(ME)} sen de katılabilir misin?`,
          `Reminder: demo day is on Friday at 14:00. ${m(ME)} can you join too?`,
        ),
      },
      {
        author: can,
        ago: 12,
        text: L('Ben hazırım, API tarafını göstereceğim 💪', 'I’m in, I’ll show the API side 💪'),
      },
    ],
    unread: 2,
  },
  {
    id: '0c000000-0000-4000-8000-000000000002',
    kind: 'channel',
    name: L('ürün', 'product'),
    topic: L('Yol haritası, özellik fikirleri ve kararlar', 'Roadmap, feature ideas and decisions'),
    visibility: 'public',
    createdBy: elif,
    members: [ME, elif, can, zeynep, mert, ayse],
    messages: [
      {
        key: 'roadmap',
        author: elif,
        ago: 5 * H,
        text: L(
          'Bir sonraki sürüm için üç başlık öneriyorum:\n1. Bilgi bankası\n2. Geliştirici entegrasyonları (webhook, bot)\n3. Mobil bildirim iyileştirmeleri\nFikirleriniz?',
          'For the next release I suggest three themes:\n1. Knowledge base\n2. Developer integrations (webhooks, bots)\n3. Better mobile notifications\nThoughts?',
        ),
        reactions: [['👀', [can, mert]]],
      },
      {
        author: can,
        ago: 5 * H - 10,
        replyTo: 'roadmap',
        text: L('Webhook’lar için altyapı hazır sayılır, iki sprintte çıkarabiliriz.', 'The groundwork for webhooks is mostly there; we could ship it in two sprints.'),
      },
      {
        author: zeynep,
        ago: 5 * H - 25,
        replyTo: 'roadmap',
        text: L('Bilgi bankası için taslak ekranları bu hafta paylaşırım ✏️', 'I’ll share draft screens for the knowledge base this week ✏️'),
        reactions: [['🙌', [elif]]],
      },
      {
        author: ayse,
        ago: 4 * H,
        replyTo: 'roadmap',
        text: L(
          `Test planını ben hazırlayayım. ${m(ME)} sen de öncelik sırası hakkında ne düşünüyorsun?`,
          `I’ll prepare the test plan. ${m(ME)} what do you think about the priority order?`,
        ),
      },
      {
        author: mert,
        ago: 3 * H,
        text: L(
          'Müşteri görüşmesinden not: en çok istenen şey “kendi sunucumuzda, kişi başı ücret olmadan” olması. Tam bizim konumumuz 👌',
          'Note from the customer call: the top request is “on our own server, no per-seat fee”. That is exactly our position 👌',
        ),
        reactions: [['💯', [elif, can, zeynep]]],
        pinnedBy: elif,
      },
      {
        author: elif,
        ago: 40,
        text: L('Yarın 10:00’da kısa bir önceliklendirme toplantısı yapalım mı?', 'Shall we have a short prioritization meeting tomorrow at 10:00?'),
      },
    ],
    unread: 1,
  },
  {
    id: '0c000000-0000-4000-8000-000000000003',
    kind: 'channel',
    name: L('tasarım', 'design'),
    topic: L('Arayüz, marka ve kullanıcı deneyimi', 'Interface, brand and user experience'),
    visibility: 'public',
    createdBy: zeynep,
    members: [ME, elif, zeynep, mert],
    messages: [
      {
        author: zeynep,
        ago: D + 6 * H,
        text: L(
          'Yeni renk paleti: birincil mavi #2563EB, vurgu turuncu #F97316. Karanlık temada kontrastı 4.5:1’in üstünde tuttum.',
          'New palette: primary blue #2563EB, accent orange #F97316. In the dark theme contrast stays above 4.5:1.',
        ),
        reactions: [
          ['😍', [elif, mert]],
          ['✅', [mert]],
        ],
      },
      {
        author: mert,
        ago: D + 5 * H,
        text: L('Tailwind’e token olarak ekledim:\n```css\n--primary: #2563eb;\n--accent: #f97316;\n```', 'Added them to Tailwind as tokens:\n```css\n--primary: #2563eb;\n--accent: #f97316;\n```'),
      },
      {
        author: elif,
        ago: 2 * H,
        text: L('Kanban kartlarındaki öncelik rozetleri çok daha okunur olmuş, eline sağlık Zeynep!', 'The priority badges on the Kanban cards are much easier to read now — great work Zeynep!'),
        reactions: [['🙏', [zeynep]]],
      },
    ],
  },
  {
    id: '0c000000-0000-4000-8000-000000000004',
    kind: 'channel',
    name: L('backend', 'backend'),
    topic: L('Go API, PostgreSQL ve altyapı', 'Go API, PostgreSQL and infrastructure'),
    visibility: 'public',
    createdBy: can,
    members: [ME, can, burak, ayse],
    messages: [
      {
        author: can,
        ago: 6 * H,
        text: L(
          'Mesaj aramasını hızlandırdım, artık önek eşleşmesi indeksten geliyor:\n```sql\nCREATE INDEX messages_search ON messages USING gin (search_vector);\n```',
          'Message search is faster now — prefix matching comes from the index:\n```sql\nCREATE INDEX messages_search ON messages USING gin (search_vector);\n```',
        ),
        reactions: [['⚡', [burak, ayse]]],
      },
      {
        author: burak,
        ago: 5 * H,
        text: L('Yük testinde 2.000 eşzamanlı bağlantıda p95 gecikme 40 ms altında kaldı 📈', 'In the load test p95 latency stayed under 40 ms with 2,000 concurrent connections 📈'),
        reactions: [['🔥', [can, ayse]]],
      },
      {
        author: ayse,
        ago: 3 * H,
        text: L('Oda şifresi değişince erişimin her yerde kesildiğini doğruladım ✅', 'Confirmed that changing a room password ends access everywhere ✅'),
      },
    ],
  },
  {
    id: '0c000000-0000-4000-8000-000000000005',
    kind: 'channel',
    name: L('etkinlikler', 'events'),
    topic: L('Ofis buluşmaları, kutlamalar, öğle yemekleri', 'Meetups, celebrations and team lunches'),
    visibility: 'public',
    createdBy: mert,
    members: [elif, mert, zeynep, burak],
    messages: [
      { author: mert, ago: D, text: L('Cuma akşamı ekip yemeği var, katılacaklar 🍕 bıraksın!', 'Team dinner on Friday evening — leave a 🍕 if you’re coming!'), reactions: [['🍕', [elif, zeynep, burak]]] },
    ],
  },
  {
    id: '0d000000-0000-4000-8000-000000000001',
    kind: 'direct',
    name: L('', ''),
    topic: L('', ''),
    visibility: 'private',
    createdBy: elif,
    members: [ME, elif],
    messages: [
      { author: elif, ago: D + 2 * H, text: L('Selam! FUDISLTE’ye hoş geldin 👋', 'Hi! Welcome to FUDISLTE 👋') },
      { author: ME, ago: D + 2 * H - 3, text: L('Teşekkürler, her şey çok tanıdık geldi.', 'Thanks, everything feels familiar already.') },
      {
        author: elif,
        ago: 8,
        text: L('Demo gününden önce ürün kanalındaki önceliklere bir göz atabilir misin?', 'Could you look at the priorities in the product channel before demo day?'),
      },
    ],
    unread: 1,
  },
  {
    id: '0d000000-0000-4000-8000-000000000002',
    kind: 'direct',
    name: L('', ''),
    topic: L('', ''),
    visibility: 'private',
    createdBy: can,
    members: [ME, can, zeynep],
    messages: [
      { author: can, ago: 7 * H, text: L('Yeni ayarlar ekranının API uçları hazır.', 'The API endpoints for the new settings screen are ready.') },
      { author: zeynep, ago: 7 * H - 4, text: L('Süper, tasarımı bugün bağlıyorum 🎨', 'Great, I’ll wire up the design today 🎨') },
      { author: ME, ago: 6 * H, text: L('Ben de akşam test ederim 👍', 'I’ll test it this evening 👍') },
    ],
  },
]

/** What teammates answer when the demo user writes. */
export const replies: Text[] = [
  L('Harika fikir, hemen bakıyorum 👍', 'Great idea, looking at it now 👍'),
  L('Katılıyorum! Bunu bir göreve çevirelim mi?', 'Agreed! Shall we turn this into a task?'),
  L('Teşekkürler, not aldım 📝', 'Thanks, noted 📝'),
  L('Bunu demo gününde de gösterelim 🚀', 'Let’s show this on demo day too 🚀'),
  L('Güzel soru — toplantıda konuşalım mı?', 'Good question — shall we discuss it in the meeting?'),
  L('Tamamdır, bugün içinde hallederim.', 'Sure, I’ll get it done today.'),
  L('😄 Aynen öyle!', '😄 Exactly!'),
]
