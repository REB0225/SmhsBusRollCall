import './style.css';

const SERVICE_UUID = "4fafc201-1fb5-459e-8fcc-c5c9c331914b";
const CHARACTERISTIC_UUID = "beb5483e-36e1-4688-b7f5-ea07361b26a8";
const BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb";
const BATTERY_LEVEL_UUID = "00002a19-0000-1000-8000-00805f9b34fb";
const BASE_URL = 'https://bus-rollcall-backend.s211009.workers.dev';

interface Student {
  uid: string;
  name: string;
  badge: string;
  class?: string;
  bus?: string;
  photo?: string;
}

interface PendingRecord {
  uid: string;
  timestamp: string;
  name: string;
  badge: string;
  class?: string;
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
  private currentUid: string | null = null;
  private authToken: string | null = null;
  private currentStudent: Student | null = null;
  private pendingRollCalls: PendingRecord[] = [];
  private allStudents: Record<string, Student> = {};
  private bleDevice: BluetoothDevice | null = null;
  private isConnected = false;
  private isSyncing = false;
  private isMismatchedData = false;
  private preseLogoutButton = false;

  constructor() {
    this.initEventListeners();
    this.checkSession();
    this.checkBluetoothSupport();
  }

  private currentSlotCache: { slot: string, csvType: string, fetchedAt: number } | null = null;

  private async getCurrentSlot(): Promise<{ slot: string, csvType: string }> {
    const now = Date.now();
    if (this.currentSlotCache && now - this.currentSlotCache.fetchedAt < 60_000) {
      return { slot: this.currentSlotCache.slot, csvType: this.currentSlotCache.csvType };
    }
    try {
      const res = await fetch(`${BASE_URL}/api/current-slot`, {
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      const data = await res.json();
      this.currentSlotCache = { slot: data.slot, csvType: data.csvType, fetchedAt: now };
      return { slot: data.slot, csvType: data.csvType };
    } catch (e) {
      console.error('Failed to fetch current slot:', e);
      return { 
        slot: this.currentSlotCache?.slot ?? 'unknown', 
        csvType: this.currentSlotCache?.csvType ?? 'arrival' 
      };
    }
}

  private async isSameSlot(recordTimestamp: string): Promise<boolean> {
    const recordDate = new Date(recordTimestamp);
    
    // Fetch active slot info
    const { slots, default: defaultSlot } = await this.getCurrentSlotConfig();
    const slotInfo = this.getTimeSlotInfo(slots, defaultSlot, recordDate);
    
    // Get current active slot info
    const now = new Date();
    const currentSlotInfo = this.getTimeSlotInfo(slots, defaultSlot, now);
    
    // Compare if they fall in the same slot definition
    return slotInfo.csvType === currentSlotInfo.csvType && 
           slotInfo.label === currentSlotInfo.label;
  }

  private async getCurrentSlotConfig() {
      const res = await fetch(`${BASE_URL}/api/admin/config/slots`, {
          headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      return await res.json();
  }

  // Simple copy of backend logic for frontend check
  private getTimeSlotInfo(slots: any[], defaultSlot: any, dateObj: Date) {
      const taipeiTime = new Date(dateObj.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const currentTimeStr = `${taipeiTime.getHours().toString().padStart(2, '0')}:${taipeiTime.getMinutes().toString().padStart(2, '0')}`;
      const day = taipeiTime.getDay();
    
      const matches = slots.filter((s: any) => {
        const matchDay = (s.day === undefined && s.days === undefined) || 
                        (s.day !== undefined && s.day === day) || 
                        (s.days !== undefined && s.days.includes(day));
        return matchDay && currentTimeStr >= s.start && currentTimeStr < s.end;
      });
    
      return matches.length === 0 ? { ...defaultSlot, start: "00:00", end: "23:59" } : matches[0];
  }

  private initEventListeners() {
    // Login,Logout
    document.getElementById('login-btn')?.addEventListener('click', () => this.handleLogin());

    // Scanner
    document.getElementById('connect-ble-btn')?.addEventListener('click', () => this.connectScanner());;

    // Review
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
    
    //Logout Button
    document.getElementById('disconnect-btn')?.addEventListener('click', () => {
      if (this.isConnected) {
        this.disconnectScanner();
      } else {
        // If not connected, handle logout or potential data loss
        if (this.pendingRollCalls.length > 0) {
            // If there are pending records, open the review modal to prompt the user
            // The review modal will now need a "Logout and Clear Data" option
            this.preseLogoutButton = true;
            this.openReview();
            // We will add the logout logic *within* the openReview modal context in a subsequent step
        } else {
            // If no pending records, proceed directly to logout
            this.logout();
        }
      }
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
        errorEl.textContent = data.error || '登入失敗';
      }
    } catch (err) {
      errorEl.textContent = '網路錯誤';
    }
  }

  private async startMainView() {
    this.loginView.style.display = 'none';
    this.mainView.style.display = 'flex';
    this.updateDisconnectBtn();
    const csvType = await this.updateTimeslotDisplay();
    await this.loadPendingRecords();
    await this.fetchBuses(csvType);
    await this.fetchStudents(csvType);
  }

  private async updateTimeslotDisplay() {
    const { slot, csvType } = await this.getCurrentSlot();
    const timeslotText = document.getElementById('timeslot-text')!;
    timeslotText.textContent = slot;
    return csvType;
  }

  private async fetchBuses(csvType?: string) {
    try {
      let url = `${BASE_URL}/api/buses`;
      if (csvType) url += `?csvType=${csvType}`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      const buses = await res.json();
      this.busSelect.innerHTML = '<option value="">請選擇車次</option>';
      this.reviewBusSelect.innerHTML = '<option value="">請選擇車次</option>';
      
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

  private async fetchStudents(csvType?: string) {
    try {
      // Get current date in Taipei (UTC+8)
      const taipeiDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const dateStr = taipeiDate.getFullYear() + '-' + 
                     String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + 
                     String(taipeiDate.getDate()).padStart(2, '0');
      
      let url = `${BASE_URL}/api/students?date=${dateStr}`;
      if (csvType) url += `&csvType=${csvType}`;

      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      this.allStudents = await res.json();
    } catch (err) { console.error("Students fetch error", err); }
  }

  private async connectScanner() {
    if (this.isMismatchedData && this.pendingRollCalls.length > 0) {
        alert("請在連接掃描器前，先處理來自不同時段的舊資料。");
        this.openReview();
        return;
    }
    try {
      this.bleDevice = await navigator.bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }],
        optionalServices: [BATTERY_SERVICE_UUID]
      });

      this.updateStatus(true, "正在連接...");
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
      this.updateDisconnectBtn();
      this.updateStatus(true, "已連接");
      this.readyState.style.display = 'none';
      this.studentCard.style.display = 'block';

      this.bleDevice.addEventListener('gattserverdisconnected', () => {
        this.isConnected = false;
        this.updateDisconnectBtn();
        this.updateStatus(false, "已斷開連接");
        this.readyState.style.display = 'flex';
        this.readyState.style.flexDirection = 'column';
        this.studentCard.style.display = 'none';
        document.body.className = 'gray-bg';
      });

    } catch (err) {
      console.error(err);
      this.updateStatus(false, "連接失敗");
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
    
    this.currentStudent = student || { uid, name: "未知標籤", badge: "---", class: "---", bus: "未知" };
    
    // 2. Update UI
    this.displayStudent(this.currentStudent);
    this.updateUIColors();

    // 3. Auto Record logic
    this.addPendingRecord(uid, this.currentStudent.name, this.currentStudent.badge || "---", this.currentStudent.class || "---", this.currentStudent.bus || "未知");
  }

  private displayStudent(s: Student) {

    this.currentUid = s.uid; // ← add this line

    (document.getElementById('student-name')!).textContent = s.name;
    (document.getElementById('student-badge')!).textContent = s.badge;
    (document.getElementById('student-class')!).textContent = s.class || "---";
    (document.getElementById('student-uid')!).textContent = s.uid;
    (document.getElementById('student-bus')!).textContent = s.bus || '未指派車次';

    const photoEl = document.getElementById('student-photo') as HTMLImageElement;
    if (s.badge !== "---") {
        photoEl.src = ``;
        this.fetchPhotoSecure(s.uid);
    } else {
        photoEl.src = `https://ui-avatars.com/api/?name=?&background=random`;
    }
  }

  private async fetchPhotoSecure(uid: string) {
    const photoLoading = document.getElementById('photo-loading')!;
    photoLoading.style.display = 'flex';
    
    try {
      const res = await fetch(`${BASE_URL}/api/photo/${uid}`, {
        headers: { 'Authorization': `Bearer ${this.authToken}` }
      });
      const photoEl = document.getElementById('student-photo') as HTMLImageElement;
      if (res.ok) {
        const blob = await res.blob();
        if (uid === this.currentUid) {
          if (photoEl.src.startsWith('blob:')) URL.revokeObjectURL(photoEl.src);
          photoEl.src = URL.createObjectURL(blob);
        }
      } else {
        if (uid === this.currentUid) {
            photoEl.src = `${BASE_URL}/api/placeholder?t=${Date.now()}`;
        }
      }
    } catch (e) {
      console.error('fetchPhotoSecure error:', e);
      const photoEl = document.getElementById('student-photo') as HTMLImageElement;
      if (uid === this.currentUid) {
          photoEl.src = `${BASE_URL}/api/placeholder?t=${Date.now()}`;
      }
    } finally {
      photoLoading.style.display = 'none'; // always hide, even on error
    }
  }

  private isBusMatch(studentBus: string | undefined, selectedBus: string): boolean {
    if (!studentBus || !selectedBus) return false;
    // Handle multiple buses separated by '/'
    const buses = studentBus.split('/').map(b => b.trim());
    return buses.includes(selectedBus);
  }

  private updateUIColors() {
    const s = this.currentStudent;
    const bus = this.busSelect.value;
    const msgEl = document.getElementById('status-message')!;
    
    if (!s) { document.body.className = 'gray-bg'; return; }
    if (!bus) { 
        document.body.className = 'purple-bg'; 
        msgEl.textContent = "請先選擇車次";
        msgEl.style.color = "black";
        return; 
    }

    if (s.name === "未知標籤") {
        document.body.className = 'red-bg';
        msgEl.textContent = "資料庫中無此標籤";
        msgEl.style.color = "white";
    } else if (this.isBusMatch(s.bus, bus)) {
        document.body.className = 'green-bg';
        msgEl.textContent = "符合所選車次";
        msgEl.style.color = "white";
    } else {
        document.body.className = 'yellow-bg';
        msgEl.textContent = "與所選車次不符";
        msgEl.style.color = "black";
    }
  }

  private addPendingRecord(uid: string, name: string, badge: string, studentClass: string, studentBus: string) {
    const timestamp = new Date().toISOString();
    const selectedBusAtTimeOfScan = this.busSelect.value;
    // Avoid duplicate UIDs in the same session
    if (!this.pendingRollCalls.some(r => r.uid === uid)) {
        this.pendingRollCalls.push({ uid, timestamp, name, badge, class: studentClass, studentBus, selectedBusAtTimeOfScan });
        this.updatePendingUI();
    }
  }

  private savePendingRecords() {
    localStorage.setItem('pendingRollCalls', JSON.stringify(this.pendingRollCalls));
  }

  private async loadPendingRecords() {
    const saved = localStorage.getItem('pendingRollCalls');
    if (saved) {
      try {
        this.pendingRollCalls = JSON.parse(saved);

        const checks = await Promise.all(
          this.pendingRollCalls.map(r => this.isSameSlot(r.timestamp))
        );
        this.isMismatchedData = checks.some(same => !same);

        this.updatePendingUI();
          if (this.isMismatchedData && this.pendingRollCalls.length > 0) {
            setTimeout(() => this.openReview(), 500);
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
    if (this.isMismatchedData && this.pendingRollCalls.length > 0) {
        cancelBtn.style.display = 'none';
        const warning = document.createElement('div');
        warning.className = 'error-text';
        warning.style.textAlign = 'center';
        warning.style.marginBottom = '15px';
        warning.style.padding = '10px';
        warning.style.background = 'var(--warning-bg)';
        warning.style.borderRadius = '10px';
        warning.textContent = "⚠️ 偵測到不同時段的舊資料。請在繼續之前上傳或刪除這些記錄。";
        this.reviewList.appendChild(warning);
    } else {
        cancelBtn.style.display = 'block';
    }

    this.pendingRollCalls.forEach((record, index) => {
        let badgeHtml = '';
        if (record.name === "未知標籤") {
            badgeHtml = '<span class="badge badge-unknown">未知</span>';
            unknownCount++;
        } else if (this.isBusMatch(record.studentBus, currentBus)) {
            badgeHtml = '<span class="badge badge-ready">就緒</span>';
            readyCount++;
        } else {
            badgeHtml = '<span class="badge badge-wrong">不符</span>';
            wrongCount++;
        }

        const item = document.createElement('div');
        item.className = 'review-item';
        item.innerHTML = `
            <div class="review-info">
                <h4 style="display: flex; align-items: center; gap: 8px; margin: 0;">
                    ${record.name} ${badgeHtml}
                </h4>
                <p style="margin: 4px 0;">班級: ${record.class || '---'} | 學號: ${record.badge} | UID: ${record.uid}</p>
                <p style="font-size: 11px; color: #666; margin: 0;">原定車次: ${record.studentBus} | 掃描車次: ${record.selectedBusAtTimeOfScan}</p>
                <div style="font-size: 10px; color: #999; margin-top: 4px; display: flex; gap: 8px;">
                    <span>📅 ${new Date(record.timestamp).toLocaleDateString()}</span>
                    <span>⏰ ${new Date(record.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
            </div>
            <button class="text-btn delete-btn" data-index="${index}">刪除</button>
        `;
        item.querySelector('.delete-btn')?.addEventListener('click', (e: any) => {
            const idx = parseInt(e.target.dataset.index);
            this.pendingRollCalls.splice(idx, 1);
            this.openReview(false); // Refresh list without resetting bus selector
            this.updatePendingUI();
        });
        this.reviewList.appendChild(item);
    });

    // Add a container for the logout confirmation
    const logoutConfirmationContainer = document.createElement('div');
    logoutConfirmationContainer.id = 'logout-confirmation-container';
    logoutConfirmationContainer.style.marginTop = '20px';
    logoutConfirmationContainer.style.padding = '15px';
    logoutConfirmationContainer.style.background = 'var(--box-color)'; // Light green background for confirmation
    logoutConfirmationContainer.style.borderRadius = '10px';
    logoutConfirmationContainer.style.border = '1px solid var(--primary)';
    logoutConfirmationContainer.style.textAlign = 'center';
    logoutConfirmationContainer.style.display = 'none'; // Initially hidden

    const logoutMessage = document.createElement('p');
    logoutMessage.textContent = "您有未同步的資料。點擊下方按鈕將清除這些資料並登出。";
    logoutMessage.style.marginBottom = '15px';
    logoutMessage.style.fontSize = '14px';
    logoutMessage.style.color = 'var(--text)';

    const logoutButton = document.createElement('button');
    logoutButton.textContent = "登出並清除資料";
    logoutButton.className = 'primary-btn'; // Assuming a primary button style exists
    logoutButton.style.padding = '10px 20px';
    logoutButton.style.borderRadius = '5px';
    logoutButton.style.border = 'none';
    logoutButton.style.cursor = 'pointer';
    logoutButton.style.backgroundColor = '#e74c3c'; // Red color for critical action
    logoutButton.style.color = 'white';
    logoutButton.style.fontWeight = 'bold';

    logoutButton.addEventListener('click', () => {
        // Clear pending roll calls and then logout
        this.pendingRollCalls = []; // Clear the array
        this.savePendingRecords(); // Save the cleared state
        this.updatePendingUI(); // Update UI to reflect no pending items
        this.logout(); // Perform the logout
        this.reviewSheet.style.display = 'none'; // Close the review modal
    });

    logoutConfirmationContainer.appendChild(logoutMessage);
    logoutConfirmationContainer.appendChild(logoutButton);
    // Append the logout confirmation container *before* the summary
    this.reviewList.appendChild(logoutConfirmationContainer);
    
    if (this.preseLogoutButton) {
      logoutConfirmationContainer.style.display = 'block';
    } else {
      logoutConfirmationContainer.style.display = 'none';
    }

    this.reviewSummary.innerHTML = `
        <div class="summary-pills">
            <span class="pill">總計: ${this.pendingRollCalls.length}</span>
            <span class="pill ready">就緒: ${readyCount}</span>
            <span class="pill wrong">不符: ${wrongCount}</span>
            <span class="pill unknown">未知: ${unknownCount}</span>
        </div>
    `;
    this.reviewSheet.style.display = 'flex';
  }

  private closeReview() {
    if (this.isMismatchedData && this.pendingRollCalls.length > 0) {
        alert("請先處理舊時段的資料。");
        return;
    }
    this.reviewSheet.style.display = 'none';
    this.preseLogoutButton = false;
  }

  private async syncRecords() {
    if (this.isSyncing || this.pendingRollCalls.length === 0) return;

    const currentBus = this.reviewBusSelect.value;
    const recordsToSync = this.pendingRollCalls.filter(r => this.isBusMatch(r.studentBus, currentBus) && r.name !== "未知標籤");
    
    if (recordsToSync.length === 0) {
        alert(`沒有可同步至 ${currentBus} 的有效記錄。`);
        return;
    }

    this.isSyncing = true;
    this.loadingOverlay.style.display = 'flex';
    const btn = document.getElementById('sync-now-btn') as HTMLButtonElement;
    btn.textContent = "同步中...";
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
            alert("同步完成！");
        } else {
            alert("同步失敗");
        }
    } catch (e) {
        alert("網路錯誤");
    } finally {
        this.isSyncing = false;
        this.loadingOverlay.style.display = 'none';
        btn.textContent = "確認並上傳至伺服器";
        btn.disabled = false;
    }
  }

  private checkBluetoothSupport() {
    if (!navigator.bluetooth) {
        document.getElementById('status-message-ready')!.textContent = "⚠️ 瀏覽器不支援 Web Bluetooth (請使用 Chrome/Edge)";
    }
  }

  private logout() {
    if (this.isConnected) {
        this.bleDevice?.gatt?.disconnect();
    }
    this.authToken = null;
    localStorage.removeItem('userToken');
    localStorage.removeItem('pendingRollCalls');
    this.pendingRollCalls = [];
    this.mainView.style.display = 'none';
    this.loginView.style.display = 'flex';
  }

  private updateDisconnectBtn() {
    const img = document.getElementById('disconnect-img')!;
    if (this.isConnected) {
      img.textContent = 'link_off';
    } else {
      img.textContent = 'logout';
    }
  }
}

// --- Dark mode toggle ---
const themeToggles = document.querySelectorAll('.theme-toggle');
const themeIcons = document.querySelectorAll('.theme-icon');
const root = document.documentElement;

const savedTheme = localStorage.getItem('theme');
if (savedTheme) root.setAttribute('data-theme', savedTheme);

function updateThemeIcons(): void {
    const isDark = root.getAttribute('data-theme') === 'dark' ||
                  (!root.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    themeIcons.forEach(icon => {
        icon.textContent = isDark ? 'brightness_7' : 'moon_stars';
    });
}

updateThemeIcons();

themeToggles.forEach(toggle => {
    toggle.addEventListener('click', () => {
        const current = root.getAttribute('data-theme');
        let next: string;

        if (!current) {
            // If no manual theme, toggle based on system preference
            next = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'light' : 'dark';
        } else {
            next = current === 'dark' ? 'light' : 'dark';
        }

        root.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        updateThemeIcons();
    });
});
new App();
