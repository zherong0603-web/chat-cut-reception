#!/bin/zsh
set -u
cd "${0:A:h}" || exit 1
reception_plist="${XHS_RECEPTION_PLIST:-$HOME/Library/LaunchAgents/com.chatcut.reception-v2.plist}"
reception_node=$(/usr/libexec/PlistBuddy -c 'Print :ProgramArguments:0' "$reception_plist" 2>/dev/null)
if [[ ! -x "$reception_node" ]]; then
  print '没有找到已安装的接待程序。请把这个提示告诉 Codex。'
  read -r 'reception_answer?按回车关闭此窗口。'
  exit 1
fi
reception_result=0
"$reception_node" reception_v2/relogin-service.mjs --run || reception_result=$?
read -r 'reception_answer?按回车关闭此窗口。'
exit "$reception_result"
