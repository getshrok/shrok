' Shrok daemon launcher — launches PowerShell with no console attached.
' wscript.exe has no console of its own, so Start-Process inside the ps1
' can't inherit a terminal when Task Scheduler runs this via schtasks /run.
Set WshShell = CreateObject("WScript.Shell")
binDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -File """ & binDir & "\shrok-daemon.ps1""", 0, False
