# Bus Roll Call Project

A multi-platform system for scanning RFID cards to perform bus roll calls. The system consists of an ESP32-based hardware scanner, a native iOS application, a web-based user dashboard, and an admin management panel.

## Project Overview

- **Hardware (ESP32-C3 SuperMini):** Scans RC522 RFID tags, provides buzzer feedback, and broadcasts data over BLE.
- **Backend (Express/TypeScript):** Connects to **Firestore** for real-time data storage with a local CSV/JSON fallback.
- **iOS App (SwiftUI):** Native app with local recording, manual review, and batch sync capabilities.
- **User Dashboard (Vite/TS):** Web-based scanner interface matching the iOS experience, utilizing Web Bluetooth (GATT).
- **Admin Panel (Vite/HTML):** management interface for exporting roll call records filtered by date and time slots.

## Architecture

- **Database:** Uses **Google Cloud Firestore** as the primary database. Automatically falls back to local files (`students.csv`, `accounts.json`) if `serviceAccountKey.json` is missing.
- **Roll Call Slots:** Scans are automatically categorized by Taipei time:
    - `07:00-09:00` (Morning)
    - `16:00-18:00` (Afternoon)
    - `19:00-21:00` (Evening)
    - `Not in time` (Fallback)
- **Sync Workflow:** Both clients (iOS/Web) capture local timestamps during scans and perform a **Batch Sync** after user review to ensure data integrity.

## Building and Running

### Backend (`/backend`)
- **Setup:** Requires `serviceAccountKey.json` from Firebase Console.
- **Migration:** Run `npm run migrate` to push local CSV data to Firestore.
- **Command:** `npm start` (Runs on port 5001).

### Web Dashboards (`/frontend` & `/admin-frontend`)
- **Environment:** Powered by **Vite**.
- **Configuration:** `vite.config.js` is set to `0.0.0.0` with `allowedHosts: true` to support **zrok** and public proxies.
- **Commands:** `npm run dev` (Ports 5173 and 5174).
- **Public Sharing:** `zrok share public http://localhost:5174`

### iOS App (`/iPhoneApp/BusRollCall`)
- **Requirements:** Physical device (Bluetooth) and Xcode.
- **Permissions:** `NSBluetoothAlwaysUsageDescription` added to `Info.plist`.
- **Logic:** Uses `BLEManager` for reactive Bluetooth state and batch recording.

## Development Conventions

- **BLE UUIDs:** 
    - Device Name: `ESP32-C3-Scanner`
    - RFID Service: `4fafc201-1fb5-459e-8fcc-c5c9c331914b`
    - RFID Characteristic: `beb5483e-36e1-4688-b7f5-ea07361b26a8`
- **Data Format:** 
    - Batch Sync: `POST /api/rollcall/batch` with an array of `{uid, timestamp}` objects.
- **UI Colors:**
    - **Green:** Success (Correct bus).
    - **Yellow:** Warning (Wrong bus).
    - **Red:** Error (Unknown tag).
    - **Gray:** Idle/No Bus selected.
