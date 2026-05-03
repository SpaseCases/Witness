<p align="center">
  <img src="assets/icon.ico" width="80" alt="Witness" />
</p>

# WITNESS
### Private AI journal. Runs entirely on your machine.

Witness records your voice, transcribes it locally, and uses a local AI to track your mood, stress, energy, and behavioral patterns over time. Nothing leaves your computer. No subscriptions. No cloud.

![Witness Dashboard](assets/screenshot-dashboard.png)
![Witness Recording](assets/screenshot-record.png)

---

## What It Does

- **Voice journal** — speak your entry, Witness transcribes it using Faster-Whisper large-v3-turbo locally
- **Text journal (WRITE mode)** — type an entry instead of speaking. Goes through the exact same analysis pipeline as a voice entry
- **Rant mode (DUMP)** — unstructured brain dump. No format required. Gets tagged by topic and ingested into your history
- **AI analysis** — extracts mood, stress, energy, anxiety, and clarity scores from what you say
- **Structured entry summaries** — each entry gets a one-sentence summary, bullet highlights, and any intentions you stated, generated automatically alongside the transcript
- **AI follow-up questions** — after every entry, the AI generates 3 honest follow-up questions based specifically on what you said. Memory-aware: it references patterns from past entries when relevant
- **Behavioral flags** — surfaces honest patterns it notices across your entries
- **Health correlation** — import Apple Health data and overlay HRV, sleep, and resting heart rate against your journal metrics on a dual-axis chart. The AI reads 30 days of paired data and writes a plain-English pattern summary
- **Weekly recap** — AI-generated summary of the week with pattern observations
- **Monthly recap** — deeper longitudinal view of the past 30 days: what shifted, recurring themes, notable highs and lows, one honest behavioral observation
- **Journal chat** — ask questions about your own journal in plain language. "What have I been stressed about lately?" ChromaDB retrieves the relevant entries, Ollama answers based on what you actually wrote
- **AI Memory system** — two-layer persistent memory. A living document updated automatically after every entry (who you are, your patterns, your stressors). Episodic recall pulls the most relevant past entries into every AI prompt via ChromaDB. The AI gets smarter the more you use it
- **Self-model (PROFILE)** — a living summary of your patterns, values, recurring concerns, and emotional tendencies built from all your entries. Regenerates as you add more
- **Semantic search** — find past entries by meaning, not just keywords
- **Auto-generate context** — one click in CONFIG generates a personal context document from all your entries, which gets injected into every AI prompt
- **To-do extraction** — the AI automatically pulls any tasks or intentions you mentioned and adds them to a to-do list
- **Export** — save your full journal or any date range as a PDF or plain text file, locally, with one click

---

## Who Built This

I'm a high school student. I built Witness for myself because I wanted a journaling tool that was actually private and didn't try to sell me a subscription. I used Claude (Anthropic's AI) to help write most of the code. I designed it, tested it, broke it, fixed it, and use it daily on my own machine.

This is not a startup. There's no team. Bug fixes will happen when I have time. If something breaks and you know how to fix it, pull requests are welcome.

The code is all here. Read it if you want.

---

## Requirements

### 1. Ollama
Ollama runs the AI model locally. Witness will try to launch it automatically.

Install from **https://ollama.com/download**.

You do not need to pull a model before launching. Witness walks you through picking and downloading one from the CONFIG screen on first launch.

### 2. Hardware
- **OS:** Windows 10 or 11 (64-bit) or Linux (Ubuntu 20.04+, Debian 11+, most x64 distros)
- **RAM:** 8GB minimum (runs the default gemma4:3b model)
- **RAM:** 16GB+ if you want deepseek-r1:14b, which gives noticeably better insights
- **Storage:** 5-15GB free depending on which model you pick

A GPU helps with speed but is not required. Everything runs on CPU.

---

## Installation

1. Download **Witness Setup.exe** from the [Releases](../../releases) page
2. Run it. Windows will probably show a blue "Windows protected your PC" warning
   - Click **"More info"** then **"Run anyway"**
   - The full source code is sitting right here if you want to verify nothing sketchy is happening
3. Follow the installer
4. Launch Witness from the Start Menu or Desktop shortcut

First launch takes 30-60 seconds while the AI model loads. Normal.

---

## First Launch Checklist

- [ ] Ollama is installed
- [ ] You picked and downloaded a model from the CONFIG screen
- [ ] You have at least 8GB RAM
- [ ] The sidebar shows "OLLAMA ONLINE" after about 60 seconds

If the sidebar shows "OLLAMA OFFLINE" after a full minute, see Troubleshooting.

---

## AI Memory

Witness has a two-layer memory system that builds automatically as you use it.

**Layer B — Living Memory Document**
After every entry, the AI reads your transcript and updates a personal context document about you. This document is injected into every subsequent AI prompt — follow-up questions, insights, recaps, and chat all have stable knowledge of who you are. The document grows more accurate over time.

**Layer C — Episodic Recall**
Every entry is stored as a semantic fingerprint in ChromaDB. When generating follow-up questions or analysis, the AI searches for the most similar past entries and includes them as context. This lets it notice patterns across weeks and months — "you talked about something similar in March."

Both layers are visible and editable from the **MEMORY** screen in the sidebar. You can read your memory document, delete individual extracted facts, force a full rebuild, or wipe everything. Your journal entries are never affected by memory operations.

Memory updates run in the background after every save. You don't have to do anything.

---

## Using the Health Correlation Feature

1. On your iPhone: **Health → your profile photo → Export All Health Data**
2. Transfer the `.zip` to your PC, unzip it
3. In Witness, go to **VITALS → + IMPORT** and select the `export.xml` file
4. Once imported, click the **CORRELATION** tab
5. Toggle which journal metrics and health metrics you want to compare
6. Click **RUN ANALYSIS** to get an AI-written pattern summary

The chart shows journal scores on the left axis and health data on the right axis. Lines only appear on days where both a journal entry and health data exist — you need some overlap before the chart populates.

The AI analysis requires at least 7 days of overlapping data.

---

## Where Your Data Lives

**Windows:**
```
C:\Users\<YourName>\AppData\Roaming\Witness\witness.db
```

**Linux:**
```
~/.config/Witness/witness.db
```

Your journal is a single SQLite file. It survives updates and reinstalls. Uninstalling Witness does not touch it. Back it up by copying that file somewhere.

---

## Privacy

Your data goes nowhere. Physically cannot.

Witness talks to `localhost` only. Two exceptions: on first recording, Witness downloads the Whisper transcription model (~300MB for large-v3-turbo) from the internet. On first run, ChromaDB downloads a small embedding model (~22MB). After that, everything runs offline permanently.

No analytics. No telemetry. No account. No cloud. The database file is yours.

---

## Troubleshooting

**"OLLAMA OFFLINE" in the sidebar**
- Open a terminal and run `ollama serve` to start it manually
- Make sure you downloaded a model from the CONFIG screen
- Restart the app

**Blue SmartScreen warning on install**
- Expected. Click "More info" then "Run anyway". Source code is all here.

**App is slow / AI takes forever**
- gemma4:3b (the default) runs fine on most machines
- For faster responses on older hardware, try llama3.2:3b in CONFIG
- For better insight quality, upgrade to deepseek-r1:14b if you have 16GB+ RAM

**First transcription is slow**
- Witness downloads Whisper large-v3-turbo (~300MB) on first use — needs internet this one time
- Wait for it to finish, then try again. All subsequent recordings are fast

**Microphone not working**
- Windows: Settings > Privacy > Microphone — make sure Witness has access
- Linux: `sudo apt install portaudio19-dev` then restart the app
- Linux: `sudo usermod -aG audio $USER`, log out and back in

**Follow-up questions don't appear**
- The transcript needs to be at least 300 characters (a few sentences) for questions to generate
- Check the Python backend terminal for error messages — it logs every step of question generation
- If Ollama is slow, questions can take 30-90 seconds depending on your model

**Memory screen shows nothing**
- Record at least a few entries first, then click "BUILD MEMORY NOW" from the MEMORY screen
- Memory builds automatically after each entry going forward — the first build is manual

**Correlation chart shows "NO PAIRED DATA"**
- You need journal entries and Apple Health data on the same dates
- Try a wider date range (60 days instead of 30)

**Correlation AI analysis is greyed out**
- Need at least 7 days of overlapping data before the AI can find patterns

---

## Changing the AI Model

Witness defaults to `gemma4:3b`. From CONFIG you can browse and download other models.

| Model | Size | RAM Needed | Notes |
|---|---|---|---|
| gemma4:3b | 3GB | 8GB | Default. Good for most machines |
| llama3.2:3b | 2GB | 8GB | Faster, slightly less nuanced |
| deepseek-r1:14b | 9GB | 16GB | Best quality. What I run |
| deepseek-r1:32b | 20GB | 32GB | Maximum. Needs serious hardware |

---

## Running From Source

**You need:** Node.js 20+, Python 3.11 or 3.12, Ollama

**Windows:**
```
git clone https://github.com/SpaseCases/Witness.git
cd Witness
npm install
cd python-backend
pip install -r requirements.txt
pip install fpdf2
cd ..
npm run dev
```

**Linux (Ubuntu / Debian):**
```bash
sudo apt install portaudio19-dev

git clone https://github.com/SpaseCases/Witness.git
cd Witness
npm install
cd python-backend
pip install -r requirements.txt
pip install fpdf2
cd ..
npm run dev
```

Ollama must be installed and a model pulled before AI features work:
```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull gemma4:3b
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| UI | React + Vite |
| AI backend | Python + FastAPI |
| Local LLM | Ollama (any model) |
| Transcription | Faster-Whisper large-v3-turbo (local) |
| Journal storage | SQLite |
| Semantic search | ChromaDB |
| Animations | GSAP |

---

## Roadmap

- **Mac support** — .dmg installer
- **iPhone companion app** — record entries from your phone over local WiFi, syncs to the desktop, no cloud involved
- **Deeper health correlations** — automatic pattern detection across longer windows

Pull requests are open.

---

## License

MIT. See LICENSE.
