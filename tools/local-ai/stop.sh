#!/usr/bin/env bash
# Stop the local LLM server (frees ~13 GB RAM / VRAM).
powershell -NoProfile -Command "Get-Process llama-server -ErrorAction SilentlyContinue | Stop-Process -Force" && echo "local AI stopped"
