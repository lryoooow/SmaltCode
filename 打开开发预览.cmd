@echo off
chcp 65001 >nul
cd /d "%~dp0"
node scripts\start-desktop-preview.mjs
if errorlevel 1 pause
