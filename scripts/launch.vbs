Option Explicit
Dim shell, fso, projectDir, scriptPath, powershellPath, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
scriptPath = fso.BuildPath(projectDir, "scripts\start.ps1")
powershellPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe")
command = Chr(34) & powershellPath & Chr(34) & " -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34)
shell.CurrentDirectory = projectDir
shell.Run command, 0, False
