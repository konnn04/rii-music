# Discord status

Discord only accepts a "Listening to…" status from a program on the same computer, so a small agent runs there and asks the server what you are playing.

1. The admin creates an application at [discord.com/developers](https://discord.com/developers/applications) and pastes its Application ID in Admin → Discord. The application's name is what shows after "Listening to".
2. Each user opens Settings → Discord status, turns it on and creates a token.
3. On the computer running Discord, run one command and paste the token when asked:
   - Windows (PowerShell): `irm https://music.example.com/agent.ps1 | iex`
   - macOS / Linux (needs python3): `curl -fsSL https://music.example.com/agent.sh | sh`

The token is stored on that computer (never in a URL); next time just run the command again. Keep the window open while listening. The status follows whichever of your devices is playing.

An executable agent also exists (`rii_music discord-agent`) for systems without PowerShell or python3; Docker images include it only when built with `AGENT_BINARIES=true`.
