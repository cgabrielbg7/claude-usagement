Dim oShell, dir
Set oShell = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
oShell.Run "cmd /c """ & dir & "run.bat""", 0, False
