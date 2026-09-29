; NSIS customisation — the `beeflow://` scheme handler.
;
; electron-builder writes the protocol registration into HKCU for a per-user
; install, which is the default here. This block repeats it under whichever
; root the install actually used, so a machine-wide install (installed by IT,
; used by someone without registry write access) still opens deep links.
!macro customInstall
  WriteRegStr SHELL_CONTEXT "Software\Classes\beeflow" "" "URL:Bee Flow Protocol"
  WriteRegStr SHELL_CONTEXT "Software\Classes\beeflow" "URL Protocol" ""
  WriteRegStr SHELL_CONTEXT "Software\Classes\beeflow\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHELL_CONTEXT "Software\Classes\beeflow\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey SHELL_CONTEXT "Software\Classes\beeflow"
!macroend
