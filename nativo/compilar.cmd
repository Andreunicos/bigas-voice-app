@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
cd /d "%~dp0"
cl /nologo /O2 /W3 teclas.c user32.lib
cl /nologo /O2 /W3 /EHsc somdoapp.cpp
