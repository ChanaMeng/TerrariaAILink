@echo off
chcp 65001 >nul
title 一键叫鲸白进游戏
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-whale.ps1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-whale.ps1"
)
