@echo off
cls
echo ========================================
echo Ebb Orchestrator - Запуск сервера
echo ========================================
echo.
echo Запуск...
echo.

set EBB_ORCHESTRATOR_BOOTSTRAP_FILE=C:\Users\alex1\.ebb-orchestrator\bootstrap.json

node apps\server\dist\main.js
