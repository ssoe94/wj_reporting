Option Explicit
Dim shell, files, root, mode, title, folder, shortcut, entry
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count <> 3 Then WScript.Quit 2
mode = WScript.Arguments(0)
root = WScript.Arguments(1)
title = WScript.Arguments(2)
For Each folder In Array(shell.SpecialFolders("Desktop"), shell.SpecialFolders("Programs"))
    For Each entry In Array("start", "agent-view")
        Dim name, link
        name = title
        If entry = "agent-view" Then name = name & " - Status"
        link = files.BuildPath(folder, name & ".lnk")
        If mode = "add" Then
            Set shortcut = shell.CreateShortcut(link)
            shortcut.TargetPath = shell.ExpandEnvironmentStrings("%SystemRoot%\System32\wscript.exe")
            shortcut.Arguments = """" & files.BuildPath(root, "hidden.vbs") & """ " & entry
            shortcut.WorkingDirectory = root
            shortcut.Save
        ElseIf mode = "remove" And files.FileExists(link) Then
            Set shortcut = shell.CreateShortcut(link)
            If shortcut.Arguments = """" & files.BuildPath(root, "hidden.vbs") & """ " & entry Then files.DeleteFile link
        End If
    Next
Next
