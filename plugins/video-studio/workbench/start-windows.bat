@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 20 或更新版本：https://nodejs.org/
  echo 安装与运行说明见 README.md。
  pause
  exit /b 1
)
node start.mjs
if errorlevel 1 pause
