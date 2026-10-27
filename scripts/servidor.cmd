@echo off
rem Servidor do escritorio. O Agendador de Tarefas roda isto quando o Windows entra (docs/SERVIDOR-WINDOWS.md).
title Umbler 2.0 - servidor (nao feche esta janela)
cd /d "%~dp0.."
npm run servidor
pause
