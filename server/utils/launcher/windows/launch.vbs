' Executable of the generated MulmoClaude shortcut.
'
' The Windows twin of macos/launch.sh, and deliberately even smaller.
' macOS had to recover a PATH before it could find node; a process
' started from Explorer inherits the user's PATH already (measured on a
' real runner: 73 entries, node found), so there is nothing to recover
' and this script only has to find node, hand over, and exit.
'
' Run through wscript.exe, which shows no console window. The one thing
' that MUST be handled here is "no node at all" — there is nothing left
' to render a page with, so it falls back to a native MsgBox.

Option Explicit

Dim fso, sh, scriptDir, launcherDir, rootDir, nodePath

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

' <root>\utils\launcher\windows\launch.vbs — the same layout the macOS
' bundle uses under Resources\, so run.mjs's `../port.mjs` still resolves.
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
launcherDir = fso.GetParentFolderName(scriptDir)
rootDir = fso.GetParentFolderName(fso.GetParentFolderName(launcherDir))

' PATH is walked here rather than shelled out to `where node`, because
' WshShell.Exec always creates a console window for a console program —
' a black rectangle flashing on every single launch, on the one screen
' whose whole point is that clicking an icon Just Works.
Function FindNode()
  Dim entries, i, candidate
  FindNode = ""
  entries = Split(sh.ExpandEnvironmentStrings("%PATH%"), ";")
  For i = 0 To UBound(entries)
    If Len(Trim(entries(i))) > 0 Then
      candidate = fso.BuildPath(Trim(entries(i)), "node.exe")
      If Len(FindNode) = 0 And fso.FileExists(candidate) Then FindNode = candidate
    End If
  Next
End Function

' The message files are NAMED by primary language id, so this script
' needs no LCID table of its own — the mapping lives in
' windows/locale.mjs, where it is tested against pickLauncherLocale.
Function MessageFile()
  Dim byLanguage
  byLanguage = rootDir & "\messages\lcid-" & (GetLocale() And &H3FF) & ".txt"
  If fso.FileExists(byLanguage) Then
    MessageFile = byLanguage
  Else
    MessageFile = rootDir & "\messages\en.txt"
  End If
End Function

Sub AlertNoNode()
  Dim file, stream, title, body, answer
  file = MessageFile()
  If Not fso.FileExists(file) Then Exit Sub
  ' -1 opens as Unicode: the catalogue is UTF-16 so translated prose
  ' survives without a codepage guess.
  Set stream = fso.OpenTextFile(file, 1, False, -1)
  title = stream.ReadLine()
  body = ""
  Do While Not stream.AtEndOfStream
    body = body & stream.ReadLine() & vbCrLf
  Loop
  stream.Close

  ' MsgBox cannot relabel its buttons the way the macOS dialog labels
  ' one "nodejs.org", so the offer is made in the text and Yes opens the
  ' download page. A URL somebody has to retype by hand is a dead end
  ' for the exact user this launcher is for.
  answer = MsgBox(body & vbCrLf & "https://nodejs.org/", vbYesNo + vbCritical, title)
  If answer = vbYes Then sh.Run "cmd /c start """" https://nodejs.org/", 0, False
End Sub

nodePath = FindNode()
If Len(nodePath) = 0 Then
  AlertNoNode
  WScript.Quit 1
End If

' Hidden (0) and non-blocking (False): run.mjs spawns the server
' detached and opens the browser, so this script has nothing left to
' wait for and no window to keep.
sh.Run """" & nodePath & """ """ & launcherDir & "\run.mjs""", 0, False
