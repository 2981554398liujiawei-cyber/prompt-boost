' Prompt Boost — 在「启动」文件夹创建指向 launch-prompt-boost.vbs 的快捷方式。
' 用法：cscript install-autostart.vbs <vbs路径> <lnk路径>
Option Explicit
Dim shell, vbsPath, lnkPath, link
Set shell = CreateObject("WScript.Shell")
vbsPath = WScript.Arguments(0)
lnkPath = WScript.Arguments(1)
Set link = shell.CreateShortcut(lnkPath)
link.TargetPath = vbsPath
link.WorkingDirectory = ""
link.Description = "Prompt Boost Local Agent (autostart)"
link.Save
Set link = Nothing
Set shell = Nothing
WScript.Echo "shortcut created: " & lnkPath
