# Bus Roll Call System

A multi-platform RFID roll call system with a TypeScript/CSV backend and modern web/mobile clients.

## Project Structure

-   `/backend`: TypeScript Express server reading student data from `students.csv`.
-   `/frontend`: TypeScript + Vanilla CSS web dashboard (Vite), mirroring the iOS app design.
-   `/iPhoneApp`: Native SwiftUI iOS application.
-   `BusRollCall.ino`: ESP32 firmware for the RFID scanner.

## Setup & Running

### 1. Backend (TypeScript + CSV)
The backend maps RFID UIDs to student names and badge numbers.
```bash
cd backend
npm install
npm start
```
-   **Database:** Edit `backend/students.csv` to add your tags.
-   **URL:** `http://localhost:5000`

### 2. Frontend (Web Dashboard)
A modern web interface using Web Bluetooth.
```bash
cd frontend
npm install
npm run dev
```
-   **URL:** `http://localhost:5173` (or as shown in terminal).
-   **Note:** Use Chrome/Edge and ensure the backend is running.

### 3. iOS App
1. Open `iPhoneApp/BusRollCall/BusRollCall.xcodeproj` in Xcode.
2. If testing on a physical device, update `localhost` in `BLEManager.swift` to your Mac's local IP (e.g., `192.168.x.x`).
3. Build and run.

### 4. ESP32 Hardware
-   Flash `BusRollCall.ino` to your ESP32.
-   Connect the RC522 RFID reader as per the pinout in `GEMINI.md`.

## Data Format (CSV)
`backend/students.csv` format:
```csv
uid,name,badge
12345678,Alice Wang,2024001
```
