import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import { parse } from 'csv-parse/sync';
import path from 'path';
import { fileURLToPath } from 'url';
import admin from 'firebase-admin';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 5001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Firebase Initialization
const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, 'serviceAccountKey.json');
let firestore: admin.firestore.Firestore | null = null;
let serviceAccount: any = null;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (err) { console.error('[Error] Failed to parse FIREBASE_SERVICE_ACCOUNT env var'); }
} else if (fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    try {
        serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));
    } catch (err) { console.error('[Error] Failed to read serviceAccountKey.json'); }
}

if (serviceAccount) {
    try {
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
        firestore = admin.firestore();
        console.log('[Database] Firestore initialized successfully.');
    } catch (err) {
        console.error('[Error] Failed to initialize Firestore:', err);
    }
} else {
    console.log('[Database] No credentials found. Falling back to Local Mode.');
}

// Simple Auth Middleware
const ADMIN_TOKEN = "secret-bus-admin-2026";
const USER_TOKEN = "secret-bus-token-2026";

const authorize = (req: Request, res: Response, next: Function) => {
  const authHeader = req.headers['authorization'];
  const queryToken = req.query.token as string;
  const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.substring(7) : queryToken;
  
  if (token === ADMIN_TOKEN || token === USER_TOKEN) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
};

const authorizeAdmin = (req: Request, res: Response, next: Function) => {
  const authHeader = req.headers['authorization'];
  const queryToken = req.query.token as string;
  const token = (authHeader && authHeader.startsWith('Bearer ')) ? authHeader.substring(7) : queryToken;
  
  if (token === ADMIN_TOKEN) {
    next();
  } else {
    res.status(403).json({ error: "Forbidden: Admin access required" });
  }
};

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

interface Student {
  uid: string;
  name: string;
  badge: string;
  class?: string;
  bus?: string;
  listType?: string;
  photo?: string;
}

interface SlotMapping {
    day?: number;
    days?: number[];
    start: string;
    end: string;
    csvType: string;
    label: string;
    isTemp?: boolean;
}

// Configuration State
let slotConfigs: SlotMapping[] = [
    { start: "07:00", end: "09:00", csvType: "arrival", label: "早上" },
    { day: 5, start: "16:00", end: "18:00", csvType: "full_departure", label: "週五下午" },
    { days: [1, 2, 3, 4], start: "16:00", end: "18:00", csvType: "night_class_afternoon", label: "週一至四下午" },
    { days: [1, 2, 3, 4], start: "19:00", end: "21:00", csvType: "night_class_night", label: "週一至四晚上" }
];
let defaultSlot: Omit<SlotMapping, 'start' | 'end'> = { csvType: "arrival", label: "不在時段內" };

const SLOT_CONFIG_PATH = path.resolve(__dirname, 'slot-configs.json');

const saveSlotConfigs = async () => {
    console.log('[System] Saving slot configs to Firestore and Local...');
    if (firestore) {
        try {
            await firestore.collection('config').doc('slots').set({ 
                slots: slotConfigs, 
                default: defaultSlot,
                updatedAt: new Date().toISOString()
            });
            console.log('[System] Firestore save successful');
        } catch (err) { 
            console.error('[Error] Firestore save failed', err);
            // Don't throw if we want to still try local save, or throw to notify caller
        }
    }
    try {
        fs.writeFileSync(SLOT_CONFIG_PATH, JSON.stringify({ slots: slotConfigs, default: defaultSlot }, null, 2), 'utf8');
        console.log('[System] Local config save successful');
    } catch (err) {
        console.warn('[Warning] Local config save failed (possibly read-only filesystem):', err);
    }
};

const initConfigs = async () => {
    console.log('[System] Loading configurations...');
    if (fs.existsSync(SLOT_CONFIG_PATH)) {
        try {
            const saved = JSON.parse(fs.readFileSync(SLOT_CONFIG_PATH, 'utf8'));
            slotConfigs = saved.slots || slotConfigs;
            defaultSlot = saved.default || defaultSlot;
            console.log('[System] Local config loaded');
        } catch (err) {}
    }
    if (firestore) {
        try {
            const doc = await firestore.collection('config').doc('slots').get();
            if (doc.exists) {
                const data = doc.data();
                if (data?.slots) slotConfigs = data.slots;
                if (data?.default) defaultSlot = data.default;
                console.log('[System] Firestore config loaded');
            }
        } catch (err) { console.error('[Error] Firestore load failed', err); }
    }
};

// --- Student Lookup Helper ---
async function findStudentData(uid: string, preferredCsvType?: string): Promise<Student | null> {
    const now = new Date();
    const taipeiDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const dateStr = taipeiDate.getFullYear() + '-' + String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + String(taipeiDate.getDate()).padStart(2, '0');
    const timeSlot = getTimeSlot(now);

    const tempRider: any = await getTemporaryRider(uid, dateStr, timeSlot);
    if (tempRider) return { uid: tempRider.uid, name: tempRider.name, badge: tempRider.badge || "---", bus: tempRider.bus, listType: 'temporary' };

    if (firestore) {
        try {
            const ids = [ `${uid}_${preferredCsvType || 'arrival'}`, `${uid}_arrival`, uid ];
            for (const id of ids) {
                const doc = await firestore.collection('students').doc(id).get();
                if (doc.exists) {
                    const data = doc.data() as Student;
                    if (!data.badge) data.badge = "";
                    return data;
                }
            }
            const snapshot = await firestore.collection('students').where('uid', '==', uid).limit(1).get();
            if (!snapshot.empty) {
                const data = snapshot.docs[0].data() as Student;
                if (!data.badge) data.badge = "";
                return data;
            }
        } catch (err) { console.error(`[Lookup] Firestore error student ${uid}:`, err); }
    }
    return null;
}

// --- Endpoints ---

app.post('/api/login', async (req: Request, res: Response) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    if (firestore) {
        const userDoc = await firestore.collection('accounts').doc(username).get();
        const user = userDoc.data();
        if (user && user.password === password) {
            const isAdmin = (user.type === 'admin' || username === 'admin');
            const token = isAdmin ? ADMIN_TOKEN : USER_TOKEN;
            return res.json({ token, user: { name: user.name, username, type: isAdmin ? 'admin' : 'user' } });
        }
    }
    res.status(401).json({ error: "Invalid credentials" });
});

app.get('/api/buses', authorize, async (req: Request, res: Response) => {
    const info = getTimeSlotInfo();
    if (firestore) {
        const configDoc = await firestore.collection('config').doc(`buses_${info.csvType}`).get();
        let buses = configDoc.data()?.list || [];
        if (buses.length === 0) {
            const defaultDoc = await firestore.collection('config').doc('buses').get();
            buses = defaultDoc.data()?.list || [];
        }
        return res.json(buses);
    }
    res.json([]);
});

app.get('/api/students', authorize, async (req: Request, res: Response) => {
    try {
        const queryDate = req.query.date as string;
        const now = new Date();
        const taipeiDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
        const currentDateStr = taipeiDate.getFullYear() + '-' + String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + String(taipeiDate.getDate()).padStart(2, '0');
        
        const targetDateStr = queryDate || currentDateStr;
        const timeSlot = getTimeSlot(now);
        const info = getTimeSlotInfo(now);

        const students: Record<string, any> = {};

        if (firestore) {
            // 1. Fetch Permanent Students for the current slot type
            const snapshot = await firestore.collection('students').where('listType', '==', info.csvType).get();
            snapshot.forEach(doc => {
                const data = doc.data();
                students[data.uid] = data;
            });

            // Fallback to arrival/legacy if empty
            if (info.csvType === "arrival" || snapshot.empty) {
                const allDocs = await firestore.collection('students').get();
                allDocs.forEach(doc => {
                    const data = doc.data();
                    if (!data.listType || data.listType === "arrival") {
                        if (!students[data.uid]) {
                            if (!data.badge) data.badge = "";
                            students[data.uid] = data;
                        }
                    }
                });
            }

            // 2. Fetch Temporary Riders for the SPECIFIC target date and current slot
            const tempSnapshot = await firestore.collection('temporaryRiders')
                .where('date', '==', targetDateStr)
                .where('timeSlot', '==', timeSlot)
                .get();
            
            tempSnapshot.forEach(doc => {
                const data = doc.data();
                // Override or add as temporary
                students[data.uid] = {
                    ...data,
                    listType: 'temporary',
                    isTemporary: true
                };
            });
        }

        res.json(students);
    } catch (err) {
        console.error('[Error] Failed to fetch students:', err);
        res.status(500).json({ error: "Failed to fetch student list" });
    }
});

app.get('/api/admin/config/slots', authorizeAdmin, async (req, res) => {
    await initConfigs(); // Force refresh from DB
    res.json({ slots: slotConfigs, default: defaultSlot });
});

app.post('/api/admin/config/slots', authorizeAdmin, async (req, res) => {
    try {
        const { slots, default: newDefault } = req.body;
        slotConfigs = slots;
        if (newDefault) defaultSlot = newDefault;
        await saveSlotConfigs();
        res.json({ success: true });
    } catch (err) {
        console.error('[Error] Failed to save slots:', err);
        res.status(500).json({ error: "Failed to save slot configurations" });
    }
});

app.post('/api/admin/config/accounts', authorizeAdmin, async (req, res) => {
    try {
        const adminUser = req.headers['x-admin-username'] as string;
        const accountsIn = req.body;
        if (!Array.isArray(accountsIn)) return res.status(400).json({ error: "Invalid data format" });

        if (firestore) {
            const batch = firestore.batch();
            
            // 1. Handle Deletions: Fetch existing accounts and find those not in the new list
            const snapshot = await firestore.collection('accounts').get();
            const existingIds = snapshot.docs.map(doc => doc.id);
            const newIds = accountsIn.map((a: any) => a.username).filter(Boolean);
            
            // SECURITY: Never delete the currently logged-in user or the 'admin' account
            const toDelete = existingIds.filter(id => !newIds.includes(id) && id !== adminUser && id !== 'admin');
            toDelete.forEach(id => {
                batch.delete(firestore!.collection('accounts').doc(id));
            });

            // 2. Handle Upserts (Add/Update)
            accountsIn.forEach((a: any) => {
                const { username, ...data } = a;
                if (username) {
                    // SECURITY: Ensure the currently logged-in user or 'admin' remains an admin
                    if (username === adminUser || username === 'admin') {
                        data.type = 'admin';
                    }
                    batch.set(firestore!.collection('accounts').doc(username), data);
                }
            });
            
            await batch.commit();
            console.log('[System] Firestore accounts sync successful');
        }

        // Always attempt to save locally as a backup or for Local Mode
        try {
            const accountsPath = path.resolve(__dirname, 'accounts.json');
            fs.writeFileSync(accountsPath, JSON.stringify(accountsIn, null, 2), 'utf8');
            console.log('[System] Local accounts save successful');
        } catch (err) {
            console.warn('[Warning] Local accounts save failed:', err);
            // If firestore succeeded, we still consider the whole operation a success
            if (!firestore) throw err; 
        }

        res.json({ success: true });
    } catch (err) {
        console.error('[Error] Failed to save accounts:', err);
        res.status(500).json({ error: "Failed to save accounts" });
    }
});

app.get('/api/admin/accounts', authorizeAdmin, async (req: Request, res: Response) => {
    if (firestore) {
        try {
            const snapshot = await firestore.collection('accounts').get();
            const accounts: any[] = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                accounts.push({ username: doc.id, ...data });
            });
            res.json(accounts);
        } catch (err) { res.status(500).json({ error: "Failed to fetch accounts" }); }
    } else {
        const accountsPath = path.resolve(__dirname, 'accounts.json');
        if (fs.existsSync(accountsPath)) {
            try { res.json(JSON.parse(fs.readFileSync(accountsPath, 'utf8'))); }
            catch (err) { res.status(500).json({ error: "Failed to read local accounts" }); }
        } else { res.json([]); }
    }
});

app.get('/api/admin/temporary-riders', authorizeAdmin, async (req: Request, res: Response) => {
    if (firestore) {
        const snapshot = await firestore.collection('temporaryRiders').get();
        res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } else { res.json([]); }
});

app.post('/api/admin/temporary-riders', authorizeAdmin, async (req: Request, res: Response) => {
    const { date, timeSlot, bus, uid, name, badge, class: studentClass } = req.body;
    if (!firestore) return res.status(400).json({ error: "Firestore required" });
    try {
        await firestore.collection('temporaryRiders').add({ date, timeSlot, bus, uid, name, badge: badge || "---", class: studentClass || "" });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to add" }); }
});

app.delete('/api/admin/temporary-riders/:id', authorizeAdmin, async (req: Request, res: Response) => {
    if (firestore) {
        try {
            await firestore.collection('temporaryRiders').doc(req.params.id).delete();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: "Failed to delete" }); }
    } else { res.status(400).json({ error: "Firestore required" }); }
});

app.get('/api/admin/bus-occupancy', authorizeAdmin, async (req: Request, res: Response) => {
    const { date, timeSlot, bus } = req.query;
    if (!firestore || !date || !timeSlot || !bus) return res.status(400).json({ error: "Missing fields" });
    try {
        const busStr = bus as string;
        const matchingConfig = slotConfigs.find(s => `${s.start}-${s.end}` === timeSlot) || slotConfigs.find(s => s.label === timeSlot);
        const csvType = matchingConfig?.csvType || "arrival";

        // Get bus limit
        const configDoc = await firestore.collection('config').doc(`buses_${csvType}`).get();
        const busList = configDoc.data()?.list || [];
        const busObj = busList.find((b: any) => (b.name || b.bus) === busStr);
        const limit = busObj?.overflow || 40;

        // Fetch all students for this list type and filter locally to support multi-bus strings
        const studentsSnapshot = await firestore.collection('students').where('listType', '==', csvType).get();
        let count = 0;
        studentsSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.bus) {
                const buses = (data.bus as string).split('/').map(b => b.trim());
                if (buses.includes(busStr)) count++;
            }
        });

        // Add temporary riders
        const temps = await firestore.collection('temporaryRiders')
            .where('date', '==', date)
            .where('timeSlot', '==', timeSlot)
            .where('bus', '==', busStr)
            .get();
        
        res.json({ count: count + temps.size, overflowLimit: limit });
    } catch (err) { res.status(500).json({ error: "Failed to check occupancy" }); }
});

app.get('/api/admin/rollcall-csv', authorizeAdmin, async (req, res) => {
    const { date, timeSlot } = req.query;
    if (!firestore || !date || !timeSlot) return res.status(400).json({ error: "Missing date or slot" });

    try {
        const dateStr = date as string;
        const slotStr = timeSlot as string;
        const { students, csvType } = await getStudentsForSlot(slotStr);
        
        // Fetch rollcall records from multiple possible collection names for compatibility
        const collections = ['rollcalls', 'RollCall', 'Rollcall'];
        let records: any[] = [];
        
        for (const collName of collections) {
            const snapshot = await firestore.collection(collName)
                .where('date', '==', dateStr)
                .where('timeSlot', '==', slotStr)
                .get();
            if (!snapshot.empty) {
                records = [...records, ...snapshot.docs.map(doc => doc.data())];
            }
        }
        
        // Remove duplicates if any (by uid)
        const uniqueRecords = Array.from(new Map(records.map(r => [r.uid, r])).values());
        
        // Generate CSV
        let csv = '\uFEFFuid,name,badge,class,assigned_bus,status,timestamp\n';
        students.forEach((s: any) => {
            const record = uniqueRecords.find(r => r.uid === s.uid);
            const status = record ? '已簽到' : '未到';
            const time = record ? new Date(record.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '---';
            csv += `${s.uid},${s.name},${s.badge},${s.class || ''},"${s.bus || ''}",${status},${time}\n`;
        });

        // Add extra records (temporary or unknown) not in the main list
        uniqueRecords.forEach(r => {
            if (!students.some((s: any) => s.uid === r.uid)) {
                const time = new Date(r.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                csv += `${r.uid},未知/臨時,,,,,已簽到,${time}\n`;
            }
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="rollcall-${dateStr}.csv"`);
        res.send(csv);
    } catch (err) { res.status(500).json({ error: "Failed to generate CSV" }); }
});

app.get('/api/admin/rollcall-week', authorizeAdmin, async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!firestore || !startDate || !endDate) return res.status(400).json({ error: "Missing date range" });

    try {
        const start = new Date(startDate as string);
        const end = new Date(endDate as string);
        const files: Record<string, string> = {};

        // Loop through each day in the range
        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
            const dateStr = d.toISOString().split('T')[0];
            
            // For each day, generate CSVs for all relevant slots
            const dayOfWeek = d.getDay();
            const relevantSlots = slotConfigs.filter(s => {
                return (s.day === undefined && s.days === undefined) || 
                       (s.day !== undefined && s.day === dayOfWeek) || 
                       (s.days !== undefined && s.days.includes(dayOfWeek));
            });

            for (const slot of relevantSlots) {
                const slotLabel = `${slot.start}-${slot.end}`;
                const { students } = await getStudentsForSlot(slotLabel);
                
                // Fetch from multiple collections
                const collections = ['rollcalls', 'RollCall', 'Rollcall'];
                let records: any[] = [];
                for (const collName of collections) {
                    const snapshot = await firestore.collection(collName)
                        .where('date', '==', dateStr)
                        .where('timeSlot', '==', slotLabel)
                        .get();
                    if (!snapshot.empty) {
                        records = [...records, ...snapshot.docs.map(doc => doc.data())];
                    }
                }
                const uniqueRecords = Array.from(new Map(records.map(r => [r.uid, r])).values());
                
                let csv = '\uFEFFuid,name,badge,class,assigned_bus,status,timestamp\n';
                students.forEach((s: any) => {
                    const record = uniqueRecords.find(r => r.uid === s.uid);
                    csv += `${s.uid},${s.name},${s.badge},${s.class || ''},"${s.bus || ''}",${record ? '已簽到' : '未到'},${record ? new Date(record.timestamp).toISOString() : ''}\n`;
                });

                files[`rollcall-${dateStr}-${slot.label}.csv`] = csv;
            }
        }
        res.json({ files });
    } catch (err) { res.status(500).json({ error: "Failed to generate week report" }); }
});

app.post('/api/admin/config/students', authorizeAdmin, async (req, res) => {
    const { students, csvType } = req.body;
    const type = csvType || "arrival";
    if (firestore) {
        for (let i = 0; i < students.length; i += 450) {
            const batch = firestore.batch();
            students.slice(i, i + 450).forEach((s: any) => {
                if (s.uid) batch.set(firestore!.collection('students').doc(`${s.uid}_${type}`), { ...s, listType: type }, { merge: true });
            });
            await batch.commit();
        }
    }
    res.json({ success: true });
});

app.post('/api/admin/config/buses', authorizeAdmin, async (req, res) => {
    const { buses, csvType } = req.body;
    if (firestore) await firestore.collection('config').doc(`buses_${csvType || 'arrival'}`).set({ list: buses });
    res.json({ success: true });
});

app.get('/api/admin/photos', authorizeAdmin, async (req: Request, res: Response) => {
    if (firestore) {
        try {
            const snapshot = await firestore.collection('students').orderBy('name').get();
            const photos: any[] = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.photo) photos.push({ uid: data.uid, name: data.name, badge: data.badge, class: data.class });
            });
            res.json(photos);
        } catch (err) { res.status(500).json({ error: "Failed to fetch photos" }); }
    } else { res.json([]); }
});

app.delete('/api/admin/student/photo/:uid', authorizeAdmin, async (req: Request, res: Response) => {
    if (!firestore) return res.status(400).json({ error: "Firestore required" });
    try {
        const snapshot = await firestore.collection('students').where('uid', '==', req.params.uid).get();
        const batch = firestore.batch();
        snapshot.forEach(doc => batch.update(doc.ref, { photo: admin.firestore.FieldValue.delete() }));
        await batch.commit();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to delete" }); }
});

app.delete('/api/admin/class/photos/:className', authorizeAdmin, async (req: Request, res: Response) => {
    if (!firestore) return res.status(400).json({ error: "Firestore required" });
    try {
        const className = req.params.className === '未分班' ? null : req.params.className;
        
        // Find all students in this class that have a photo
        let query = firestore.collection('students').where('photo', '!=', null);
        
        if (className === null) {
            // Handle null/missing class (might require multiple queries depending on firestore structure)
            // For simplicity in this schema, we'll fetch then filter or use multiple where
            const snapshot = await firestore.collection('students').get();
            const batch = firestore.batch();
            let count = 0;
            snapshot.forEach(doc => {
                const data = doc.data();
                if ((!data.class || data.class === '') && data.photo) {
                    batch.update(doc.ref, { photo: admin.firestore.FieldValue.delete() });
                    count++;
                }
            });
            if (count > 0) await batch.commit();
            return res.json({ success: true, count });
        } else {
            const snapshot = await firestore.collection('students')
                .where('class', '==', className)
                .get();
            
            const batch = firestore.batch();
            let count = 0;
            snapshot.forEach(doc => {
                if (doc.data().photo) {
                    batch.update(doc.ref, { photo: admin.firestore.FieldValue.delete() });
                    count++;
                }
            });
            if (count > 0) await batch.commit();
            res.json({ success: true, count });
        }
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: "Failed to bulk delete photos" }); 
    }
});

app.post('/api/admin/student/photo', authorizeAdmin, async (req: Request, res: Response) => {
    const { uid, photo } = req.body;
    if (!firestore || !uid || !photo) return res.status(400).json({ error: "Missing data" });
    try {
        const snapshot = await firestore.collection('students').where('uid', '==', uid).get();
        if (snapshot.empty) return res.status(404).json({ error: "Student not found" });
        const batch = firestore.batch();
        snapshot.forEach(doc => batch.update(doc.ref, { photo }));
        await batch.commit();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to upload" }); }
});

app.get('/api/photo/:uid', async (req: Request, res: Response) => {
    const { token } = req.query;
    if (token !== ADMIN_TOKEN && token !== USER_TOKEN) return res.status(401).send('Unauthorized');
    if (firestore) {
        const snapshot = await firestore.collection('students').where('uid', '==', req.params.uid).limit(1).get();
        if (!snapshot.empty && snapshot.docs[0].data().photo) {
            const buffer = Buffer.from(snapshot.docs[0].data().photo, 'base64');
            res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buffer.length });
            return res.end(buffer);
        }
    }
    res.status(404).send('Not found');
});

app.get('/api/student/:uid', authorize, async (req: Request, res: Response) => {
    const student = await findStudentData(req.params.uid);
    if (student) res.json(student);
    else res.status(404).json({ error: "Student not found" });
});

app.post('/api/rollcall/batch', authorize, async (req, res) => {
    try {
        const { records } = req.body;
        if (!Array.isArray(records)) return res.status(400).json({ error: "Records array required" });
        if (!firestore) return res.status(400).json({ error: "Firestore required for roll call" });

        const batch = firestore.batch();
        const results = [];

        for (const record of records) {
            const { uid, timestamp } = record;
            if (!uid || !timestamp) continue;

            const dateObj = new Date(timestamp);
            const taipeiDate = new Date(dateObj.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
            const dateStr = taipeiDate.getFullYear() + '-' + String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + String(taipeiDate.getDate()).padStart(2, '0');
            const timeSlot = getTimeSlot(dateObj);

            // Create a unique ID for this record
            const recordId = `${uid}_${dateStr}_${timeSlot.replace(/:/g, '-')}`;
            const rollcallRef = firestore.collection('rollcalls').doc(recordId);

            batch.set(rollcallRef, {
                uid,
                timestamp,
                date: dateStr,
                timeSlot,
                syncedAt: new Date().toISOString()
            }, { merge: true });

            results.push({ uid, success: true });
        }

        await batch.commit();
        res.json({ success: true, message: `Successfully synced ${results.length} records` });
    } catch (err) {
        console.error('[Error] Batch rollcall failed:', err);
        res.status(500).json({ error: "Failed to sync rollcall data" });
    }
});

// Helper functions for time calculation
const getTimeSlotInfo = (dateObj: Date = new Date()) => {
    const taipeiTime = new Date(dateObj.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const currentTimeStr = `${taipeiTime.getHours().toString().padStart(2, '0')}:${taipeiTime.getMinutes().toString().padStart(2, '0')}`;
    const day = taipeiTime.getDay();

    // Filter all currently matching slots
    const matches = slotConfigs.filter(s => {
        const matchDay = (s.day === undefined && s.days === undefined) || 
                        (s.day !== undefined && s.day === day) || 
                        (s.days !== undefined && s.days.includes(day));
        return matchDay && currentTimeStr >= s.start && currentTimeStr < s.end;
    });

    if (matches.length === 0) {
        return { ...defaultSlot, start: "00:00", end: "23:59" };
    }

    // Prioritize:
    // 1. isTemp: true (Temporary overrides)
    // 2. Specificity (day/days defined over "every day")
    return matches.sort((a, b) => {
        // Priority 1: Temporary vs Permanent
        const aTemp = !!a.isTemp;
        const bTemp = !!b.isTemp;
        if (aTemp && !bTemp) return -1;
        if (!aTemp && bTemp) return 1;

        // Priority 2: Specific Day(s) vs General
        const aSpecific = a.day !== undefined || a.days !== undefined;
        const bSpecific = b.day !== undefined || b.days !== undefined;
        if (aSpecific && !bSpecific) return -1;
        if (!aSpecific && bSpecific) return 1;

        return 0;
    })[0];
};

const getTimeSlot = (dateObj: Date = new Date()) => {
    const info = getTimeSlotInfo(dateObj);
    return info.label === defaultSlot.label ? defaultSlot.label : `${info.start}-${info.end}`;
};

async function getTemporaryRider(uid: string, date: string, timeSlot: string) {
    if (firestore) {
        const snapshot = await firestore.collection('temporaryRiders').where('uid', '==', uid).where('date', '==', date).where('timeSlot', '==', timeSlot).limit(1).get();
        return snapshot.empty ? null : snapshot.docs[0].data();
    }
    return null;
}

async function getStudentsForSlot(slotLabel: string, dateStr?: string) {
    const matchingConfig = slotConfigs.find(s => `${s.start}-${s.end}` === slotLabel) || slotConfigs.find(s => s.label === slotLabel);
    const csvType = matchingConfig?.csvType || "arrival";
    let students: any[] = [];
    if (firestore) {
        const snapshot = await firestore.collection('students').where('listType', '==', csvType).get();
        snapshot.forEach(doc => students.push(doc.data()));
        if (csvType === "arrival" || snapshot.empty) {
            const legacy = await firestore.collection('students').get();
            legacy.forEach(doc => {
                const d = doc.data();
                if (!d.listType || d.listType === "arrival") if (!students.some(s => s.uid === d.uid)) students.push(d);
            });
        }
    }
    return { students, csvType };
}

// Start Server
initConfigs().then(() => {
    if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
        app.listen(PORT, () => console.log(`Server running on ${PORT}`));
    }
});

export default app;
