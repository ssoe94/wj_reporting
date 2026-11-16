Option Explicit
Dim shell, files, scriptFolder, command, scriptName
Set shell = CreateObject("WScript.Shell")
Set files = CreateObject("Scripting.FileSystemObject")
scriptFolder = files.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
scriptName = WScript.Arguments(0)
Select Case scriptName
    Case "start", "agent-view", "supervise"
    Case Else
        WScript.Quit 2
End Select
command = """" & shell.ExpandEnvironmentStrings("%ComSpec%") & """ /d /s /c """"" & _
          scriptFolder & "\" & scriptName & ".cmd"""""
WScript.Quit shell.Run(command, 0, True)
