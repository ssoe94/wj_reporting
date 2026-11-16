Option Explicit
Dim shell, files, root, inputName, stream, line, pattern, match, version, runner, command, arg, code, child, message, action, idx
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
root = files.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count < 1 Then WScript.Quit 2
action = WScript.Arguments(0)
Set pattern = New RegExp
version = ""
Select Case action
    Case "install"
        inputName = "bootstrap.cmd"
        pattern.Pattern = "^@set ""WJ_PORTABLE_VERSION=([A-Za-z0-9][A-Za-z0-9._-]{0,47})""$"
    Case "rollback"
        inputName = "previous.txt"
        pattern.Pattern = "^([A-Za-z0-9][A-Za-z0-9._-]{0,47})$"
        For idx = 1 To WScript.Arguments.Count - 1
            arg = WScript.Arguments(idx)
            If Left(arg, 2) <> "--" Then version = arg
        Next
    Case Else
        inputName = "current.txt"
        pattern.Pattern = "^([A-Za-z0-9][A-Za-z0-9._-]{0,47})$"
End Select
If version = "" Then
    If Not files.FileExists(files.BuildPath(root, inputName)) Then WScript.Quit 1
    Set stream = files.OpenTextFile(files.BuildPath(root, inputName), 1)
    If stream.AtEndOfStream Then WScript.Quit 1
    line = stream.ReadLine
    If Not stream.AtEndOfStream Then WScript.Quit 1
    stream.Close
    Set match = pattern.Execute(line)
    If match.Count <> 1 Then WScript.Quit 1
    version = match(0).SubMatches(0)
End If
If Not ValidVersion(version) Then WScript.Quit 1
runner = files.BuildPath(root, "versions\" & version & "\python\python.exe")
If Not files.FileExists(runner) Then
    WScript.Echo "Packaged Windows Python is missing. Test skeletons are for layout checks only."
    WScript.Quit 1
End If
command = Quote(runner) & " -I -B -m field_agent.packaging.lifecycle --root " & Quote(root)
For Each arg In WScript.Arguments
    command = command & " " & Quote(arg)
Next
Set child = shell.Exec(command)
message = child.StdOut.ReadAll
If Len(message) > 0 Then WScript.StdOut.Write message
message = child.StdErr.ReadAll
If Len(message) > 0 Then WScript.StdErr.Write message
code = child.ExitCode
If code = 0 And action = "uninstall" Then
    inputName = files.BuildPath(root, "uninstall-versions.txt")
    Set stream = files.OpenTextFile(inputName, 1)
    Do Until stream.AtEndOfStream
        version = stream.ReadLine
        If Not ValidVersion(version) Then WScript.Quit 1
        line = files.BuildPath(root, "versions\" & version)
        If files.FolderExists(line) Then files.DeleteFolder line, True
    Loop
    stream.Close
    files.DeleteFile inputName, True
End If
WScript.Quit code

Function ValidVersion(value)
    Dim validator
    Set validator = New RegExp
    validator.Pattern = "^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$"
    If Not validator.Test(value) Or Right(value, 1) = "." Then
        ValidVersion = False
        Exit Function
    End If
    validator.Pattern = "^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)"
    validator.IgnoreCase = True
    ValidVersion = Not validator.Test(value)
End Function

Function Quote(value)
    Dim idx, char, slashes, rendered
    rendered = """"
    slashes = 0
    For idx = 1 To Len(value)
        char = Mid(value, idx, 1)
        If char = "\" Then
            slashes = slashes + 1
        Else
            If char = """" Then
                rendered = rendered & String(2 * slashes + 1, "\") & """"
            Else
                rendered = rendered & String(slashes, "\") & char
            End If
            slashes = 0
        End If
    Next
    Quote = rendered & String(2 * slashes, "\") & """"
End Function
