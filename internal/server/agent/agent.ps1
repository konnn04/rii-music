# RiiMusic Discord agent for Windows (PowerShell 5.1 or newer, nothing to install).
# Shows what you play on RiiMusic as your Discord status ("Listening to ...").
#
#   irm __SERVER__/agent.ps1 | iex
#
# The first run asks for the agent token (RiiMusic > Settings > Discord status)
# and keeps it in %APPDATA%\RiiMusic\agent-token, so later the command alone is
# enough. Keep the window open; Ctrl+C stops it and clears the status.
& {
  $ErrorActionPreference = 'Stop'
  try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
  $Server = '__SERVER__'
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

  $dir = Join-Path $env:APPDATA 'RiiMusic'
  $tokenFile = Join-Path $dir 'agent-token'
  $token = "$env:RIIMUSIC_TOKEN".Trim()
  if (-not $token -and (Test-Path $tokenFile)) { $token = (Get-Content $tokenFile -Raw).Trim() }
  if (-not $token) { $token = "$(Read-Host 'Agent token (RiiMusic > Settings > Discord status)')".Trim() }
  if (-not $token) { Write-Host 'No token given.'; return }
  New-Item -ItemType Directory -Force $dir | Out-Null
  Set-Content -Path $tokenFile -Value $token -NoNewline
  Remove-Item Env:RIIMUSIC_TOKEN -ErrorAction SilentlyContinue

  function Get-NowPlaying {
    $wc = New-Object System.Net.WebClient
    $wc.Encoding = [Text.Encoding]::UTF8
    $wc.Headers.Add('Authorization', "Bearer $token")
    $wc.Headers.Add('User-Agent', 'riimusic-agent-ps')
    try { return ($wc.DownloadString("$Server/api/agent/nowplaying") | ConvertFrom-Json) } finally { $wc.Dispose() }
  }

  # Discord IPC: frames of op (int32 LE) + length (int32 LE) + JSON, on the
  # named pipe \\.\pipe\discord-ipc-N of the Discord desktop app.
  function Send-Frame($pipe, [int]$op, $obj) {
    $body = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $obj -Depth 6 -Compress))
    $buf = New-Object byte[] (8 + $body.Length)
    [BitConverter]::GetBytes($op).CopyTo($buf, 0)
    [BitConverter]::GetBytes([int]$body.Length).CopyTo($buf, 4)
    $body.CopyTo($buf, 8)
    $pipe.Write($buf, 0, $buf.Length)
    $pipe.Flush()
  }
  function Read-Exact($pipe, [int]$n) {
    $b = New-Object byte[] $n
    $o = 0
    while ($o -lt $n) {
      $k = $pipe.Read($b, $o, $n - $o)
      if ($k -le 0) { throw [System.IO.IOException]::new('Discord closed the connection') }
      $o += $k
    }
    return , $b
  }
  function Receive-Frame($pipe) {
    $h = Read-Exact $pipe 8
    $n = [BitConverter]::ToInt32($h, 4)
    $data = $null
    if ($n -gt 0) { $data = [Text.Encoding]::UTF8.GetString((Read-Exact $pipe $n)) | ConvertFrom-Json }
    return @{ op = [BitConverter]::ToInt32($h, 0); data = $data }
  }
  function Connect-Discord([string]$clientId) {
    for ($i = 0; $i -lt 10; $i++) {
      $p = New-Object System.IO.Pipes.NamedPipeClientStream('.', "discord-ipc-$i", [System.IO.Pipes.PipeDirection]::InOut)
      try { $p.Connect(300) } catch { $p.Dispose(); continue }
      Send-Frame $p 0 @{ v = 1; client_id = $clientId }
      $r = Receive-Frame $p
      if ($r.data -and $r.data.evt -eq 'READY') { return $p }
      $p.Dispose()
      throw "Discord refused the connection: $($r.data.message) (check the Discord Application ID)"
    }
    throw 'Discord desktop is not running.'
  }
  function Clip([string]$s, [int]$n) {
    if ($s.Length -lt 2) { return "$s  " } # Discord wants at least 2 characters
    if ($s.Length -gt $n) { return $s.Substring(0, $n - 3) + '...' }
    return $s
  }
  function Set-Activity($pipe, $activity) {
    Send-Frame $pipe 1 @{ cmd = 'SET_ACTIVITY'; nonce = [guid]::NewGuid().ToString(); args = @{ pid = $PID; activity = $activity } }
    $r = Receive-Frame $pipe
    if ($r.data -and $r.data.evt -eq 'ERROR') { throw "Discord: $($r.data.data.message)" }
  }

  Write-Host "RiiMusic Discord agent - $Server (Ctrl+C to stop)"
  $pipe = $null
  $shown = ''
  $lastErr = ''
  try {
    while ($true) {
      try {
        $res = Get-NowPlaying
        $clientId = "$($res.discordClientId)"
        if (-not $clientId) { throw 'The admin has not set a Discord Application ID on this server yet.' }
        if (-not $pipe) {
          $pipe = Connect-Discord $clientId
          Write-Host 'Connected to Discord.'
          $shown = ''
        }
        $np = $res.nowPlaying
        $act = $null
        $key = 'none'
        if ($np -and $np.playing) {
          $start = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds() - [long][math]::Floor($np.positionMs / 1000)
          $artist = if ($np.artist) { $np.artist } else { 'RiiMusic' }
          $album = if ($np.album) { $np.album } else { $np.title }
          $image = if ($np.coverUrl) { $np.coverUrl } else { 'vang' }
          $ts = @{ start = $start }
          if ($np.durationMs -gt 0) { $ts.end = $start + [long][math]::Floor($np.durationMs / 1000) }
          $act = @{ type = 2; details = (Clip $np.title 128); state = (Clip $artist 128); timestamps = $ts; assets = @{ large_image = $image; large_text = (Clip $album 128) } }
          $key = "$($np.trackId)|$([math]::Floor($start / 5))" # sent again after a seek
        }
        if ($key -ne $shown) {
          Set-Activity $pipe $act
          $shown = $key
          if ($act) { Write-Host "Showing: $($np.title) - $artist" } else { Write-Host 'Cleared (nothing playing).' }
        }
        $lastErr = ''
      } catch {
        $e = $_.Exception
        while ($e.InnerException -and -not ($e -is [System.Net.WebException])) { $e = $e.InnerException }
        if ($e -is [System.Net.WebException]) {
          if ($e.Response -and [int]$e.Response.StatusCode -eq 401) {
            Remove-Item $tokenFile -ErrorAction SilentlyContinue
            Write-Host 'The token is wrong or was replaced. Make a new one in RiiMusic, then run the command again.'
            return
          }
          $msg = "Cannot reach RiiMusic: $($e.Message)"
        } else {
          $msg = "$($e.Message)"
          if ($pipe) { $pipe.Dispose(); $pipe = $null } # reconnect next time
        }
        if ($msg -ne $lastErr) { Write-Host $msg; $lastErr = $msg }
      }
      Start-Sleep -Seconds 5
    }
  } finally {
    if ($pipe) {
      try { Set-Activity $pipe $null } catch {}
      $pipe.Dispose()
    }
  }
}
