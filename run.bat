@echo off
cd /d "%~dp0"

if not exist node_modules\electron\dist\electron.exe (
    echo Instalando dependencias por primera vez...
    set NODE_OPTIONS=--use-system-ca
    npm install
    echo.
)

set NODE_OPTIONS=--use-system-ca
start "" node_modules\electron\dist\electron.exe .
