/*
 * FUDISLTE website: language (Turkish/English), theme, mobile menu, tabs, copy buttons and
 * repository links. Turkish is written in index.html; the English text lives in EN below,
 * under the same data-i18n keys. Plain JavaScript, no dependencies.
 */
'use strict'

// The public repository. Every GitHub link on the page and the clone command use it.
const REPO_URL = 'https://github.com/MahmutErenCiftci/fudislte'

const UI = {
  tr: {
    copy: 'Kopyala',
    copied: 'Kopyalandı',
    copyFailed: 'Kopyalanamadı',
    themeToDark: 'Koyu temaya geç',
    themeToLight: 'Açık temaya geç',
  },
  en: {
    copy: 'Copy',
    copied: 'Copied',
    copyFailed: 'Copy failed',
    themeToDark: 'Switch to dark theme',
    themeToLight: 'Switch to light theme',
  },
}

const EN = {
  'meta.title': 'FUDISLTE — team collaboration on your own server',
  'meta.desc':
    'FUDISLTE brings messaging, voice and video rooms, meetings, projects and whiteboards together on your own server. Source-available, an alternative to Discord, Slack and Microsoft Teams.',

  'a11y.skip': 'Skip to content',
  'a11y.nav': 'Main menu',
  'a11y.menu': 'Open menu',

  'nav.features': 'Features',
  'nav.security': 'Security',
  'nav.requirements': 'Requirements',
  'nav.download': 'Download',
  'nav.install': 'Install',
  'nav.faq': 'FAQ',
  'nav.claude': 'Install with Claude',
  'nav.tour': 'Step by step',

  'tour.eyebrow': 'Step by step',
  'tour.title': "A company's first hour",
  'tour.lead':
    'Kerem from IT installs FUDISLTE, and Elif, a new colleague, signs in for the first time. The screens you will see on a real installation, in order.',
  'tour.steps': 'Steps',
  'tour.who.it': 'IT',
  'tour.who.emp': 'Employee',
  'tour.1.t': 'Claude installs it on the server',
  'tour.1.d': 'One sentence is enough; Claude checks the server, writes the configuration, tests email and verifies the result.',
  'tour.2.t': 'The workspace is created',
  'tour.2.d': "The address is opened for the first time; the emailed code, the company name and IT's name are entered.",
  'tour.3.t': "A colleague's account is prepared",
  'tour.3.d': 'Name, email, role and language are entered in advance, and an access key is created.',
  'tour.4.t': 'The key goes to the colleague',
  'tour.4.d': 'The key is shown once; a ready-made message is copied with one click.',
  'tour.5.t': 'Elif enters the key',
  'tour.5.d': 'No password, no waiting for a code: "I have an access key", then the key.',
  'tour.6.t': 'Straight in',
  'tour.6.d': 'The account opens with the prepared name and role; teammates see her at once.',
  'tour.7.t': 'Everything is on record',
  'tour.7.d': 'Who installed it, who created the key, who joined — with times. After 48 hours everyone signs in again with an email code.',
  'tour.prev': 'Previous',
  'tour.next': 'Next',
  'tour.term.cmd': 'Install FUDISLTE on this server',
  'tour.term.check': 'First I am checking the server.',
  'tour.term.config': 'I wrote the configuration with randomly generated passwords.',
  'tour.term.mail': 'Test email sent. Could you check your inbox?',
  'tour.term.done': 'Ready. Open the address and enter the setup token.',
  'tour.m.setupTitle': 'Create your workspace',
  'tour.m.setupSub': 'We sent a code to kerem.aydin@acmelojistik.com.tr.',
  'tour.m.code': 'Verification code',
  'tour.m.wsName': 'Workspace name',
  'tour.m.yourName': 'Your name',
  'tour.m.create': 'Create workspace',
  'tour.m.settings': 'Settings',
  'tour.m.users': 'Users',
  'tour.m.access': 'Access',
  'tour.m.security': 'Security',
  'tour.m.keyTitle': 'Create an access key',
  'tour.m.fullName': 'Full name',
  'tour.m.email': 'Email',
  'tour.m.role': 'Role',
  'tour.m.lang': 'Language',
  'tour.m.turkish': 'Turkish',
  'tour.m.valid': 'Valid for',
  'tour.m.days': '14 days',
  'tour.m.cancel': 'Cancel',
  'tour.m.createKey': 'Create key',
  'tour.m.ready': 'The key is ready',
  'tour.m.readyText': 'Give this key to Elif Şahin. Valid until 22 November.',
  'tour.m.once': 'The key is shown only now.',
  'tour.m.copyKey': 'Copy key',
  'tour.m.copyMsg': 'Copy message',
  'tour.m.keyLogin': 'Sign in with an access key',
  'tour.m.keyLoginSub': 'Enter the key your IT team gave you; your account opens and you go straight in.',
  'tour.m.accessKey': 'Access key',
  'tour.m.open': 'Open my account',
  'tour.m.keyHint': 'Upper or lower case and dashes do not matter.',
  'tour.m.goodDay': 'Good afternoon,',
  'tour.m.welcome': 'Welcome, Elif!',
  'tour.m.today': 'You are working in Acme Lojistik A.Ş. as Developer.',
  'tour.m.joined': 'New members',
  'tour.m.now': 'just now',
  'tour.m.ago': '2 min ago',
  'tour.m.audit': 'Audit log',
  'tour.m.time': 'Time',
  'tour.m.person': 'Person',
  'tour.m.event': 'Event',
  'tour.m.ev1': 'Set up the server',
  'tour.m.ev2': 'Created an access key · Developer',
  'tour.m.ev3': 'Joined with an access key',

  'ai.tag': 'The easiest way',
  'ai.title': 'Install it with one sentence to Claude',
  'ai.lead':
    'FUDISLTE comes with a ready-made installation skill for Claude Code. Your IT team opens the repository on the server and says what they want; Claude carries the installation through from start to finish and asks before every change.',
  'ai.prompt': 'Install FUDISLTE on this server',
  'ai.skill': 'Read the skill →',
  'ai.claude': 'What is Claude Code? →',
  'ai.does': 'Claude does this for you:',
  'ai.1': 'Checks the server: memory, disk, Docker, ports, the domain and access to the mail server',
  'ai.2': 'Adds what is missing, with your approval: Docker, firewall rules',
  'ai.3': 'Writes the configuration with strong, random passwords',
  'ai.4': 'Sends a test email before going live',
  'ai.5': 'Starts the system and verifies HTTPS, the redirect and the app',
  'ai.6': 'Sets up daily, optionally encrypted backups and shows the first steps',
  'ai.note':
    'It is written not to weaken security settings or take your email password into the chat. You can also do every step by hand, as shown below.',
  'inst.manual': 'Manual installation',

  'hero.badge': 'On your own server. Fully in your control.',
  'hero.title1': 'A secure space for your team',
  'hero.title2': 'that belongs to you.',
  'hero.lead':
    "FUDISLTE is a source-available <strong>collaboration platform that runs on your own server</strong>, bringing messaging, voice and video rooms, meetings, projects and whiteboards together in one place. An alternative to Discord, Slack and Microsoft Teams: no vendor cloud, no per-seat fee, your data stays with you.",
  'hero.ctaInstall': 'Start installing',
  'hero.ctaRepo': 'Browse the source',
  'hero.check1': 'Free for your organization · source available',
  'hero.check2': 'Runs on your own server',
  'hero.check3': 'No GPU needed',

  'mock.search': 'Search everywhere…',
  'mock.home': 'Home',
  'mock.messages': 'Messages',
  'mock.meetings': 'Meetings',
  'mock.rooms': 'Rooms',
  'mock.projects': 'Projects',
  'mock.boards': 'Whiteboard',
  'mock.settings': 'Settings',
  'mock.channels': 'Channels',
  'mock.general': 'general',
  'mock.announcements': 'announcements',
  'mock.design': 'design',
  'mock.topic': 'Technical discussions for the backend team',
  'mock.tabChat': 'Chat',
  'mock.tabFiles': 'Files',
  'mock.tabTasks': 'Tasks',
  'mock.pinned': 'Pinned message',
  'mock.pinnedText': 'API v2 development process and architecture decisions',
  'mock.goto': 'Go to message →',
  'mock.msg1': "Morning, everyone! 👋 Today we're reviewing the API v2 authentication module.",
  'mock.msg2': 'The new middleware is ready: unauthorized requests get a 404.',
  'mock.codeComment': "// don't even reveal it",
  'mock.msg3': 'Looks great! I added the tests too. 🙌',
  'mock.composer': 'Message #backend…',
  'mock.people': 'People',
  'mock.owner': 'Owner — 1',
  'mock.online': 'Online',
  'mock.admins': 'Admins — 2',
  'mock.inMeeting': 'In a meeting',
  'mock.coding': 'Coding',
  'mock.devs': 'Developers — 6',
  'mock.inCall': 'In a call',

  'hl.title': 'Highlights',
  'hl.chat.t': 'Messaging and secure rooms',
  'hl.chat.d':
    'Channels, direct messages and threads; password-protected and restricted rooms. All data stays on your server.',
  'hl.voice.t': 'Voice and video meetings',
  'hl.voice.d':
    'Persistent voice rooms, video, screen sharing and meetings with calendar invitations — through your own LiveKit server.',
  'hl.board.t': 'Interactive whiteboards',
  'hl.board.d': 'Visualize ideas together: several people work on the same board with live cursors.',
  'hl.projects.t': 'Projects and Kanban',
  'hl.projects.d': 'Drag-and-drop Kanban, list and calendar views, sprints and tasks linked to rooms.',

  'stats.caption': "Measured on a single server with the project's own load-test tool",
  'stats.streams': 'concurrent live connections, zero dropped events',
  'stats.latency': 'p99 latency with 200 people online',
  'stats.memory': 'API memory with 1,000 users',
  'stats.price': 'per-seat licence fees',

  'why.eyebrow': 'What is it for?',
  'why.title': "All of your team's communication in one place, on your own infrastructure",
  'why.lead':
    'One tool for chat, another for meetings, a third for tasks… FUDISLTE combines them in a single application and runs without sending company data to a third-party cloud.',
  'why.data.t': 'Your data stays with you',
  'why.data.d':
    'Messages, files and records live in the PostgreSQL database and on the disk of your own server. The database sits on an internal network with no internet route; only ports 80/443 are exposed.',
  'why.cost.t': 'No per-seat fees',
  'why.cost.d':
    'Free for your organization’s own use. As many users and workspaces as you like; read the code and change your own installation to fit your needs.',
  'why.simple.t': 'Simple to install and run',
  'why.simple.d':
    "Starts with a single Docker Compose command; Caddy obtains the HTTPS certificate automatically. Backup, restore and restore-drill scripts are included.",

  'feat.eyebrow': 'Features',
  'feat.title': 'Everything a team needs',
  'feat.lead':
    'Working, tested features shipped with version 0.1.0. The interface is in Turkish and English; each person picks their language in the settings.',
  'f.msg.t': 'Messaging',
  'f.msg.1': 'Public and private channels',
  'f.msg.2': 'Direct and group messages',
  'f.msg.3': 'Threads, reactions, mentions and pinned messages',
  'f.msg.4': 'Presence, status messages, typing indicators and notifications',
  'f.msg.5': 'File attachments with previews and a Files tab',
  'f.msg.6': 'Message search, channel archiving and message retention',
  'f.rooms.t': 'Secure rooms',
  'f.rooms.1': 'Open, password-protected and restricted rooms',
  'f.rooms.2': 'Room passwords stored with Argon2id, and password rotation',
  'f.rooms.3': 'Admissions that expire',
  'f.rooms.4': 'A password never replaces authorization: the right password is not enough without access',
  'f.rooms.5': 'Revoking access ends it everywhere at once: messages, files, search and live events',
  'f.voice.t': 'Voice and video',
  'f.voice.1': 'Persistent voice rooms: the call continues while you navigate',
  'f.voice.2': 'Video and screen sharing (with a source picker in the desktop app)',
  'f.voice.3': 'Push to talk, mute and per-person volume',
  'f.voice.4': 'Moderation tools',
  'f.voice.5': 'Scheduled meetings with calendar invitations (.ics)',
  'f.voice.6': 'Your own LiveKit server, with built-in TURN for restrictive networks',
  'f.proj.t': 'Projects',
  'f.proj.1': 'Public and private projects',
  'f.proj.2': 'Kanban: drag and drop, also by keyboard',
  'f.proj.3': 'List and calendar views, filters',
  'f.proj.4': 'Assignees, checklists, comments and activity history',
  'f.proj.5': 'Sprints, editable workflows and labels',
  'f.proj.6': 'Tasks linked to rooms and channels',
  'f.board.t': 'Whiteboards',
  'f.board.1': 'Boards built on Excalidraw',
  'f.board.2': 'Several people at once, with live cursors',
  'f.board.3': 'Boards are saved persistently',
  'f.board.4': 'Everything, fonts included, is served by your own server; no outside requests',
  'f.acc.t': 'Accounts and administration',
  'f.acc.1': 'Passwordless sign-in: a one-time code sent to the work email',
  'f.acc.2': 'Roles, permissions and custom roles',
  'f.acc.3': 'Company email domains verified through DNS: colleagues join without invitations',
  'f.acc.4': 'Email invitations, member directory and session management',
  'f.acc.5': 'Audit log and account disable',
  'f.acc.6': 'Strict isolation between workspaces',
  'f.cli.t': 'Clients',
  'f.cli.1': 'A web app that runs in the browser',
  'f.cli.2': 'A desktop app for Windows, macOS and Linux (Electron)',
  'f.cli.3': 'Turkish and English interface, chosen per person',
  'f.cli.4': 'Light and dark themes; search everywhere with the ⌘K command palette',
  'f.ops.t': 'Operations',
  'f.ops.1': 'Single-server installation with Docker Compose',
  'f.ops.2': "Automatic HTTPS (Let's Encrypt) or an internal certificate authority for private networks",
  'f.ops.3': 'Backup, restore and restore-drill scripts with verification',
  'f.ops.4': 'Automatic database migrations at startup',
  'f.ops.5': 'A load-test tool and measured capacity',


  'sec.eyebrow': 'Security',
  'sec.title': 'Security is not bolted on — it is at the centre of the design',
  'sec.lead': 'The project has a written threat model; every new feature is designed and tested against it.',
  'sec.threat': 'Threat model →',
  'sec.policy': 'Security policy →',
  'sec.1.t': 'Every request is authorized on the server',
  'sec.1.d': "Anything you may not see answers 404; not even the existence of a channel or room leaks.",
  'sec.2.t': 'Workspaces are isolated from each other',
  'sec.2.d':
    'Every row is tied to a single workspace with composite foreign keys; cross-workspace access is checked by tests.',
  'sec.3.t': 'Passwordless sign-in, server-side sessions',
  'sec.3.d':
    'No password to steal: people sign in with a one-time code sent to their work email. Sessions live on the server; the cookie is <code>Secure</code> and <code>__Host-</code> prefixed.',
  'sec.4.t': 'Limits against brute force',
  'sec.4.d':
    'Code requests and room password guesses are rate limited; Argon2id computations are queued so they cannot exhaust memory.',
  'sec.5.t': 'Every security change is on record',
  'sec.5.d': 'Changes to roles, permissions, rooms and accounts go to the audit log, which administrators review in the settings.',

  'arch.eyebrow': 'How does it work?',
  'arch.title': 'Few moving parts, well-known technology',
  'arch.lead':
    'The core is just three containers: Caddy, the API and PostgreSQL. The API delivers live events itself; no separate message queue or cache is needed.',
  'arch.web': 'Web app',
  'arch.desktop': 'Desktop app',
  'arch.caddy': 'Automatic HTTPS, serves the web app, reverse proxy',
  'arch.api': 'Modular monolith: authorization, messages, rooms, projects, live events',
  'arch.livekit': 'Voice and video',
  'arch.optional': 'Optional, in the same Compose project',
  'arch.db': 'Internal network, no internet route',
  'arch.files': 'Files',
  'arch.filesD': "A volume on the server's disk",
  'arch.stack': 'Technologies',

  'req.eyebrow': 'System requirements',
  'req.title': 'How much RAM, how much GPU?',
  'req.lead':
    'Short answer: <strong>no GPU needed.</strong> Messaging, voice and video, projects and whiteboards run on the CPU.',
  'req.th.profile': 'Profile',
  'req.th.users': 'People',
  'req.th.server': 'Server',
  'req.small': 'Small team',
  'req.small.s': '<strong>2 vCPU · 4 GB RAM</strong> · 40 GB SSD',
  'req.none': 'Not needed',
  'req.voice': 'Small team + voice/video',
  'req.voice.u': '~25 people in calls at once',
  'req.voice.s': '<strong>4 vCPU · 4 GB RAM</strong> · ≥100 Mbit/s symmetric connection',
  'req.medium': 'Medium',
  'req.medium.s': '<strong>4–8 vCPU · 16 GB RAM</strong>; LiveKit on its own host, dedicated or managed PostgreSQL',
  'req.large': 'Large',
  'req.large.s': 'Several API replicas behind a load balancer, a LiveKit cluster',
  'req.f1.t': 'Measured memory use',
  'req.f1.d':
    'The idle core stack (Caddy + API + PostgreSQL) uses about <strong>60 MB of RAM</strong>. With 1,000 live users the API uses about <strong>100 MB of RAM</strong> and one CPU core; very heavy traffic (200 messages a second) takes it to four cores.',
  'req.f2.t': 'Why no GPU for voice and video?',
  'req.f2.d':
    'LiveKit is an SFU: it forwards streams to participants instead of re-encoding them. The limits are CPU and bandwidth: 50–100 kbit/s per person and direction for voice, 1–3 Mbit/s for each video or screen share.',
  'req.f3.t': 'Disk and network',
  'req.f3.d':
    'The core container images take about <strong>0.6 GB</strong>, plus your database and attachments. Open ports: TCP 80/443 (UDP 443 optional). For voice and video also UDP 7882, TCP 7881 and UDP 3478.',

  'inst.eyebrow': 'Install',
  'inst.title': 'On your own server in a few minutes',
  'inst.lead':
    'Single-server installation with Docker Compose. You need a Linux server with Docker Engine 26+ and the Compose plugin, a domain name pointing at it, an SMTP relay (sign-in codes arrive by email) and open ports 80/443.',
  'inst.s1.t': 'Clone the repository',
  'inst.s1.d': 'Copy the example environment file.',
  'inst.s2.t': 'Edit the <code>.env</code> file',
  'inst.s2.d':
    'Enter your domain, a strong database password (<code>openssl rand -base64 32</code>) and the SMTP settings.',
  'inst.s3.t': 'Start it',
  'inst.s3.d':
    'The images are built, Caddy obtains the certificate and the API applies the database migrations. Then read the setup token from the logs.',
  'inst.s4.t': 'Create the first workspace',
  'inst.s4.d':
    'Open <code>https://your-domain</code>, enter the setup token and your work email, confirm with the code that arrives and create your workspace. Then add your company domain under <em>Settings → Access</em>; colleagues join with their work email without waiting for an invitation. Under <em>Settings → Security</em> you can also create access keys for accounts you prepare for colleagues.',
  'inst.tabs': 'Additional setup steps',
  'inst.tab.voice': 'Voice and video',
  'inst.tab.backup': 'Backups',
  'inst.tab.upgrade': 'Upgrades',
  'inst.tab.local': 'Try it locally',
  'inst.voice.d':
    'Run LiveKit beside FUDISLTE. Generate the key and the secret, set <code>COMPOSE_PROFILES=media</code> and <code>FUDISLTE_LIVEKIT_URL=wss://&lt;your-domain&gt;/livekit</code> in <code>.env</code>, and open UDP 7882, TCP 7881 and UDP 3478 in the firewall.',
  'inst.backup.d':
    'The scripts back up the database and the attachments together, verify the result and encrypt it with <code>age</code>; the decryption key never stays on the server. A restore checks every table and file; the drill script rehearses a restore without touching the running deployment. Run them from the repository root.',
  'inst.upgrade.d':
    'Back up first and read the release notes. The API applies database migrations at startup, under a lock.',
  'inst.local.d':
    'The same images run on a developer machine over plain HTTP; on Windows Docker Desktop is not needed, Docker Engine runs inside WSL. Open <code>http://localhost:8088</code>; sign-in codes are shown by a command instead of SMTP. Never expose this configuration to a network.',
  'inst.note':
    'Detailed guides: <a data-repo="/blob/main/docs/deployment/docker-compose.md" href="#install">Installing with Docker Compose</a> · <a data-repo="/blob/main/docs/deployment/backup-restore.md" href="#install">Backups and restore</a>. On networks without internet access you can use Caddy\'s internal certificate authority.',

  'dl.eyebrow': 'Download',
  'dl.title': 'Download the desktop app',
  'dl.lead':
    "Employees install the app, enter their organization's FUDISLTE address on first launch and sign in with a code sent to their work email. Anyone who prefers not to install it can open the same address in a browser.",
  'dl.win': 'Windows 10 and 11 · 64-bit',
  'dl.mac': 'Apple Silicon (M1 and later)',
  'dl.linux': 'AppImage · x86_64',
  'dl.button': 'Download',
  'dl.note':
    'All versions, release notes and SHA-256 checksums are on the <a data-repo="/releases/latest" href="#download">GitHub Releases</a> page.',

  'road.eyebrow': 'Status',
  'road.title': 'Version 0.1.0',
  'road.lead':
    'The first five phases of the roadmap are complete and closed with tests. While the version is 0.x, minor versions may change things; every change is written in the release notes.',
  'road.link': 'Full roadmap →',
  'road.changelog': 'Changelog →',
  'road.p1': 'Foundation',
  'road.p1d': 'Setup, passwordless sign-in, workspaces, roles, invitations, audit log',
  'road.p2': 'Messaging',
  'road.p2d': 'Channels, DMs, threads, presence, files, search',
  'road.p3': 'Secure rooms',
  'road.p3d': 'Password-protected and restricted rooms, instant revocation',
  'road.p4': 'Voice and video',
  'road.p4d': 'LiveKit, screen sharing, scheduled meetings',
  'road.p5': 'Projects and whiteboards',
  'road.p5d': 'Kanban, sprints, Excalidraw',
  'road.p6': 'Developer features',
  'road.p6d': 'GitHub, GitLab, Gitea and Forgejo connections, PR/CI activity, personal access tokens',
  'road.p7': 'Workspaces and knowledge base',
  'road.p7d': 'Department workspaces, documents, wiki, version history',
  'road.p8': 'AI assistant and agents',
  'road.p8d': 'The worker is ready; API and interface integration in progress',
  'road.p10': 'Hardening',
  'road.p10d': 'Load tests and backups done; SSO (OIDC/SAML), monitoring and signed auto-updates next',

  'repo.eyebrow': 'Repository',
  'repo.title': 'Source available, open to contributions',
  'repo.lead':
    'One monorepo: the Go API, the React web app, the Electron desktop app, the Docker Compose files and the documentation. Every push and pull request is built, tested and checked for license compliance (REUSE) in CI.',
  'repo.l1': 'Architecture decisions documented as ADRs',
  'repo.l2': 'Contributions are accepted under a Contributor License Agreement (CLA)',
  'repo.l3': 'Vulnerabilities are reported privately through GitHub',
  'repo.contrib': 'Contributing guide →',
  'repo.adr': 'Architecture decisions →',
  'tree.web': 'React web app',
  'tree.desktop': 'Electron desktop app',
  'tree.api': 'Go API + PostgreSQL migrations',
  'tree.ui': 'Design tokens and components',
  'tree.client': 'Typed API client',
  'tree.platform': 'Web/desktop capability layer',
  'tree.infra': 'Docker Compose deployment',
  'tree.docs': 'Architecture, decisions, security, deployment',
  'tree.ops': 'Backup, restore, load tests',
  'tree.loadtest': 'Load generator (Go)',

  'faq.eyebrow': 'FAQ',
  'faq.title': 'Frequently asked questions',
  'faq.q1': 'Is it free?',
  'faq.a1':
    'Yes, for your organization’s internal use: there are no fees per user, server or workspace, and your only cost is your own server. FUDISLTE is licensed under PolyForm Internal Use 1.0.0; distributing copies, selling it or hosting it for other organizations is not allowed.',
  'faq.q2': 'Do I need a GPU?',
  'faq.a2':
    'No. Messaging, voice and video, projects and whiteboards run on the CPU.',
  'faq.q3': 'Why is an SMTP server required?',
  'faq.a3':
    'FUDISLTE has no passwords: everyone signs in with a one-time code sent to their work email. Use your own mail server, the Microsoft 365 or Google Workspace relay, or an email provider.',
  'faq.q4': 'Does it work on a network without internet access?',
  'faq.a4':
    'Yes. Add <code>tls internal</code> to the <code>Caddyfile</code>; Caddy then issues certificates from its own root. Distribute that root certificate to the clients (through group policy or MDM). The desktop app requires HTTPS and trusts the operating system certificate store.',
  'faq.q5': 'Where is my data stored?',
  'faq.a5':
    "Only on your server: in the PostgreSQL database and the API's file volume.",
  'faq.q6': 'Where do I download the desktop app?',
  'faq.a6':
    "Download the Windows, macOS or Linux version from the <a href=\"#download\">download section</a>. On first launch, enter your organization's FUDISLTE address (for example <code>chat.yourcompany.com</code>) and sign in with your work email. Anyone who prefers not to install the app can open the same address in a browser.",
  'faq.q8': 'How can I contribute?',
  'faq.a8':
    'Open a pull request directly for bug fixes; open an issue first for new features. You agree to the Contributor License Agreement (CLA) on your first pull request. Details are in the contributing guide.',

  'cta.title': "Set up your team's space today",
  'cta.text': 'On your own server, free for your organization, with no per-seat fees.',
  'cta.install': 'Installation steps',
  'cta.repo': 'View on GitHub',

  'footer.tagline': 'The source-available, self-hosted alternative to Discord, Slack and Microsoft Teams.',
  'footer.nav': 'Repository links',
  'footer.license': 'License',
  'footer.contrib': 'Contributing',
  'footer.by': 'Developed by <a href="https://oponoya.com" rel="noopener">Oponoya</a> · <a href="https://oponoya.com" rel="noopener">oponoya.com</a>',
  'footer.security': 'Security',
  'footer.privacy': 'Privacy',
  'footer.terms': 'Terms of use',
  'footer.changelog': 'Changelog',
  'footer.docs': 'Documentation',
  'footer.tm':
    'Discord, Slack and Microsoft Teams are trademarks of their respective owners, and Claude is a trademark of Anthropic; FUDISLTE is not affiliated with these companies.',
}

const LANG_KEY = 'fudislte.site.lang'
const THEME_KEY = 'fudislte.site.theme'

function store(key, value) {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    // Private windows may block storage; the choice then lasts for this page view.
  }
}

function load(key) {
  try {
    return localStorage.getItem(key)
  } catch (e) {
    return null
  }
}

// ---------- Language ----------

const turkish = new Map() // element -> original Turkish HTML
const turkishAttrs = new Map() // element -> { attribute: original Turkish value }
let lang = 'tr'
let trTitle = ''
let trDescription = ''

function captureTurkish() {
  document.querySelectorAll('[data-i18n]').forEach((el) => turkish.set(el, el.innerHTML))
  document.querySelectorAll('[data-i18n-attr]').forEach((el) => {
    const values = {}
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const attr = pair.split(':')[0].trim()
      values[attr] = el.getAttribute(attr)
    }
    turkishAttrs.set(el, values)
  })
  trTitle = document.title
  trDescription = document.querySelector('meta[name="description"]').getAttribute('content')
}

function translate(key, fallback) {
  return lang === 'en' && Object.prototype.hasOwnProperty.call(EN, key) ? EN[key] : fallback
}

function applyLanguage(next) {
  lang = next === 'en' ? 'en' : 'tr'
  document.documentElement.lang = lang

  for (const [el, html] of turkish) el.innerHTML = translate(el.dataset.i18n, html)
  for (const [el, values] of turkishAttrs) {
    for (const pair of el.dataset.i18nAttr.split(';')) {
      const [attr, key] = pair.split(':').map((s) => s.trim())
      el.setAttribute(attr, translate(key, values[attr]))
    }
  }
  document.title = translate('meta.title', trTitle)
  document.querySelector('meta[name="description"]').setAttribute('content', translate('meta.desc', trDescription))

  document.querySelectorAll('[data-set-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.setLang === lang)))
  document.querySelectorAll('.copy-btn').forEach((b) => {
    b.classList.remove('copied')
    b.textContent = UI[lang].copy
  })
  updateThemeLabel()
  fillRepositoryLinks() // translated HTML may contain repository links
}

// ---------- Repository links ----------

function fillRepositoryLinks() {
  document.querySelectorAll('a[data-repo]').forEach((a) => {
    a.href = REPO_URL + a.dataset.repo
  })
  document.querySelectorAll('[data-repo-text]').forEach((el) => {
    el.textContent = REPO_URL
  })
}

// ---------- Theme ----------

function isDark() {
  return document.documentElement.classList.contains('dark')
}

function updateThemeLabel() {
  const button = document.getElementById('theme-toggle')
  if (button) button.setAttribute('aria-label', isDark() ? UI[lang].themeToLight : UI[lang].themeToDark)
}

function setupTheme() {
  document.getElementById('theme-toggle').addEventListener('click', () => {
    const dark = !isDark()
    document.documentElement.classList.toggle('dark', dark)
    store(THEME_KEY, dark ? 'dark' : 'light')
    updateThemeLabel()
  })
  // Follow the system theme until the visitor picks one.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (event) => {
    if (load(THEME_KEY)) return
    document.documentElement.classList.toggle('dark', event.matches)
    updateThemeLabel()
  })
}

// ---------- Mobile menu ----------

function setupMenu() {
  const header = document.querySelector('.site-header')
  const toggle = document.querySelector('.nav-toggle')
  const close = () => {
    header.classList.remove('nav-open')
    toggle.setAttribute('aria-expanded', 'false')
  }
  toggle.addEventListener('click', () => {
    const open = !header.classList.contains('nav-open')
    header.classList.toggle('nav-open', open)
    toggle.setAttribute('aria-expanded', String(open))
  })
  document.querySelectorAll('.main-nav a').forEach((a) => a.addEventListener('click', close))
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') close()
  })
  window.matchMedia('(min-width: 961px)').addEventListener('change', (event) => {
    if (event.matches) close()
  })
}

// ---------- Active section in the navigation ----------

function setupScrollSpy() {
  if (!('IntersectionObserver' in window)) return
  const links = new Map()
  document.querySelectorAll('.main-nav a[href^="#"]').forEach((a) => links.set(a.getAttribute('href').slice(1), a))
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        links.forEach((a, id) => a.classList.toggle('active', id === entry.target.id))
      }
    },
    { rootMargin: '-40% 0px -55% 0px' },
  )
  // Watch every section, so a section outside the menu clears the highlight.
  document.querySelectorAll('main section[id]').forEach((section) => observer.observe(section))
}

// ---------- Tabs ----------

function setupTabs() {
  document.querySelectorAll('[data-tabs]').forEach((root) => {
    const tabs = Array.from(root.querySelectorAll('[role="tab"]'))
    const select = (tab, focus) => {
      for (const t of tabs) {
        const selected = t === tab
        t.setAttribute('aria-selected', String(selected))
        t.tabIndex = selected ? 0 : -1
        document.getElementById(t.getAttribute('aria-controls')).hidden = !selected
      }
      if (focus) tab.focus()
    }
    tabs.forEach((tab, index) => {
      tab.addEventListener('click', () => select(tab, false))
      tab.addEventListener('keydown', (event) => {
        const last = tabs.length - 1
        const target = {
          ArrowRight: index === last ? 0 : index + 1,
          ArrowLeft: index === 0 ? last : index - 1,
          Home: 0,
          End: last,
        }[event.key]
        if (target === undefined) return
        event.preventDefault()
        select(tabs[target], true)
      })
    })
  })
}

// ---------- Walkthrough ----------

// Steps are tabs (arrow keys move between them); Prev/Next buttons walk the same list.
function setupTour() {
  document.querySelectorAll('[data-tour]').forEach((root) => {
    const tabs = Array.from(root.querySelectorAll('[role="tab"]'))
    const prev = root.querySelector('[data-tour-prev]')
    const next = root.querySelector('[data-tour-next]')
    const current = root.querySelector('[data-tour-current]')
    let index = 0
    const show = (i, focus) => {
      index = Math.max(0, Math.min(tabs.length - 1, i))
      tabs.forEach((t, n) => {
        const selected = n === index
        t.setAttribute('aria-selected', String(selected))
        t.tabIndex = selected ? 0 : -1
        document.getElementById(t.getAttribute('aria-controls')).hidden = !selected
      })
      prev.disabled = index === 0
      next.disabled = index === tabs.length - 1
      current.textContent = String(index + 1)
      // On narrow screens the steps are a horizontal row: keep the active one visible.
      const list = tabs[index].parentElement
      if (list.scrollWidth > list.clientWidth) list.scrollTo({ left: tabs[index].offsetLeft - list.offsetLeft - 8, behavior: 'smooth' })
      if (focus) tabs[index].focus({ preventScroll: true })
    }
    tabs.forEach((tab, n) => {
      tab.addEventListener('click', () => show(n, false))
      tab.addEventListener('keydown', (event) => {
        const last = tabs.length - 1
        const target = {
          ArrowDown: n === last ? 0 : n + 1,
          ArrowRight: n === last ? 0 : n + 1,
          ArrowUp: n === 0 ? last : n - 1,
          ArrowLeft: n === 0 ? last : n - 1,
          Home: 0,
          End: last,
        }[event.key]
        if (target === undefined) return
        event.preventDefault()
        show(target, true)
      })
    })
    prev.addEventListener('click', () => show(index - 1, false))
    next.addEventListener('click', () => show(index + 1, false))
  })
}

// ---------- Copy buttons ----------

// Fallback for browsers or embedded views that block the asynchronous clipboard API.
function legacyCopy(text) {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.className = 'sr-only'
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch (e) {
    ok = false
  }
  area.remove()
  return ok
}

function setupCopyButtons() {
  document.querySelectorAll('.copy-btn').forEach((button) => {
    let timer
    button.addEventListener('click', async () => {
      const code = button.closest('.code-block').querySelector('code').textContent
      let ok = true
      try {
        await navigator.clipboard.writeText(code)
      } catch (e) {
        ok = legacyCopy(code)
      }
      button.textContent = ok ? UI[lang].copied : UI[lang].copyFailed
      button.classList.toggle('copied', ok)
      clearTimeout(timer)
      timer = setTimeout(() => {
        button.textContent = UI[lang].copy
        button.classList.remove('copied')
      }, 1800)
    })
  })
}

// ---------- Start ----------

function initialLanguage() {
  const fromUrl = new URLSearchParams(location.search).get('lang')
  if (fromUrl === 'tr' || fromUrl === 'en') return fromUrl
  const saved = load(LANG_KEY)
  if (saved === 'tr' || saved === 'en') return saved
  const preferred = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'tr']
  return preferred.some((l) => String(l).toLowerCase().startsWith('tr')) ? 'tr' : 'en'
}

captureTurkish()
setupTheme()
setupMenu()
setupScrollSpy()
setupTabs()
setupTour()
setupCopyButtons()
applyLanguage(initialLanguage())

document.querySelectorAll('[data-set-lang]').forEach((button) => {
  button.addEventListener('click', () => {
    applyLanguage(button.dataset.setLang)
    store(LANG_KEY, lang)
  })
})
