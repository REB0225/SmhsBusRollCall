import './style.css';

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
const BATTERY_SERVICE_UUID = 0x180F;
const BATTERY_LEVEL_UUID = 0x2A19;
const BASE_URL = 'https://ue86ozvpct9r.share.zrok.io';
interface Student {
  uid: string;
  name: string;
  badge: string;
  bus?: string;
  photo?: string;
}

interface PendingRecord {
  uid: string;
  timestamp: string;
  name: string;
  badge: string;
  selectedBusAtTimeOfScan: string;
  studentBus: string;
}

class App {
  // Elements
  private loginView = document.getElementById('login-view')!;
  private mainView = document.getElementById('main-view')!;
  private busSelect = document.getElementById('bus-select') as HTMLSelectElement;
  private reviewBusSelect = document.getElementById('review-bus-select') as HTMLSelectElement;
  private statusDot = document.getElementById('status-dot')!;
  private statusText = document.getElementById('status-text')!;
  private batteryInfo = document.getElementById('battery-info')!;
  private batteryLevel = document.getElementById('battery-level')!;
  private studentCard = document.getElementById('student-card')!;
  private readyState = document.getElementById('ready-state')!;
  private syncFooter = document.getElementById('sync-footer')!;
  private pendingCount = document.getElementById('pending-count')!;
  private reviewSheet = document.getElementById('review-sheet')!;
  private reviewList = document.getElementById('review-list')!;
  private reviewSummary = document.getElementById('review-summary')!;
  private loadingOverlay = document.getElementById('loading-overlay')!;

  // State
  private authToken: string | null = null;
  private currentStudent: Student | null = null;
  private pendingRollCalls: PendingRecord[] = [];
  private bleDevice: BluetoothDevice | null = null;
  private isConnected = false;
  private isSyncing = false;
  private allStudents: Record<string, Student> = {};
  private isMismatchedData = false;

  constructor() {
    this.initEventListeners();
    this.checkSession();
    this.checkBluetoothSupport();
  }

  private getCurrentSlot(dateObj: Date = new Date()): string {
    const taipeiTime = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Taipei',
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
    }).format(dateObj);
    
    const [hours, minutes] = taipeiTime.split(':').map(Number);
    const currentTimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

    if (currentTimeStr >= "07:00" && currentTimeStr < "09:00") return "07:00-09:00";
    if (currentTimeStr >= "16:00" && currentTimeStr < "18:00") return "16:00-18:00";
    if (currentTimeStr >= "19:00" && currentTimeStr < "21:00") return "19:00-21:00";
    return "Not in time";
  }

  private isSameSlot(t1: string, t2: string): boolean {
    const d1 = new Date(t1);
    const d2 = new Date(t2);
    const dateMatches = d1.toISOString().split('T')[0] === d2.toISOString().split('T')[0];
    const slotMatches = this.getCurrentSlot(d1) === this.getCurrentSlot(d2);
    return dateMatches && slotMatches;
  }

  private checkBluetoothSupport() {
    if (!navigator.bluetooth) {
        const errorEl = document.getElementById('status-message-ready')!;
        errorEl.textContent = "Web Bluetooth is not supported in this browser or context (requires HTTPS/Localhost).";
        errorEl.style.display = "block";
        
        const connectBtn = document.getElementById('connect-ble-btn') as HTMLButtonElement;
        if (connectBtn) {
            connectBtn.disabled = true;
            connectBtn.style.opacity = "0.5";
            connectBtn.classList.remove('pulse');
        }
    }
  }

  private initEventListeners() {
    // Login
    document.getElementById('login-btn')?.addEventListener('click', () => this.handleLogin());
    
    // BLE
    document.getElementById('connect-ble-btn')?.addEventListener('click', () => this.connectScanner());
    document.getElementById('disconnect-btn')?.addEventListener('click', () => this.disconnectScanner());
    
    // Review & Sync
    document.getElementById('review-btn')?.addEventListener('click', () => this.openReview());
    document.getElementById('close-review')?.addEventListener('click', () => this.closeReview());
    document.getElementById('sync-now-btn')?.addEventListener('click', () => this.syncRecords());
    
    // Bus Selection
    this.busSelect.addEventListener('change', () => {
        this.updateUIColors();
        this.reviewBusSelect.value = this.busSelect.value;
    });
    this.reviewBusSelect.addEventListener('change', () => {
        this.busSelect.value = this.reviewBusSelect.value;
        this.updateUIColors();
        this.openReview(false); // Refresh list to update highlight, but don't re-init from main
    });
  }

  private checkSession() {
    const savedToken = localStorage.getItem('userToken');
    if (savedToken) {
        this.authToken = savedToken;
        this.startMainView();
    }
  }

  private async handleLogin() {
    const user = (document.getElementById('username') as HTMLInputElement).value;
    const pass = (document.getElementById('password') as HTMLInputElement).value;
    const errorEl = document.getElementById('login-error')!;

    try {
      const res = await fetch(`${BASE_URL}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      const data = await res.json();
      if (res.ok) {
        this.authToken = data.token;
        localStorage.setItem('userToken', data.token);
        this.startMainView();
      } else {
        errorEl.textContent = data.error || 'Login failed';
      }
    } catch (err) {
      errorEl.textContent = 'Network error';
    }
  }

  private async startMainView() {
    this.loginView.style.display = 'none';
    this.mainView.style.display = 'flex';
    this.loadPendingRecords();
    await this.fetchBuses();
    await this.fetchStudents();
  }

  private async fetchBuses() {
    try {
      const res = await fetch(`${BASE_URL}/api/buses`, {
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      const buses = await res.json();
      buses.forEach((bus: any) => {
        const busName = typeof bus === 'string' ? bus : (bus.name || bus.bus);
        if (!busName) return;

        const opt = document.createElement('option');
        opt.value = busName;
        opt.textContent = busName;
        this.busSelect.appendChild(opt);

        const opt2 = document.createElement('option');
        opt2.value = busName;
        opt2.textContent = busName;
        this.reviewBusSelect.appendChild(opt2);
      });
    } catch (err) { console.error("Bus fetch error", err); }
  }

  private async fetchStudents() {
    try {
      // Get current date in Taipei (UTC+8)
      const taipeiDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const dateStr = taipeiDate.getFullYear() + '-' + 
                     String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + 
                     String(taipeiDate.getDate()).padStart(2, '0');
      
      const res = await fetch(`${BASE_URL}/api/students?date=${dateStr}`, {
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      this.allStudents = await res.json();
    } catch (err) { console.error("Students fetch error", err); }
  }

  private async connectScanner() {
    if (this.isMismatchedData && this.pendingRollCalls.length > 0) {
        alert("Please resolve the stale data from a different time slot before connecting the scanner.");
        this.openReview();
        return;
    }
    try {
      this.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ name: 'ESP32-C3-Scanner' }],
        optionalServices: [SERVICE_UUID, BATTERY_SERVICE_UUID]
      });

      this.updateStatus(true, "Connecting...");
      const server = await this.bleDevice.gatt?.connect();
      if (!server) return;

      // RFID Notify
      const rfidService = await server.getPrimaryService(SERVICE_UUID);
      const rfidChar = await rfidService.getCharacteristic(CHARACTERISTIC_UUID);
      await rfidChar.startNotifications();
      rfidChar.addEventListener('characteristicvaluechanged', (e: any) => {
        const uid = new TextDecoder().decode(e.target.value);
        this.handleScan(uid);
      });

      // Battery
      try {
        const batService = await server.getPrimaryService(BATTERY_SERVICE_UUID);
        const batChar = await batService.getCharacteristic(BATTERY_LEVEL_UUID);
        const updateBat = (val: DataView) => {
            const level = val.getUint8(0);
            this.batteryLevel.textContent = level.toString();
            this.batteryInfo.style.display = 'flex';
        };
        batChar.addEventListener('characteristicvaluechanged', (e: any) => updateBat(e.target.value));
        await batChar.startNotifications();
        updateBat(await batChar.readValue());
      } catch (e) {}

      this.isConnected = true;
      this.updateStatus(true, "Connected");
      this.readyState.style.display = 'none';
      this.studentCard.style.display = 'block';

      this.bleDevice.addEventListener('gattserverdisconnected', () => {
        this.isConnected = false;
        this.updateStatus(false, "Disconnected");
        this.readyState.style.display = 'flex';
        this.studentCard.style.display = 'none';
        document.body.className = 'gray-bg';
      });

    } catch (err) {
      console.error(err);
      this.updateStatus(false, "Failed");
    }
  }

  private disconnectScanner() {
    this.bleDevice?.gatt?.disconnect();
  }

  private updateStatus(connected: boolean, text: string) {
    this.statusText.textContent = text;
    this.statusDot.className = `dot ${connected ? 'connected' : 'disconnected'}`;
  }

  private async handleScan(uid: string) {
    // 1. Resolve student from local cache ONLY for instant response
    const student = this.allStudents[uid];
    
    this.currentStudent = student || { uid, name: "Unknown Tag", badge: "---", bus: "Unknown" };
    
    // 2. Update UI
    this.displayStudent(this.currentStudent);
    this.updateUIColors();

    // 3. Auto Record logic
    this.addPendingRecord(uid, this.currentStudent.name, this.currentStudent.badge || "---", this.currentStudent.bus || "Unknown");
  }

  private displayStudent(s: Student) {
    (document.getElementById('student-name')!).textContent = s.name;
    (document.getElementById('student-badge')!).textContent = s.badge;
    (document.getElementById('student-uid')!).textContent = s.uid;
    (document.getElementById('student-bus')!).textContent = s.bus || 'No Bus Assigned';

    const photoEl = document.getElementById('student-photo') as HTMLImageElement;
    if (s.badge !== "---") {
        photoEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(s.name)}&background=random`;
        this.fetchPhotoSecure(s.uid);
    } else {
        photoEl.src = `https://ui-avatars.com/api/?name=?&background=random`;
    }
  }

  private async fetchPhotoSecure(uid: string) {
    const photoEl = document.getElementById('student-photo') as HTMLImageElement;
    try {
        const res = await fetch(`${BASE_URL}/api/photo/${uid}`, {
            headers: { 'Authorization': `Bearer ${this.authToken}` }
        });
        if (res.ok) {
            const blob = await res.blob();
            photoEl.src = URL.createObjectURL(blob);
        }
    } catch (e) {}
  }

  private updateUIColors() {
    const s = this.currentStudent;
    const bus = this.busSelect.value;
    const msgEl = document.getElementById('status-message')!;
    
    if (!s) { document.body.className = 'gray-bg'; return; }
    if (!bus) { 
        document.body.className = 'gray-bg'; 
        msgEl.textContent = "Please select a bus first";
        msgEl.style.color = "gray";
        return; 
    }

    if (s.name === "Unknown Tag") {
        document.body.className = 'red-bg';
        msgEl.textContent = "Tag not in database";
        msgEl.style.color = "white";
    } else if (s.bus === bus) {
        document.body.className = 'green-bg';
        msgEl.textContent = "Matches selected bus";
        msgEl.style.color = "white";
    } else {
        document.body.className = 'yellow-bg';
        msgEl.textContent = "Wrong bus selected";
        msgEl.style.color = "black";
    }
  }

  private addPendingRecord(uid: string, name: string, badge: string, studentBus: string) {
    const timestamp = new Date().toISOString();
    const selectedBusAtTimeOfScan = this.busSelect.value;
    // Avoid duplicate UIDs in the same session
    if (!this.pendingRollCalls.some(r => r.uid === uid)) {
        this.pendingRollCalls.push({ uid, timestamp, name, badge, studentBus, selectedBusAtTimeOfScan });
        this.updatePendingUI();
    }
  }

  private savePendingRecords() {
    localStorage.setItem('pendingRollCalls', JSON.stringify(this.pendingRollCalls));
  }

  private loadPendingRecords() {
    const saved = localStorage.getItem('pendingRollCalls');
    if (saved) {
        try {
            this.pendingRollCalls = JSON.parse(saved);
            
            // Check for mismatched date/slot
            const now = new Date();
            this.isMismatchedData = this.pendingRollCalls.some(r => !this.isSameSlot(r.timestamp, now.toISOString()));
            
            this.updatePendingUI();
            
            if (this.isMismatchedData && this.pendingRollCalls.length > 0) {
                setTimeout(() => this.openReview(), 500); // Small delay to ensure UI is ready
            }
        } catch (e) {
            console.error("Error loading pending records", e);
        }
    }
  }

  private updatePendingUI() {
    const count = this.pendingRollCalls.length;
    this.pendingCount.textContent = count.toString();
    this.syncFooter.style.display = count > 0 ? 'block' : 'none';
    
    // Clear mismatch flag if list is empty
    if (count === 0) {
        this.isMismatchedData = false;
    }
    
    this.savePendingRecords();
  }

  private openReview(initFromMain = true) {
    if (initFromMain) {
        this.reviewBusSelect.value = this.busSelect.value;
    }
    
    this.reviewList.innerHTML = '';
    let readyCount = 0;
    let wrongCount = 0;
    let unknownCount = 0;

    const currentBus = this.reviewBusSelect.value;

    const cancelBtn = document.getElementById('close-review')!;
    if (this.isMismatchedData) {
        cancelBtn.style.display = 'none';
        const warning = document.createElement('div');
        warning.className = 'error-text';
        warning.style.textAlign = 'center';
        warning.style.marginBottom = '15px';
        warning.style.padding = '10px';
        warning.style.background = '#fff0f0';
        warning.style.borderRadius = '10px';
        warning.textContent = "⚠️ Stale data detected from a different time slot. Please sync or delete these records before continuing.";
        this.reviewList.appendChild(warning);
    } else {
        cancelBtn.style.display = 'block';
    }

    this.pendingRollCalls.forEach((record, index) => {
        let badgeHtml = '';
        if (record.name === "Unknown Tag") {
            badgeHtml = '<span class="badge badge-unknown">UNKNOWN</span>';
            unknownCount++;
        } else if (record.studentBus === currentBus) {
            badgeHtml = '<span class="badge badge-ready">READY</span>';
            readyCount++;
        } else {
            badgeHtml = '<span class="badge badge-wrong">WRONG BUS</span>';
            wrongCount++;
        }

        const item = document.createElement('div');
        item.className = 'review-item';
        item.innerHTML = `
            <div class="review-info">
                <h4 style="display: flex; align-items: center; gap: 8px; margin: 0;">
                    ${record.name} ${badgeHtml}
                </h4>
                <p style="margin: 4px 0;">Badge: ${record.badge} | UID: ${record.uid}</p>
                <p style="font-size: 11px; color: #666; margin: 0;">Assigned: ${record.studentBus} | Scanned for: ${record.selectedBusAtTimeOfScan}</p>
                <div style="font-size: 10px; color: #999; margin-top: 4px; display: flex; gap: 8px;">
                    <span>📅 ${new Date(record.timestamp).toLocaleDateString()}</span>
                    <span>⏰ ${new Date(record.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
            </div>
            <button class="text-btn delete-btn" data-index="${index}">Delete</button>
        `;
        item.querySelector('.delete-btn')?.addEventListener('click', (e: any) => {
            const idx = parseInt(e.target.dataset.index);
            this.pendingRollCalls.splice(idx, 1);
            this.openReview(false); // Refresh list without resetting bus selector
            this.updatePendingUI();
        });
        this.reviewList.appendChild(item);
    });

    this.reviewSummary.innerHTML = `
        <div class="summary-pills">
            <span class="pill">Total: ${this.pendingRollCalls.length}</span>
            <span class="pill ready">Ready: ${readyCount}</span>
            <span class="pill wrong">Wrong: ${wrongCount}</span>
            <span class="pill unknown">Unknown: ${unknownCount}</span>
        </div>
    `;
    this.reviewSheet.style.display = 'flex';
  }

  private closeReview() {
    if (this.isMismatchedData && this.pendingRollCalls.length > 0) {
        alert("Please resolve the stale data first.");
        return;
    }
    this.reviewSheet.style.display = 'none';
  }

  private async syncRecords() {
    if (this.isSyncing || this.pendingRollCalls.length === 0) return;

    const currentBus = this.reviewBusSelect.value;
    const recordsToSync = this.pendingRollCalls.filter(r => r.studentBus === currentBus && r.name !== "Unknown Tag");
    
    if (recordsToSync.length === 0) {
        alert(`No valid records for ${currentBus} to sync.`);
        return;
    }

    this.isSyncing = true;
    const btn = document.getElementById('sync-now-btn') as HTMLButtonElement;
    btn.textContent = "Syncing...";
    btn.disabled = true;

    try {
        const records = recordsToSync.map(r => ({ uid: r.uid, timestamp: r.timestamp }));
        const res = await fetch(`${BASE_URL}/api/rollcall/batch`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${this.authToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ records })
        });

        if (res.ok) {
            this.pendingRollCalls = this.pendingRollCalls.filter(r => !recordsToSync.includes(r));
            this.updatePendingUI();
            this.closeReview();
            alert("Sync complete!");
        } else {
            alert("Sync failed");
        }
    } catch (e) {
        alert("Network error");
    } finally {
        this.isSyncing = false;
        btn.textContent = "Confirm & Sync to Backend";
        btn.disabled = false;
    }
  }
}

new App();
