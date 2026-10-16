; Extra steps for the Face Guard uninstaller (included by electron-builder's NSIS script).
;
; On a real uninstall (not when an update replaces the old version):
;   1. Remove the "start with Windows" entry Face Guard registers for itself.
;   2. Ask whether to delete settings and touch history as well (default: keep them).

!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "com.blakejordan.faceguard"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "com.blakejordan.faceguard"

    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete your Face Guard settings and touch history?$\r$\n$\r$\nChoose No to keep them in case you reinstall." /SD IDNO IDNO +3
      ReadEnvStr $0 APPDATA
      RMDir /r "$0\${PRODUCT_NAME}"
  ${endIf}
!macroend
