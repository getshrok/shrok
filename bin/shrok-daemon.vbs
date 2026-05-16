' Shrok daemon launcher — launches PowerShell with no console attached.
' wscript.exe has no console of its own, so Start-Process inside the ps1
' can't inherit a terminal when Task Scheduler runs this via schtasks /run.
'
' bWaitOnReturn = True (3rd Run arg): wscript BLOCKS for the lifetime of the
' supervisor. This keeps the Task Scheduler action process alive for as long
' as the daemon runs, so the task's RestartOnFailure (every 1m, 999x) actually
' fires if the whole stack dies. With False, wscript exited ~1s after logon,
' the task was marked completed, and RestartOnFailure could never trigger.
Set WshShell = CreateObject("WScript.Shell")
binDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
WshShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -NonInteractive -File """ & binDir & "\shrok-daemon.ps1""", 0, True
