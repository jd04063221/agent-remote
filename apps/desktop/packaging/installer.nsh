!macro customInstall
  System::Call 'Kernel32::SetEnvironmentVariable(t "AR_BIN_DIR", t "$INSTDIR\resources\bin")'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$t = $$env:AR_BIN_DIR.Trim().TrimEnd([char]92); $$c = [Environment]::GetEnvironmentVariable('Path', 'User'); $$e = @(); if ($$c) { $$e = $$c -split ';' | Where-Object { $$_.Trim() -ne '' } }; $$f = @($$e | Where-Object { $$_.Trim().TrimEnd([char]92) -ine $$t }); [Environment]::SetEnvironmentVariable('Path', (($$f + $$t) -join ';'), 'User')"`
!macroend

!macro customUnInstall
  System::Call 'Kernel32::SetEnvironmentVariable(t "AR_BIN_DIR", t "$INSTDIR\resources\bin")'
  nsExec::ExecToLog `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$t = $$env:AR_BIN_DIR.Trim().TrimEnd([char]92); $$c = [Environment]::GetEnvironmentVariable('Path', 'User'); if ($$c) { $$e = $$c -split ';' | Where-Object { $$_.Trim() -ne '' }; $$f = @($$e | Where-Object { $$_.Trim().TrimEnd([char]92) -ine $$t }); [Environment]::SetEnvironmentVariable('Path', ($$f -join ';'), 'User') }"`
!macroend
