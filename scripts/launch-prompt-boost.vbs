' Prompt Boost 本地服务 — 开机自启隐藏启动器
' 以隐藏窗口方式调用 launch-prompt-boost.cmd（运行 node dist/server.js）。
' 被放在「启动」文件夹，登录时自动执行，无任何窗口闪现。
Option Explicit
Dim shell, fso, scriptDir, cmd
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = """" & scriptDir & "\launch-prompt-boost.cmd"""
shell.Run cmd, 0, False
Set shell = Nothing
Set fso = Nothing
