# Tab Out Mission

**A mission-focused Chrome new-tab dashboard for turning open tabs into intentional work.**

Tab Out Mission is a local Chrome extension that replaces your new tab page with a dashboard of your current browser context. It keeps the original Tab Out idea of grouping open tabs by domain and saving tabs for later, then extends it with a mission-oriented workflow and Quick Notes.

No server. No account. No external API calls. Just a local Chrome extension.

---

## Author

Built by Longyue Cao / Logan-tree.

This project is based on Zara's original Tab Out extension. See [Acknowledgements](#acknowledgements).

---

## Features

- **Open tabs dashboard** — see your current tabs grouped by domain
- **Homepage grouping** — group common homepages such as Gmail, X, LinkedIn, YouTube, and GitHub
- **Mission workflow** — move selected tabs into a focused mission so the current work context is explicit
- **Quick Notes** — capture short mission ideas locally in the new-tab page
- **Saved for later** — save individual tabs to a local checklist before closing them
- **New-tab cleanup** — keep one Tab Out Mission new tab and close any extra new-tab duplicates
- **Cross-window tab jumping** — click a tab title to jump to it across Chrome windows
- **Localhost grouping** — show port numbers for local development tabs
- **Confetti and sound feedback** — closing tabs and completing missions gives lightweight visual feedback
- **100% local** — your tabs, saved items, and notes stay on your machine

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/Logan-tree/tab-out-mission-longyue.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the `extension/` folder inside this repo

**3. Open a new tab**

You should see Tab Out Mission.

---

## How It Works

```text
You open a new tab
  -> Tab Out Mission shows your open tabs grouped by domain
  -> You move relevant tabs into a mission
  -> You capture small ideas in Quick Notes
  -> You save useful tabs for later
  -> You close or complete tab groups when the context is done
```

Everything runs inside the Chrome extension. User data is stored locally through `chrome.storage.local`.

---

## Privacy

Tab Out Mission does not send your tabs, notes, or saved items to a server. The extension does not require an account and does not call an external API.

---

## Acknowledgements

Tab Out Mission is built on top of [Zara's original Tab Out extension](https://github.com/zarazhangrui/tab-out), which focused on two core blocks: open tabs and saved-for-later tabs.

This version extends that foundation with a mission-oriented workflow, Quick Notes, and a more personal new-tab operating surface.

---

## Tech Stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | `chrome.storage.local` |
| Sound | Web Audio API |
| Animations | CSS transitions + JavaScript confetti particles |

---

## License

MIT
