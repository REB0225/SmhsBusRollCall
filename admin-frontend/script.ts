const BASE_URL: string = localStorage.getItem('apiUrl') || 
                (location.hostname === 'localhost' || location.hostname === '127.0.0.1' ? 'http://localhost:5001' : 'https://bus-rollcall-backend.s211009.workers.dev');

let authToken: string = localStorage.getItem('adminToken') || '';
let adminName: string = localStorage.getItem('adminName') || '管理員';
let adminUsername: string = localStorage.getItem('adminUsername') || '';

interface Account {
    username: string;
    password?: string;
    name: string;
    type: string;
}

interface SlotConfig {
    start: string;
    end: string;
    csvType: string;
    label: string;
    isTemp?: boolean;
    day?: number;
    days?: number[];
}

interface DefaultSlot {
    csvType: string;
    label: string;
}

let accounts: Account[] = [];
let slotConfigs: SlotConfig[] = [];
let defaultSlot: DefaultSlot = { csvType: 'arrival', label: '不在時段內' };
let allPhotos: any[] = [];
let currentPhotoFolder: string | null = null;
let allStudentsList: any[] = [];
let parsedData: { students: string | null, buses: string | null } = { students: null, buses: null };

(document.getElementById('datePicker') as HTMLInputElement).valueAsDate = new Date();

if (authToken) { showDashboard(); }

// --- Dark mode toggle ---
const themeToggle = document.getElementById('themeToggle') as HTMLElement;
const themeImage = document.getElementById('theme-img') as HTMLElement;
const root = document.documentElement;

const savedTheme = localStorage.getItem('theme');
if (savedTheme) root.setAttribute('data-theme', savedTheme);

function updateThemeIcon(): void {
    if (!themeImage) return;
    const isDark = root.getAttribute('data-theme') === 'dark' || 
                  (!root.getAttribute('data-theme') && window.matchMedia('(prefers-color-scheme: dark)').matches);
    themeImage.textContent = isDark ? 'brightness_7' : 'moon_stars';
}

if (themeToggle) {
    updateThemeIcon();

    themeToggle.addEventListener('click', () => {
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
        updateThemeIcon();
    });
}

async function downloadListCSV(type: 'students' | 'buses', csvTypeParam?: string): Promise<void> {
    const csvType = csvTypeParam || (document.getElementById(`${type === 'students' ? 'student' : 'bus'}-list-type`) as HTMLSelectElement).value;
    const url = `${BASE_URL}/api/admin/config/${type}/csv?csvType=${encodeURIComponent(csvType)}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${authToken}` } });
    if (res.ok) {
        const blob = await res.blob();
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `${type}-${csvType}.csv`; a.click();
    } else { alert('下載失敗'); }
}

function toggleDaysDropdown(e: Event): void {
    e.stopPropagation();
    const dropdown = document.getElementById('days-dropdown') as HTMLElement;
    dropdown.style.display = dropdown.style.display === 'none' ? 'block' : 'none';
}

// Close dropdown when clicking outside
document.addEventListener('click', (e) => {
    const dropdown = document.getElementById('days-dropdown') as HTMLElement;
    if (dropdown && !dropdown.contains(e.target as Node) && !(e.target as HTMLElement).closest('button[onclick="toggleDaysDropdown(event)"]')) {
        dropdown.style.display = 'none';
    }
});

document.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.delete-btn') as HTMLElement;
    if (!btn) return;
    const index = parseInt(btn.dataset.index!);
    if (isNaN(index)) return;
    const type = btn.dataset.type;
    if (type === 'account') {
        accounts.splice(index, 1);
        renderAccounts();
    } else {
        slotConfigs.splice(index, 1);
        renderSlots();
    }
});

function openSettings(): void {
    (document.getElementById('settingsModal') as HTMLElement).style.display = 'flex';
    (document.getElementById('apiUrlInput') as HTMLInputElement).value = BASE_URL;
}

function saveSettings(): void {
    const url = (document.getElementById('apiUrlInput') as HTMLInputElement).value.trim();
    if (url) { localStorage.setItem('apiUrl', url); location.reload(); }
}

async function testConnection(): Promise<void> {
    const url = (document.getElementById('apiUrlInput') as HTMLInputElement).value.trim() || BASE_URL;
    const status = document.getElementById('testStatus') as HTMLElement;
    status.textContent = '測試中...';
    try {
        const res = await fetch(`${url}/api/buses`, { 
            headers: { 'Authorization': `Bearer ${authToken || ''}` }
        });
        if (res.status === 401 || res.ok) { 
            status.textContent = '連接成功！'; 
            status.className = 'status-msg success'; 
        } else { 
            status.textContent = '連接失敗'; 
            status.className = 'status-msg error'; 
        }
    } catch (err) { 
        status.textContent = '網路錯誤'; 
        status.className = 'status-msg error'; 
    }
}

async function login(): Promise<void> {
    const user = (document.getElementById('username') as HTMLInputElement).value;
    const pass = (document.getElementById('password') as HTMLInputElement).value;
    const btn = document.getElementById('loginBtn') as HTMLButtonElement;
    const error = document.getElementById('loginError') as HTMLElement;
    if (!user || !pass) return;
    btn.disabled = true;
    try {
        const res = await fetch(`${BASE_URL}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: user, password: pass })
        });
        const data = await res.json();
        if (res.ok) {
            if (data.user.type !== 'admin') {
                error.textContent = '權限不足：僅限管理員登入';
                btn.disabled = false;
                return;
            }
            localStorage.setItem('adminToken', data.token);
            localStorage.setItem('adminName', data.user.name);
            localStorage.setItem('adminUsername', user);
            authToken = data.token;
            adminName = data.user.name;
            adminUsername = user;
            showDashboard();
        } else { error.textContent = data.error || '登入失敗'; }
    } catch (err) { error.textContent = '網路錯誤'; }
    finally { btn.disabled = false; }
}

function logout(): void { localStorage.removeItem('adminToken'); location.reload(); }

function showDashboard(): void {
    (document.getElementById('loginSection') as HTMLElement).style.display = 'none';
    (document.getElementById('dashboardSection') as HTMLElement).style.display = 'block';
    (document.getElementById('welcomeText') as HTMLElement).textContent = `您好，${adminName}`;
    (document.getElementById('placeholder-img') as HTMLImageElement).src = `${BASE_URL}/api/placeholder?t=${Date.now()}`;
    updateCurrentSlotDisplay();
    fetchAccounts();
    fetchSlots();
    fetchPhotos();
    fetchGlobalStudents();
}

async function updateCurrentSlotDisplay(): Promise<void> {
    try {
        const res = await fetch(`${BASE_URL}/api/current-slot`, {
            headers: { 'Authorization': `Bearer ${authToken}` }
        });
        if (res.ok) {
            const data = await res.json();
            (document.getElementById('current-slot-display') as HTMLElement).textContent = data.slot;
        }
    } catch (err) { console.error(err); }
}

async function uploadSystemPlaceholder(): Promise<void> {
    const fileInput = document.getElementById('placeholder-file') as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return alert('請選擇檔案');
    const reader = new FileReader();
    reader.onload = async () => {
        const photo = (reader.result as string).split(',')[1];
        const res = await fetch(`${BASE_URL}/api/admin/config/placeholder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ photo })
        });
        if (res.ok) { 
            alert('系統預設相片更新成功'); 
            (document.getElementById('placeholder-img') as HTMLImageElement).src = `${BASE_URL}/api/placeholder?t=${Date.now()}`;
        } else {
            alert('更新失敗');
        }
    };
    reader.readAsDataURL(file);
}

function switchTab(tabName: string): void {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    
    const tabs = document.querySelectorAll('.tab');
    tabs.forEach(t => { if((t as HTMLElement).getAttribute('onclick')?.includes(`'${tabName}'`)) t.classList.add('active'); });
    
    const targetContent = document.getElementById(`${tabName}Tab`);
    if(!targetContent) {
        const tempContent = document.getElementById(`${tabName}-ridersTab`);
        if(tempContent) tempContent.classList.add('active');
    } else {
        targetContent.classList.add('active');
    }

    if (tabName === 'temp-riders') { fetchTempRiders(); fetchBusesForTemp(); }
    if (tabName === 'photos') { fetchPhotos(); }
    if (tabName === 'config') { fetchAccounts(); fetchSlots(); }
}

async function fetchAccounts(): Promise<void> {
    try {
        const res = await fetch(`${BASE_URL}/api/admin/accounts`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) { accounts = await res.json(); renderAccounts(); }
    } catch (err) { console.error(err); }
}

function updateAccount(index: number, field: string, value: string): void {
    if (accounts[index]) {
        (accounts[index] as any)[field] = value;
    }
}

function renderAccounts(): void {
    const body = document.getElementById('accounts-body') as HTMLElement;
    body.innerHTML = '';
    accounts.forEach((acc, index) => {
        const tr = document.createElement('tr');
        const isSelf = acc.username === adminUsername;
        tr.innerHTML = `
            <td>${acc.username} ${isSelf ? '<span class="badge badge-user" style="font-size: 10px;">(您)</span>' : ''}</td>
            <td>•••••••• <button class="text-btn" onclick="resetPassword(${index})">重設</button></td>
            <td><input type="text" value="${acc.name}" onchange="updateAccount(${index}, 'name', this.value)" class="table-input"></td>
            <td>
                <select onchange="updateAccount(${index}, 'type', this.value)" class="table-input" ${isSelf ? 'disabled' : ''}>
                    <option value="user" ${acc.type==='user'?'selected':''}>使用者</option>
                    <option value="admin" ${acc.type==='admin'?'selected':''}>管理員</option>
                </select>
            </td>
            <td>
                ${isSelf ? '' : `<button class="delete-btn" data-index="${index}" data-type="account">刪除</button>`}
            </td>
        `;
        body.appendChild(tr);
    });
}

function addAccount(): void {
    const u = (document.getElementById('new-account-username') as HTMLInputElement).value.trim();
    const p = (document.getElementById('new-account-password') as HTMLInputElement).value.trim();
    const n = (document.getElementById('new-account-name') as HTMLInputElement).value.trim();
    const t = (document.getElementById('new-account-type') as HTMLSelectElement).value;
    if(!u || !p || !n) return alert('請填寫所有欄位');
    accounts.push({ username: u, password: p, name: n, type: t });
    renderAccounts();
    (document.getElementById('new-account-username') as HTMLInputElement).value = '';
    (document.getElementById('new-account-password') as HTMLInputElement).value = '';
    (document.getElementById('new-account-name') as HTMLInputElement).value = '';
}

function resetPassword(index: number): void {
    const p = prompt(`請輸入 ${accounts[index].username} 的新密碼:`);
    if (p) { accounts[index].password = p; alert('密碼已修改，請記得儲存變更。'); }
}

async function saveAccounts(): Promise<void> {
    const status = document.getElementById('status-accounts') as HTMLElement;
    const btn = document.getElementById('save-accounts-btn') as HTMLButtonElement;
    btn.disabled = true;
    status.textContent = '儲存中...';
    try {
        const res = await fetch(`${BASE_URL}/api/admin/config/accounts`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${authToken}`,
                'X-Admin-Username': adminUsername
            },
            body: JSON.stringify(accounts)
        });
        if (res.ok) { 
            status.textContent = '帳號已成功更新！'; 
            status.className = 'status-msg success'; 
            alert('帳號已成功更新！');
        } else {
            status.textContent = '儲存失敗';
            status.className = 'status-msg error';
            alert('儲存失敗');
        }
    } catch (err) { 
        status.textContent = '網路錯誤'; 
        status.className = 'status-msg error'; 
        alert('網路錯誤');
    } finally {
        btn.disabled = false;
    }
}

async function fetchSlots(): Promise<void> {
    try {
        const res = await fetch(`${BASE_URL}/api/admin/config/slots`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) {
            const data = await res.json();
            slotConfigs = data.slots || [];
            defaultSlot = data.default || defaultSlot;
            (document.getElementById('default-slot-csv') as HTMLInputElement).value = defaultSlot.csvType;
            (document.getElementById('default-slot-label') as HTMLInputElement).value = defaultSlot.label;
            renderSlots();
            updateSlotSelectors();
        }
    } catch (err) { console.error(err); }
}

function updateSlotSelectors(): void {
    const exportSelect = document.getElementById('slotPicker') as HTMLSelectElement;
    const tempSelect = document.getElementById('temp-slot') as HTMLSelectElement;
    
    const uniqueSlots = new Set();
    slotConfigs.forEach(s => {
        uniqueSlots.add(`${s.start}-${s.end}`);
    });
    uniqueSlots.add(defaultSlot.label);

    const options = Array.from(uniqueSlots).map((s: any) => {
        const label = slotConfigs.find(sc => `${sc.start}-${sc.end}` === s)?.label || s;
        return { value: s, label: label === s ? s : `${label} (${s})` };
    });

    if (exportSelect) {
        exportSelect.innerHTML = '';
        options.forEach((opt: any) => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            exportSelect.appendChild(o);
        });
    }

    if (tempSelect) {
        tempSelect.innerHTML = '';
        options.forEach((opt: any) => {
            const o = document.createElement('option');
            o.value = opt.value;
            o.textContent = opt.label;
            tempSelect.appendChild(o);
        });
    }
}

function renderSlots(): void {
    const body = document.getElementById('slots-body') as HTMLElement;
    const days = ['日', '一', '二', '三', '四', '五', '六'];
    body.innerHTML = '';
    slotConfigs.forEach((s, i) => {
        let dText = '每天';
        if (s.day !== undefined) dText = `週${days[s.day]}`;
        else if (s.days) dText = s.days.map(d => days[d]).join(',');
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${dText}</td><td>${s.start}</td><td>${s.end}</td><td>${CSV_TYPE_MAP[s.csvType] || s.csvType}</td><td>${s.label}</td><td>${s.isTemp?'臨時':'永久'}</td><td><button class="delete-btn" data-index="${i}">刪除</button></td>`;
        body.appendChild(tr);
    });
}

function addSlot(): void {
    const checkedDays = Array.from(document.querySelectorAll('input[name="slot-day"]:checked')).map((el: any) => parseInt(el.value));
    const s = (document.getElementById('new-slot-start') as HTMLInputElement).value.trim();
    const e = (document.getElementById('new-slot-end') as HTMLInputElement).value.trim();
    const csv = (document.getElementById('new-slot-csv') as HTMLInputElement).value;
    const l = (document.getElementById('new-slot-label') as HTMLInputElement).value.trim();
    const t = (document.getElementById('new-slot-type') as HTMLSelectElement).value;
    if(!s || !e || !l) return alert('請填寫完整');
    const ns: SlotConfig = { start: s, end: e, csvType: csv, label: l, isTemp: t === 'temp' };
    
    if (checkedDays.length > 0) {
        if (checkedDays.length === 1) ns.day = checkedDays[0];
        else ns.days = checkedDays;
    }
    
    slotConfigs.push(ns);
    renderSlots();
    // Uncheck boxes after adding
    document.querySelectorAll('input[name="slot-day"]').forEach((el: any) => el.checked = false);
}

async function saveSlots(): Promise<void> {
    const status = document.getElementById('status-slots') as HTMLElement;
    const btn = document.getElementById('save-slots-btn') as HTMLButtonElement;
    btn.disabled = true;
    status.textContent = '儲存中...';
    try {
        const res = await fetch(`${BASE_URL}/api/admin/config/slots`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify({ slots: slotConfigs, default: defaultSlot })
        });
        if (res.ok) { 
            status.textContent = '配置已成功儲存至資料庫！'; 
            status.className = 'status-msg success'; 
            alert('配置已成功儲存！');
        } else {
            status.textContent = '儲存失敗';
            status.className = 'status-msg error';
            alert('儲存失敗');
        }
    } catch (err) { 
        status.textContent = '網路錯誤'; 
        status.className = 'status-msg error'; 
        alert('網路錯誤');
    } finally {
        btn.disabled = false;
    }
}

function updateDefaultSlot(): void {
    defaultSlot.csvType = (document.getElementById('default-slot-csv') as HTMLInputElement).value;
    defaultSlot.label = (document.getElementById('default-slot-label') as HTMLInputElement).value;
}

function resetToDefaults(): void {
    if (confirm('確定要重設嗎？')) {
        slotConfigs = [
            { start: "07:00", end: "09:00", csvType: "arrival", label: "早上" },
            { day: 5, start: "16:00", end: "18:00", csvType: "full_departure", label: "週五下午" },
            { days: [1, 2, 3, 4], start: "16:00", end: "18:00", csvType: "night_class_afternoon", label: "週一至四下午" },
            { days: [1, 2, 3, 4], start: "19:00", end: "21:00", csvType: "night_class_night", label: "週一至四晚上" }
        ];
        renderSlots();
    }
}

async function openPhotoFolder(cls: string): Promise<void> {
    currentPhotoFolder = cls;
    const grid = document.getElementById('photo-grid') as HTMLElement;

    if (allPhotos.length === 0) {
        grid.innerHTML = '<div class="spinner"></div>'; // Show spinner while fetching
        try {
            const res = await fetch(`${BASE_URL}/api/admin/photos`, { headers: { 'Authorization': `Bearer ${authToken}` } });
            if (res.ok) {
                allPhotos = await res.json();
                renderPhotos(allPhotos); // renderPhotos will filter by currentPhotoFolder
            } else {
                grid.innerHTML = '載入照片失敗';
            }
        } catch (err) {
            grid.innerHTML = '網路錯誤';
            console.error(err);
        }
    } else {
        // If photos are already loaded, just re-render with the new folder context
        renderPhotos(allPhotos);
    }
}

function closePhotoFolder(): void {
    currentPhotoFolder = null;
    renderPhotos(allPhotos);
}

async function fetchPhotos(): Promise<void> {
    const grid = document.getElementById('photo-grid') as HTMLElement;
    grid.innerHTML = '<div class="spinner"></div>';
    try {
        const res = await fetch(`${BASE_URL}/api/admin/photos`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) { allPhotos = await res.json(); renderPhotos(allPhotos); }
    } catch (err) { grid.innerHTML = '載入失敗'; }
}

function renderPhotos(photos: any[]): void {
    const grid = document.getElementById('photo-grid') as HTMLElement;
    grid.innerHTML = '';
    
    if (currentPhotoFolder === null) {
        const grouped: any = {};
        photos.forEach(p => {
            const cls = p.class || '未分班';
            if (!grouped[cls]) grouped[cls] = [];
            grouped[cls].push(p);
        });

        const classes = Object.keys(grouped).sort();
        classes.forEach(cls => {
            const folder = document.createElement('div');
            folder.className = 'photo-card';
            folder.innerHTML = `
                <div class="photo-card-actions">
                    <button class="photo-action-btn delete" title="批量刪除此目錄所有相片" onclick="window.deleteFolderPhotos('${cls}')">✕</button>
                </div>
                <div id="class-img" class="photo-card-img" style="flex-direction: column; gap: 10px; cursor: pointer;" onclick="window.openPhotoFolder('${cls}')">
                    <svg width="60" height="60" viewBox="0 0 24 24" fill="#1976d2"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                    <span style="font-weight: 600; color: #1976d2;">${cls}</span>
                </div>
                <div class="photo-card-info" style="text-align: center;">
                    <div class="photo-card-name">${grouped[cls].length} 張相片</div>
                </div>
            `;
            grid.appendChild(folder);
        });
    } else {
        const classPhotos = photos.filter(p => (p.class || '未分班') === currentPhotoFolder);
        
        const header = document.createElement('div');
        header.style.gridColumn = '1 / -1';
        header.style.display = 'flex';
        header.style.justifyContent = 'space-between';
        header.style.alignItems = 'center';
        header.style.marginBottom = '15px';
        header.style.background = '#f5f5f7';
        header.style.padding = '10px 15px';
        header.style.borderRadius = '10px';
        header.innerHTML = `
            <div style="display: flex; align-items: center; gap: 15px;">
                <button class="secondary-btn" style="width: auto; margin: 0; padding: 5px 10px;" onclick="closePhotoFolder()">← 返回</button>
                <h2 style="font-size: 16px; color: var(--text); margin: 0;">目錄: ${currentPhotoFolder} (${classPhotos.length})</h2>
            </div>
            <button class="delete-btn" style="font-weight: 600; font-size: 12px;" onclick="deleteFolderPhotos('${currentPhotoFolder}')">批量刪除此目錄相片</button>
        `;
        grid.appendChild(header);

        classPhotos.forEach(p => {
            const url = `${BASE_URL}/api/photo/${p.uid}?token=${authToken}&t=${Date.now()}`;
            const safeName = p.name.replace(/'/g, "\\'");
            const div = document.createElement('div');
            div.className = 'photo-card';
            div.innerHTML = `
                <div class="photo-card-actions">
                    <button class="photo-action-btn" title="更換相片" onclick="window.modifyPhoto('${p.uid}')">✎</button>
                    <button class="photo-action-btn delete" title="刪除相片" onclick="window.deletePhoto('${p.uid}','${safeName}')">✕</button>
                </div>
                <div class="photo-card-img" onclick="window.open('${url}','_blank')">
                    <img loading="lazy" src="${url}" onload="this.style.opacity=1" style="opacity: 0; transition: opacity 0.5s;" onerror="this.src='${BASE_URL}/api/placeholder'">
                </div>
                <div class="photo-card-info">
                    <div class="photo-card-name">${p.name}</div>
                    <div class="photo-card-uid">${p.uid}</div>
                    <div style="font-size: 10px; color: var(--primary); margin-top: 2px;">學號: ${p.badge || '---'}</div>
                </div>
            `;
            grid.appendChild(div);
        });
    }
}

function filterPhotos(): void {
    const q = (document.getElementById('photo-search') as HTMLInputElement).value.toLowerCase();
    renderPhotos(allPhotos.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.uid.includes(q) ||
        (p.badge && p.badge.includes(q)) ||
        (p.class && p.class.toLowerCase().includes(q))
    ));
}

function modifyPhoto(uid: string): void {
    const uidInput = document.getElementById('photo-upload-uid') as HTMLInputElement;
    if (uidInput) {
        uidInput.value = uid;
        uidInput.focus();
        uidInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

async function deletePhoto(uid: string, name: string): Promise<void> {    if (confirm(`確定要刪除 ${name} 的相片嗎？`)) {
        const res = await fetch(`${BASE_URL}/api/admin/student/photo/${uid}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) { 
            allPhotos = allPhotos.filter(p => p.uid !== uid); 
            filterPhotos();
        }
    }
}

async function deleteFolderPhotos(className: string): Promise<void> {
    if (confirm(`⚠️ 警告：確定要刪除「${className}」目錄下的所有相片嗎？此動作無法復原。`)) {
        try {
            const res = await fetch(`${BASE_URL}/api/admin/class/photos/${encodeURIComponent(className)}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${authToken}` }
            });
            if (res.ok) {
                alert('已刪除該目錄下的所有相片。');
                fetchPhotos();
            } else { alert('刪除失敗'); }
        } catch (err) { alert('網路錯誤'); }
    }
}

async function uploadStudentPhoto(): Promise<void> {
    const uid = (document.getElementById('photo-upload-uid') as HTMLInputElement).value.trim();
    const fileInput = document.getElementById('photo-upload-file') as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!uid || !file) return alert('請輸入 UID 並選擇檔案');
    const photo = await compressPhoto(file);
    const res = await fetch(`${BASE_URL}/api/admin/student/photo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ uid, photo })
    });
    if (res.ok) { alert('上傳成功'); fetchPhotos(); }
}

function compressPhoto(file: File, maxW = 600, maxH = 800): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = reject;
        reader.onload = () => {
            const img = new Image();
            img.onerror = reject;
            img.onload = () => {
                // Scale down keeping aspect ratio, only if larger than target
                let { width, height } = img;
                const scale = Math.min(maxW / width, maxH / height, 1);
                width = Math.round(width * scale);
                height = Math.round(height * scale);

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d')!.drawImage(img, 0, 0, width, height);
                // base64 without the data:image/jpeg;base64, prefix
                resolve(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
            };
            img.src = reader.result as string;
        };
        reader.readAsDataURL(file);
    });
}

async function uploadBulkPhotos(): Promise<void> {
    const fileInput = document.getElementById('photo-bulk-input') as HTMLInputElement;
    const files = fileInput.files;
    const status = document.getElementById('bulk-upload-status') as HTMLElement;
    if (!files || !files.length) return;
    status.textContent = `處理中... (0/${files.length})`;
    let count = 0;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const filenameWithoutExt = f.name.split('.')[0];
        const badge = filenameWithoutExt;
        const student = allStudentsList.find(s => s.badge === badge);
        if (student) {
            const base64 = await compressPhoto(f);
            await fetch(`${BASE_URL}/api/admin/student/photo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
                body: JSON.stringify({ uid: student.uid, photo: base64 })
            });
            count++;
        }
        status.textContent = `進度... (${count}/${files.length})`;
    }
    status.textContent = `上傳完成！共成功上傳 ${count} 張相片。`;
    fetchPhotos();
}

async function fetchGlobalStudents(): Promise<void> {
    try {
        const res = await fetch(`${BASE_URL}/api/students`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) allStudentsList = Object.values(await res.json());
    } catch (err) {}
}

async function fetchTempRiders(): Promise<void> {
    try {
        const res = await fetch(`${BASE_URL}/api/admin/temporary-riders`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) renderTempRiders(await res.json());
    } catch (err) {}
}

function renderTempRiders(riders: any[]): void {
    const body = document.getElementById('temp-riders-body') as HTMLElement;
    body.innerHTML = '';
    const now = new Date();
    const taipei = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    taipei.setHours(0,0,0,0);
    const cutoff = new Date(taipei);
    cutoff.setDate(cutoff.getDate() - 1);

    riders.filter(r => new Date(r.date) >= cutoff).sort((a,b) => b.date.localeCompare(a.date)).forEach(r => {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${r.date}</td><td>${r.timeSlot}</td><td>${r.bus}</td><td>${r.name}</td><td>${r.class||'---'}</td><td>${r.badge||'---'}</td><td>${r.uid}</td><td><button class="delete-btn" onclick="deleteTempRider('${r.id}')">刪除</button></td>`;
        body.appendChild(tr);
    });
}

async function deleteTempRider(id: string): Promise<void> {
    if (confirm('確定要刪除嗎？')) {
        await fetch(`${BASE_URL}/api/admin/temporary-riders/${id}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${authToken}` } });
        fetchTempRiders();
    }
}

async function addTemporaryRider(): Promise<void> {
    const date = (document.getElementById('temp-date') as HTMLInputElement).value;
    const slot = (document.getElementById('temp-slot') as HTMLSelectElement).value;
    const bus = (document.getElementById('temp-bus') as HTMLSelectElement).value;
    const uid = (document.getElementById('temp-uid') as HTMLInputElement).value.trim();
    const name = (document.getElementById('temp-name') as HTMLInputElement).value.trim();
    const badge = (document.getElementById('temp-badge') as HTMLInputElement).value.trim();
    const studentClass = (document.getElementById('temp-class') as HTMLInputElement).value.trim();
    if (!date || !slot || !bus || !uid || !name) return alert('請填寫所有必填欄位');
    const res = await fetch(`${BASE_URL}/api/admin/temporary-riders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
        body: JSON.stringify({ date, timeSlot: slot, bus, uid, name, badge, class: studentClass })
    });
    if (res.ok) { 
        alert('指派成功');
        fetchTempRiders(); 
        (document.getElementById('temp-uid') as HTMLInputElement).value = ''; 
        (document.getElementById('temp-name') as HTMLInputElement).value = ''; 
        (document.getElementById('temp-badge') as HTMLInputElement).value = '';
        (document.getElementById('temp-class') as HTMLInputElement).value = '';
    } else {
        alert('指派失敗');
    }
}

async function fetchBusesForTemp(): Promise<void> {
    const res = await fetch(`${BASE_URL}/api/buses`, { headers: { 'Authorization': `Bearer ${authToken}` } });
    const buses = await res.json();
    const bSelect = document.getElementById('temp-bus') as HTMLSelectElement;
    bSelect.innerHTML = '<option value="">請選擇車次</option>';
    buses.forEach((b: any) => { const name = typeof b === 'string' ? b : b.name; const opt = document.createElement('option'); opt.value = name; opt.textContent = name; bSelect.appendChild(opt); });
}

async function lookupStudent(): Promise<void> {
    const uid = (document.getElementById('temp-uid') as HTMLInputElement).value.trim();
    const info = document.getElementById('temp-student-info') as HTMLElement;
    if (!uid) return;
    try {
        const res = await fetch(`${BASE_URL}/api/student/${uid}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
        if (res.ok) {
            const s = await res.json();
            info.textContent = `✅ 找到學生: ${s.name}`;
            (document.getElementById('temp-name') as HTMLInputElement).value = s.name;
            (document.getElementById('temp-badge') as HTMLInputElement).value = s.badge || '';
            (document.getElementById('temp-class') as HTMLInputElement).value = s.class || '';
        } else { info.textContent = 'ℹ️ 新學生'; }
    } catch (err) {}
}

async function updateOccupancy(): Promise<void> {
    const date = (document.getElementById('temp-date') as HTMLInputElement).value;
    const slot = (document.getElementById('temp-slot') as HTMLSelectElement).value;
    const bus = (document.getElementById('temp-bus') as HTMLSelectElement).value;
    if (!date || !slot || !bus) return;
    const res = await fetch(`${BASE_URL}/api/admin/bus-occupancy?date=${date}&timeSlot=${encodeURIComponent(slot)}&bus=${encodeURIComponent(bus)}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
    if (res.ok) {
        const data = await res.json();
        const box = document.getElementById('occupancy-info') as HTMLElement;
        box.style.display = 'block';
        (document.getElementById('occupancy-count') as HTMLElement).textContent = `${data.count} / ${data.overflowLimit}`;
    }
}

async function previewCSV(type: 'students' | 'buses'): Promise<void> {
    const fileInput = document.getElementById(`file-${type}`) as HTMLInputElement;
    const file = fileInput.files?.[0];
    if (!file) return;
    const encoding = (document.getElementById(`encoding-${type}`) as HTMLSelectElement).value;
    const reader = new FileReader();
    reader.onload = (e) => {
        const preview = document.getElementById(`preview-${type}`) as HTMLElement;
        preview.style.display = 'block';
        preview.textContent = (e.target?.result as string).split('\n').slice(0, 5).join('\n');
        (document.getElementById(`upload-${type}`) as HTMLButtonElement).disabled = false;
        parsedData[type] = e.target?.result as string;
    };
    reader.readAsText(file, encoding);
}

const CSV_TYPE_MAP: Record<string, string> = {
    'arrival': '早上',
    'full_departure': '大放學',
    'night_class_afternoon': '夜輔下午放學',
    'night_class_night': '夜輔晚上放學'
};

function resetStudentPreview(): void {
    const fileInput = document.getElementById('file-students') as HTMLInputElement;
    fileInput.value = '';
    const preview = document.getElementById('preview-students') as HTMLElement;
    preview.style.display = 'none';
    preview.textContent = '';
    (document.getElementById('upload-students') as HTMLButtonElement).disabled = true;
    parsedData.students = null;
}

function resetBusPreview(): void {
    const fileInput = document.getElementById('file-buses') as HTMLInputElement;
    fileInput.value = '';
    const preview = document.getElementById('preview-buses') as HTMLElement;
    preview.style.display = 'none';
    preview.textContent = '';
    (document.getElementById('upload-buses') as HTMLButtonElement).disabled = true;
    parsedData.buses = null;
}

async function uploadConfig(type: 'students' | 'buses'): Promise<void> {
    const raw = parsedData[type];
    if (!raw) return;
    const lines = raw.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim().replace(/^\ufeff/, ''));

    if (type === 'students') {
        const required = ['uid', 'name', 'badge', 'class', 'bus'];
        const missing = required.filter(h => !headers.includes(h));
        if (missing.length > 0) {
            alert(`學生 CSV 格式錯誤。缺少必要欄位: ${missing.join(', ')}\n請確保第一行包含: uid, name, badge, class, bus`);
            return;
        }
    } else if (type === 'buses') {
        const required = ['bus', 'overflow'];
        const missing = required.filter(h => !headers.includes(h));
        if (missing.length > 0) {
            alert(`車次 CSV 格式錯誤。缺少必要欄位: ${missing.join(', ')}\n請確保第一行包含: bus, overflow`);
            return;
        }
    }

    const rows = lines.slice(1).map(l => {
        const values = l.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
        let obj: any = {}; headers.forEach((h, i) => obj[h] = values[i]);
        return obj;
    });
    const csvType = (document.getElementById(`${type === 'students' ? 'student' : 'bus'}-list-type`) as HTMLSelectElement).value;
    const payload = type === 'students' ? { students: rows, csvType } : { buses: rows.map(r => ({ name: r.bus, overflow: parseInt(r.overflow) || 40 })), csvType };
    
    const btn = document.getElementById(`upload-${type}`) as HTMLButtonElement;
    btn.disabled = true;
    try {
        const res = await fetch(`${BASE_URL}/api/admin/config/${type}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
            body: JSON.stringify(payload)
        });
        if (res.ok) { alert('上傳成功'); location.reload(); }
        else { const data = await res.json(); alert(`上傳失敗: ${data.error || '未知錯誤'}`); }
    } catch (err) { alert('上傳失敗'); }
    finally { btn.disabled = false; }
}

async function downloadCSV(): Promise<void> {
    const d = (document.getElementById('datePicker') as HTMLInputElement).value;
    const s = (document.getElementById('slotPicker') as HTMLSelectElement).value;
    if (!d) return alert('請選擇日期');
    const url = `${BASE_URL}/api/admin/rollcall-csv?date=${d}&timeSlot=${encodeURIComponent(s)}`;
    const res = await fetch(url, { headers: { 'Authorization': `Bearer ${authToken}` } });
    if (res.ok) {
        const blob = await res.blob();
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
        a.download = `roll-call-${d}-${s}.csv`; a.click();
    } else { alert('無此時段記錄'); }
}

async function downloadWeekCSV(): Promise<void> {
    const dInput = (document.getElementById('datePicker') as HTMLInputElement).value;
    if (!dInput) return alert('請選擇日期');
    const date = new Date(dInput);
    const day = date.getDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const mon = new Date(date); mon.setDate(date.getDate() + diff);
    const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
    const res = await fetch(`${BASE_URL}/api/admin/rollcall-week?startDate=${mon.toISOString().split('T')[0]}&endDate=${fri.toISOString().split('T')[0]}`, { headers: { 'Authorization': `Bearer ${authToken}` } });
    if (res.ok) {
        const data = await res.json();
        for (const name in data.files) {
            const blob = new Blob([data.files[name]], { type: 'text/csv;charset=utf-8;' });
            const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
            a.download = name; a.click();
            await new Promise(r => setTimeout(r, 300));
        }
    } else { alert('下載失敗'); }
}

// Expose functions to window for inline onclick handlers
(window as any).toggleDaysDropdown = toggleDaysDropdown;
(window as any).downloadListCSV = downloadListCSV;
(window as any).openSettings = openSettings;
(window as any).saveSettings = saveSettings;
(window as any).testConnection = testConnection;
(window as any).login = login;
(window as any).logout = logout;
(window as any).showDashboard = showDashboard;
(window as any).uploadSystemPlaceholder = uploadSystemPlaceholder;
(window as any).switchTab = switchTab;
(window as any).renderAccounts = renderAccounts;
(window as any).updateAccount = updateAccount;
(window as any).addAccount = addAccount;
(window as any).resetPassword = resetPassword;
(window as any).saveAccounts = saveAccounts;
(window as any).renderSlots = renderSlots;
(window as any).addSlot = addSlot;
(window as any).saveSlots = saveSlots;
(window as any).updateDefaultSlot = updateDefaultSlot;
(window as any).resetToDefaults = resetToDefaults;
(window as any).openPhotoFolder = openPhotoFolder;
(window as any).closePhotoFolder = closePhotoFolder;
(window as any).fetchPhotos = fetchPhotos;
(window as any).renderPhotos = renderPhotos;
(window as any).filterPhotos = filterPhotos;
(window as any).modifyPhoto = modifyPhoto;
(window as any).deletePhoto = deletePhoto;
(window as any).deleteFolderPhotos = deleteFolderPhotos;
(window as any).uploadStudentPhoto = uploadStudentPhoto;
(window as any).uploadBulkPhotos = uploadBulkPhotos;
(window as any).fetchTempRiders = fetchTempRiders;
(window as any).deleteTempRider = deleteTempRider;
(window as any).addTemporaryRider = addTemporaryRider;
(window as any).fetchBusesForTemp = fetchBusesForTemp;
(window as any).lookupStudent = lookupStudent;
(window as any).updateOccupancy = updateOccupancy;
(window as any).previewCSV = previewCSV;
(window as any).uploadConfig = uploadConfig;
(window as any).downloadCSV = downloadCSV;
(window as any).downloadWeekCSV = downloadWeekCSV;