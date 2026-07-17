# Claude Usagement

An always-on-top desktop widget for Windows that shows your Claude plan usage in real time — 5-hour limit, weekly usage, and extra credits.

![Widget preview](preview.gif)

## Requirements

You need **Claude Code CLI** installed and logged in. That's it.

If you haven't installed it yet:
```
npm install -g @anthropic-ai/claude-code
claude login
```

## Installation

1. Go to [**Releases**](../../releases/latest)
2. Download `ClaudeUsagement-portable.exe`
3. Run it

> **Windows SmartScreen warning?** Click "More info" → "Run anyway". This appears because the app isn't code-signed (that costs ~$300/year). The source code is fully open — you can review it here.

## Features

- Live 5-hour limit and weekly usage with animated arc gauges
- Amber glow warning at 85%, red pulse at 100%
- Dynamic gradient colors per usage range
- Drag to any corner of your screen — position saved across restarts
- Dark / light theme toggle
- Always-on-top with pin/unpin
- Auto-refreshes every 2 minutes, plus automatically at your exact reset time

## How it works

The widget reads your credentials from `~/.claude/.credentials.json`, the same file Claude Code CLI uses after `claude login`. No separate authentication needed.

## Build from source

```
git clone https://github.com/YOUR_USERNAME/claude-usagement
cd claude-usagement
npm install
npm start          # run in dev mode
npm run build      # build portable .exe → dist/
```

## License

MIT
