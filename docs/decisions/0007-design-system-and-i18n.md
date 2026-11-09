# ADR-0007: Mockup-based design system and TR/EN localization

Status: Accepted · Phase 1

## Context
The product owner supplied 17 UI mockups (docs/design/README.md) as the visual base and
asked for multi-language support switchable in settings. Most mockups show modules that
later phases build (chat, voice, kanban, whiteboard, documents, AI).

## Decision
**Design**
- Tokens follow the mockups: soft gray-blue canvas, white rounded panels, bright blue
  accent (Tailwind blue-600), Inter; dark mode is deep navy (from the older dark mockups).
- App frame: top bar (brand, "search everywhere" command palette, people toggle,
  avatar menu), sidebar (workspace card, navigation), content panel with the
  role-grouped people list. Settings use a tab bar.
- Each later module implements its mockup screen when the module ships. Navigation shows
  only existing features — no placeholder buttons or fake data in the product.
- Deliberate deviations: the sign-in screen keeps the mockup layout but uses email codes
  (ADR-0006) instead of password/Google/Microsoft/sign-up; Google and Microsoft sign-in
  arrive with SSO (Phase 10). The bell icon appears with notifications (Phase 2).

**Localization**
- Languages: Turkish (default) and English. Adding one = one dictionary file in the web
  app and one catalog map in the API.
- Web: typed dictionaries (`apps/web/src/i18n`); English must define every Turkish key
  (compile-time check). `{placeholders}` and `_one` plural forms. No i18n library.
- API: gettext-style catalog (`internal/i18n`): English source text is the message ID,
  translated at write time from `Accept-Language`. Missing translations fall back to
  English. A test checks that format verbs match.
- Each user has `users.locale`, changed under *Settings → My account*; the web app
  applies it after sign-in and sends it on every request. Emails use the recipient's
  locale (or, for people without an account, the language of the requesting page).
- Data stays as entered: role names, workspace names and descriptions are not translated.

## Consequences
- Two places to translate (web dictionary, API catalog); both are plain code reviewed
  with the feature.
- Default role names are English, as in the mockups; workspaces can rename them.
