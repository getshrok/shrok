# Manual Uninstall

The uninstall scripts (`uninstall.sh` on macOS/Linux, `uninstall.cmd` on Windows — the `.cmd` wraps `uninstall.ps1` with `-ExecutionPolicy Bypass` so it works regardless of your PowerShell policy) are the recommended way to remove Shrok. If they won't run for some reason, here's what they do so you can run the pieces by hand.

Installing Shrok places four things on your system:
- the install at `~/shrok`
- the workspace at `~/.shrok`
- a `shrok` CLI shim
- an auto-start entry (launchd, systemd, or Task Scheduler depending on your OS)

**⚠️ `~/.shrok` contains your memories, credentials, and conversation history. Once it's gone, it's gone. Back it up first if you might want it later. ⚠️**

## macOS

```bash
launchctl bootout "gui/$(id -u)/com.shrok.agent" 2>/dev/null || true
rm -f ~/Library/LaunchAgents/com.shrok.agent.plist
rm -f ~/.local/bin/shrok
rm -rf ~/shrok ~/.shrok
```

## Linux

```bash
systemctl --user stop shrok
systemctl --user disable shrok
rm -f ~/.config/systemd/user/shrok.service
systemctl --user daemon-reload
rm -f ~/.local/bin/shrok
rm -rf ~/shrok ~/.shrok
```

## Windows (PowerShell)

```powershell
schtasks /end /tn Shrok
schtasks /delete /tn Shrok /f
Remove-Item "$env:USERPROFILE\.local\bin\shrok.ps1","$env:USERPROFILE\.local\bin\shrok.cmd" -Force
Remove-Item "$env:USERPROFILE\shrok","$env:USERPROFILE\.shrok" -Recurse -Force
```

You may also want to remove `%USERPROFILE%\.local\bin` from your user `PATH` if Shrok was the only thing there.