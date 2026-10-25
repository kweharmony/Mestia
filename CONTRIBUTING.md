# Участие в разработке · Contributing

[Русский](#русский) · [English](#english)

---

## Русский

Спасибо, что хотите помочь! Баг-репорты, идеи и pull request'ы приветствуются.

### Перед началом

- **Баг** — создайте [issue](https://github.com/kweharmony/Mestia/issues/new/choose)
  по шаблону: платформа, версия, ссылка-пример и шаги.
- **Большая идея** — сначала обсудите её в issue, чтобы не делать работу зря.
- **Уязвимость** — не публично, см. [SECURITY.md](SECURITY.md).

### Окружение

Нужны Node.js 18+, Rust (stable) и системные зависимости Tauri
([инструкция](https://tauri.app/start/prerequisites/)).

```bash
npm install
npm run fetch-binaries   # yt-dlp + ffmpeg под вашу ОС
npm run tauri dev        # приложение целиком
```

Android: Android SDK + NDK, JDK 17+, переменные `ANDROID_HOME` и `NDK_HOME`;
`npm run tauri android dev`.

### Проверки перед PR

```bash
npm run build            # tsc --noEmit + сборка фронтенда
npm test                 # Vitest
cd src-tauri && cargo test
```

Линтера нет — стиль держим вручную (см. ниже).

### Правила кода

- **Комментарии в коде — на русском**, как во всём проекте.
- **Строки интерфейса — только через i18n**: ключ в `src/lib/i18n.ts` с переводами
  `ru`/`en`/`zh`, в компонентах `useI18n().t("key")`. Сообщения Rust — на русском.
- Цвета — токенами темы (`bg-accent`, `text-ink`, `border-fog`…), чтобы работали все 8 тем.
- Анимации — `framer-motion`; у анимированных элементов класс `.mestia-anim`.
  Учитывайте `prefers-reduced-motion`.
- Код только для компьютера — `#[cfg(desktop)]`; в интерфейсе — `IS_ANDROID`.
- Меняйте только то, что нужно задаче; без попутных рефакторингов.
- Чистую логику покрывайте тестами (`src/**/*.test.ts`, `#[cfg(test)]`).

### Документация

Если меняете структуру (новый модуль, вью, Rust-файл), команды, стек или основной
сценарий (загрузка, медиатека, обновление) — обновите в том же PR
`CLAUDE.md`, `.cursorrules` и `.context/index.md`.

### Коммиты и PR

- Сообщение коммита — по-английски, в повелительном наклонении, кратко: что и зачем.
- Один PR — одна задача. Заполните шаблон PR, приложите скриншот для изменений UI.
- Версии в `package.json` и `src-tauri/tauri.conf.json` меняются только вместе.

Участвуя, вы соглашаетесь с [правилами поведения](CODE_OF_CONDUCT.md) и с тем, что
вклад распространяется по лицензии проекта ([MIT](LICENSE); Android-сборка как целое —
GPL-3.0, см. README).

---

## English

Thanks for wanting to help! Bug reports, ideas and pull requests are welcome.

### Before you start

- **Bug** — open an [issue](https://github.com/kweharmony/Mestia/issues/new/choose)
  using the template: platform, version, example link and steps.
- **Big idea** — discuss it in an issue first so no work is wasted.
- **Vulnerability** — privately, see [SECURITY.md](SECURITY.md).

### Setup

You need Node.js 18+, Rust (stable) and the Tauri system dependencies
([guide](https://tauri.app/start/prerequisites/)).

```bash
npm install
npm run fetch-binaries   # yt-dlp + ffmpeg for your OS
npm run tauri dev        # the full app
```

Android: Android SDK + NDK, JDK 17+, `ANDROID_HOME` and `NDK_HOME` set;
`npm run tauri android dev`.

### Checks before a PR

```bash
npm run build            # tsc --noEmit + frontend build
npm test                 # Vitest
cd src-tauri && cargo test
```

There is no linter — keep the style by hand (see below).

### Code rules

- **Code comments are in Russian**, as everywhere in the project.
- **UI strings go through i18n only**: a key in `src/lib/i18n.ts` with `ru`/`en`/`zh`
  translations, `useI18n().t("key")` in components. Rust messages stay in Russian.
- Colors use theme tokens (`bg-accent`, `text-ink`, `border-fog`…) so all 8 themes work.
- Animations use `framer-motion`; animated elements carry the `.mestia-anim` class.
  Respect `prefers-reduced-motion`.
- Desktop-only code goes under `#[cfg(desktop)]`; in the UI, `IS_ANDROID`.
- Change only what the task needs; no drive-by refactors.
- Cover pure logic with tests (`src/**/*.test.ts`, `#[cfg(test)]`).

### Documentation

If you change the structure (a new module, view, Rust file), commands, stack or a core
flow (download, library, update), update `CLAUDE.md`, `.cursorrules` and
`.context/index.md` in the same PR.

### Commits and PRs

- Commit messages in English, imperative mood, short: what and why.
- One PR — one task. Fill in the PR template and attach a screenshot for UI changes.
- Versions in `package.json` and `src-tauri/tauri.conf.json` change only together.

By contributing you agree to the [Code of Conduct](CODE_OF_CONDUCT.md) and that your
contribution is distributed under the project license ([MIT](LICENSE); the Android
build as a whole is GPL-3.0, see README).
