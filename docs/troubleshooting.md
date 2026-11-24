# Troubleshooting

**YouTube says "Sign in to confirm you're not a bot".** Export `cookies.txt` from a browser signed in to YouTube (e.g. the "Get cookies.txt LOCALLY" extension) and put it at `$DATA_DIR/cookies.txt`.

**Downloads hang at "searching" or never start.** Check Admin → System: yt-dlp needs to be ready. If the host's IPv6 is broken or blocked by YouTube, set `FORCE_IPV4=true`. On Windows, run `data\bin\yt-dlp.exe --version`: if even that hangs, the machine (antivirus scanning the freshly unpacked files, a full system drive) is the cause, not RiiMusic; an exclusion for `data\bin` and `%TEMP%\_MEI*` usually helps.

**"Access is denied" when updating yt-dlp on Windows.** An older build is still running; the server now moves the running file aside and retries, so update again once the stuck processes have ended.

**The page keeps loading.** The server is down or unreachable. Check `http://<server>:8080/api/health`. With offline listening on, the app opens from its offline copy and plays stored songs.

**No change after an update.** Reload once more: the app is cached by the service worker and switches to the new version on the next load (Ctrl+Shift+R forces it).

**No email arrives.** Check the `SMTP_*` settings, then send a test email from Admin → System. With Gmail, `SMTP_PASSWORD` must be an app password.

**Songs are grouped under the wrong language.** Language comes from the title, the artist's other songs and the lyrics; it settles once lyrics are found. Songs downloaded before a language fix keep their old label until they are downloaded again.

**Live updates don't arrive behind a proxy.** Disable buffering for `/api/events` (Nginx: `proxy_buffering off;`).

**AI karaoke uses the integrated GPU (or is slow).** The progress line shows where the model runs (`GPU · …` or `CPU`). The app asks for the high-performance GPU, but on laptops with two GPUs Windows may still hand the browser the integrated one. Set it in Windows Settings → System → Display → Graphics: add the browser (`chrome.exe` / `msedge.exe`) or, for the desktop app, `C:\Program Files (x86)\MicrosoftdgeWebView\Application\<version>\msedgewebview2.exe` → High performance, then restart the app. `CPU` means the browser has no WebGPU: a song then takes about twice its length to separate.
