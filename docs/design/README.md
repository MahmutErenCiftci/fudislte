# Design reference

The product owner's 17 mockups (`FUDISLTE_Tum_UI_Gorselleri_17_Ekran.zip`, kept outside the
repository) are the visual base for FUDISLTE. "Yeni 10 Ekran" is the current design (light
theme, Turkish UI); "Önceki Görseller" are earlier dark-theme explorations used as the
reference for dark mode. See [ADR-0007](../decisions/0007-design-system-and-i18n.md).

| Mockup | Screen | Status |
| --- | --- | --- |
| Yeni 01 | Marketing landing page | Separate website; not part of the product |
| Yeni 02 | Sign-in | **Phase 1** — layout implemented, email-code form (no password) |
| Yeni 03 | Home dashboard | **Phase 1** — greeting, getting started, recent activity, workspace, new members. Tasks, announcements and meetings cards arrive with their modules |
| Yeni 04 | Channel chat, DMs, presence | **Phase 2.1** — channel sidebar with unread badges, channel header with topic and member count, grouped messages with day separators, code blocks with line numbers, composer. **2.2** — "Messages" with badge, "Direkt mesajlar" sidebar section with "Daha fazlasını göster", inbox page. **2.3** — "Sabitlenen mesaj" bar with "Mesaja git", reaction chips with add-reaction button, inline reply under its message ("@Mert bence…"), blue @mentions; the thread panel is an addition. **2.4** — presence dots and status lines in the people list (Online, In a meeting, Coding, Focused, In a call, Idle), the bell, "… yazıyor". **2.5** — the "Dosyalar" tab, the paperclip in the composer, image previews and file cards; message search in the command palette and its own page (an addition). **2.6** — archive banner and "Mesaj saklama" settings card (additions). The Görevler and Wiki tabs, the emoji/slash buttons in the composer and call buttons arrive with Phases 4, 5 and 7 |
| Yeni 05 | Password-protected voice room | **Phase 3** — "Odalar" in the navigation, room header (icon, name, "Şifre korumalı" badge, people, admission time, description, copy link, menu), lock screen, room settings. Voice participants, controls, notes and linked tasks: Phases 4–5 |
| Yeni 06 | Meeting with AI assistant | Phases 4 and 8 |
| Yeni 07 | Project kanban with Git activity | Phases 5–6 |
| Yeni 08 | Architecture whiteboard | Phase 5 |
| Yeni 09 | Knowledge base | Phase 7 |
| Yeni 10 | Settings: users, roles, security, audit | **Phase 1** — tabs, users table with role badges and last activity, roles, access (email domains), audit log. Rooms tab (*Settings → Odalar*): **Phase 3**; MFA policy: when SSO/MFA ships |
| Önceki 01–07 | Dark dashboards, finance room, platform board | Dark-mode reference; finance workspace Phase 7 |

Shared layout: top bar (logo, "Her yerde ara ⌘K", people toggle, avatar), sidebar
(workspace card, navigation; channel and direct-message sections arrive in Phase 2), white
content panel, role-grouped people list on the right.
