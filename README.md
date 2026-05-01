# WITNESS
### Private AI Journal. Runs entirely on your machine.

Witness records your voice, transcribes it locally, and uses a local AI to track your mood, stress, energy, and behavioral patterns over time. Nothing leaves your computer. No subscriptions. No cloud.

![Witness Dashboard](assets/icon.ico)

---

## What It Does

- **Voice journal** — speak your entry, Witness transcribes it in real time
- **AI analysis** — extracts mood, stress, energy, anxiety, clarity scores from what you say
- **Behavioral flags** — surfaces honest patterns it notices across your entries
- **Health overlay** — import Apple Health data to correlate HRV and sleep with your mood logs
- **Weekly recap** — AI-generated summary of the week with pattern observations
- **Full privacy** — all data stays on your machine in a local SQLite database

---

## Requirements

Before installing Witness, you need two things:

### 1. Ollama
Ollama runs the AI model locally. Witness will install it automatically if it is not found.

If you need to install it manually:
1. Go to **https://ollama.com/download** and download the Windows installer
2. Run it and follow the prompts

**You do not need to pull a model before launching.** Witness will guide you through choosing and downloading a model from the CONFIG screen on first launch.

### 2. Hardware
- **RAM:** 8GB minimum (enough for gemma4:3b, the default model)
- **RAM:** 16GB+ recommended if you want to run larger models like deepseek-r1:14b
- **Storage:** 5-15GB free depending on which model you choose
- **OS:** Windows 10 or 11 (64-bit)

A GPU helps but is not required. All models run on CPU.

---

## Installation

1. Download **Witness Setup 1.0.0.exe** from the [Releases](../../releases) page
2. Run it — Windows may show a blue "Windows protected your PC" warning
   - This appears because the app is not commercially code-signed (that costs money)
   - Click **"More info"** then **"Run anyway"** to proceed
   - The app is open source — you can read every line of code here
3. Follow the installer prompts
4. Launch Witness from the Start Menu or Desktop shortcut

**First launch takes 30-60 seconds** while the AI model loads into memory. This is normal.

---

## First Launch Checklist

- [ ] Ollama is installed
- [ ] You have selected and downloaded a model from the CONFIG screen
- [ ] You have at least 8GB RAM
- [ ] You see "OLLAMA ONLINE" in the sidebar after ~60 seconds

If the sidebar shows "OLLAMA OFFLINE" after 60 seconds, see Troubleshooting below.

---

## Where Your Data Lives

Your journal entries are stored at:
```
C:\Users\<YourName>\AppData\Roaming\Witness\witness.db
```

This location is intentional. Your data survives app updates and reinstalls. Uninstalling Witness does **not** delete your journal.

To back up your journal, copy that file somewhere safe.

---

## Troubleshooting

**"OLLAMA OFFLINE" in the sidebar**
- Open a terminal and run `ollama serve` — if it errors, Ollama may not be installed correctly
- Make sure you have downloaded a model from the CONFIG screen inside Witness
- Try restarting the app after confirming Ollama is running

**Blue SmartScreen warning on install**
- This is expected for unsigned apps. Click "More info" then "Run anyway"
- The source code is fully open — nothing is hidden

**App is slow / AI responses take a long time**
- The default model (gemma4:3b) works well on most hardware
- If responses are slow, try a smaller model like llama3.2:3b in CONFIG
- For the best quality insights, upgrade to deepseek-r1:14b in CONFIG if you have 16GB+ RAM

**Recording does not work**
- Check that your microphone is not blocked in Windows Settings > Privacy > Microphone
- Make sure no other app is exclusively holding the microphone

**Whisper model not found / transcription fails**
- On first recording, Witness downloads the Whisper transcription model (~150MB)
- This requires an internet connection one time only
- Subsequent recordings work fully offline

---

## Changing the AI Model

Witness defaults to `gemma4:3b` which runs on most computers with 8GB+ RAM.

From the CONFIG screen you can browse available models and download them with one click. Witness shows which models fit your hardware automatically.

| Model | Size | RAM Needed | Quality |
|---|---|---|---|
| gemma4:3b | 3GB | 8GB | Good — recommended default |
| llama3.2:3b | 2GB | 8GB | Fast, good for older hardware |
| deepseek-r1:14b | 9GB | 16GB | Best — recommended if your hardware supports it |
| deepseek-r1:32b | 20GB | 32GB | Maximum quality |

Go to **CONFIG** in the sidebar to switch models at any time.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| UI | React + Vite |
| AI backend | Python + FastAPI |
| Local LLM | Ollama (any model) |
| Transcription | Faster-Whisper (local) |
| Journal storage | SQLite |
| Semantic search | ChromaDB |
| Animations | GSAP |

---

## Privacy

- No analytics
- No telemetry  
- No network requests except to `localhost`
- No account required
- All data stored locally in SQLite

The only outbound connection Witness makes is to download the Whisper transcription model on first use (~150MB, one time). After that, everything is offline.

---

## License

Personal use. See LICENSE.txt.
