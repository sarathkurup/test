@echo off
REM Build Switchboard and install it into VS Code.
REM
REM Double-clicking the .vsix itself will not work on a machine with Visual
REM Studio installed: Windows hands .vsix to Visual Studio's VSIXInstaller,
REM which cannot install VS Code extensions. Double-click this file instead.

setlocal
cd /d "%~dp0"

set VSIX=switchboard-0.2.0.vsix

echo.
echo === Compiling ===
call npm run compile
if errorlevel 1 goto :failed

echo.
echo === Regenerating the gallery icon ===
call npm run icon
if errorlevel 1 echo (icon step skipped)

echo.
echo === Packaging ===
call npx @vscode/vsce package
if errorlevel 1 goto :failed

echo.
echo === Removing previous installs ===
call code --uninstall-extension local.switchboard >nul 2>&1
call code --uninstall-extension local.enterprise-ai-bridge >nul 2>&1
for %%D in (local.switchboard-0.2.0 local.enterprise-ai-bridge-0.1.0) do (
  if exist "%USERPROFILE%\.vscode\extensions\%%D" rmdir /s /q "%USERPROFILE%\.vscode\extensions\%%D"
)

echo.
echo === Installing into VS Code ===
call code --install-extension "%~dp0%VSIX%" --force
if errorlevel 1 goto :failed

echo.
echo === Installed. Restart VS Code to load it. ===
call code --list-extensions --show-versions | findstr /i switchboard
echo.
pause
exit /b 0

:failed
echo.
echo *** FAILED. See the messages above. ***
echo.
pause
exit /b 1
