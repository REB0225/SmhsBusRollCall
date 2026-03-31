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
const AUTH_TOKEN = "secret-bus-token-2026";
const authorize = (req: Request, res: Response, next: Function) => {
  const authHeader = req.headers['authorization'];
  const queryToken = req.query.token as string;
  if (authHeader === `Bearer ${AUTH_TOKEN}` || queryToken === AUTH_TOKEN) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized" });
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
        if (user && user.password === password) return res.json({ token: AUTH_TOKEN, user: { name: user.name, username, type: user.type || 'user' } });
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
    const { date } = req.query;
    const info = getTimeSlotInfo();
    if (date) {
        const { students } = await getStudentsForSlot(getTimeSlot(), date as string);
        const studentMap: Record<string, any> = {};
        students.forEach(s => studentMap[s.uid] = s);
        return res.json(studentMap);
    }
    if (firestore) {
        const students: Record<string, any> = {};
        const snapshot = await firestore.collection('students').where('listType', '==', info.csvType).get();
        snapshot.forEach(doc => students[doc.data().uid] = doc.data());
        if (info.csvType === "arrival" || snapshot.empty) {
            const allDocs = await firestore.collection('students').get();
            allDocs.forEach(doc => {
                const data = doc.data();
                if (!data.listType || data.listType === "arrival") if (!students[data.uid]) { if (!data.badge) data.badge = ""; students[data.uid] = data; }
            });
        }
        return res.json(students);
    }
    res.json({});
});

app.get('/api/admin/config/slots', authorize, async (req, res) => {
    await initConfigs(); // Force refresh from DB
    res.json({ slots: slotConfigs, default: defaultSlot });
});

app.post('/api/admin/config/slots', authorize, async (req, res) => {
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

app.post('/api/admin/config/accounts', authorize, async (req, res) => {
    try {
        const accountsIn = req.body;
        if (!Array.isArray(accountsIn)) return res.status(400).json({ error: "Invalid data format" });

        if (firestore) {
            const batch = firestore.batch();
            
            // 1. Handle Deletions: Fetch existing accounts and find those not in the new list
            const snapshot = await firestore.collection('accounts').get();
            const existingIds = snapshot.docs.map(doc => doc.id);
            const newIds = accountsIn.map((a: any) => a.username).filter(Boolean);
            
            const toDelete = existingIds.filter(id => !newIds.includes(id));
            toDelete.forEach(id => {
                batch.delete(firestore!.collection('accounts').doc(id));
            });

            // 2. Handle Upserts (Add/Update)
            accountsIn.forEach((a: any) => {
                const { username, ...data } = a;
                if (username) {
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

app.get('/api/admin/accounts', authorize, async (req: Request, res: Response) => {
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

app.get('/api/admin/temporary-riders', authorize, async (req: Request, res: Response) => {
    if (firestore) {
        const snapshot = await firestore.collection('temporaryRiders').get();
        res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } else { res.json([]); }
});

app.post('/api/admin/temporary-riders', authorize, async (req: Request, res: Response) => {
    const { date, timeSlot, bus, uid, name, badge } = req.body;
    if (!firestore) return res.status(400).json({ error: "Firestore required" });
    try {
        await firestore.collection('temporaryRiders').add({ date, timeSlot, bus, uid, name, badge: badge || "---" });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to add" }); }
});

app.delete('/api/admin/temporary-riders/:id', authorize, async (req: Request, res: Response) => {
    if (firestore) {
        try {
            await firestore.collection('temporaryRiders').doc(req.params.id).delete();
            res.json({ success: true });
        } catch (err) { res.status(500).json({ error: "Failed to delete" }); }
    } else { res.status(400).json({ error: "Firestore required" }); }
});

app.get('/api/admin/bus-occupancy', authorize, async (req: Request, res: Response) => {
    const { date, timeSlot, bus } = req.query;
    if (!firestore || !date || !timeSlot || !bus) return res.status(400).json({ error: "Missing fields" });
    try {
        const configDoc = await firestore.collection('config').doc(`buses_arrival`).get();
        const busList = configDoc.data()?.list || [];
        const busObj = busList.find((b: any) => (b.name || b) === bus);
        const limit = busObj?.overflow || 40;
        const students = await firestore.collection('students').where('bus', '==', bus).get();
        const temps = await firestore.collection('temporaryRiders').where('date', '==', date).where('timeSlot', '==', timeSlot).where('bus', '==', bus).get();
        res.json({ count: students.size + temps.size, overflowLimit: limit });
    } catch (err) { res.status(500).json({ error: "Failed to check" }); }
});

app.post('/api/admin/config/students', authorize, async (req, res) => {
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

app.post('/api/admin/config/buses', authorize, async (req, res) => {
    const { buses, csvType } = req.body;
    if (firestore) await firestore.collection('config').doc(`buses_${csvType || 'arrival'}`).set({ list: buses });
    res.json({ success: true });
});

app.get('/api/admin/photos', authorize, async (req: Request, res: Response) => {
    if (firestore) {
        try {
            const snapshot = await firestore.collection('students').orderBy('name').get();
            const photos: any[] = [];
            snapshot.forEach(doc => {
                const data = doc.data();
                if (data.photo) photos.push({ uid: data.uid, name: data.name, badge: data.badge });
            });
            res.json(photos);
        } catch (err) { res.status(500).json({ error: "Failed to fetch photos" }); }
    } else { res.json([]); }
});

app.delete('/api/admin/student/photo/:uid', authorize, async (req: Request, res: Response) => {
    if (!firestore) return res.status(400).json({ error: "Firestore required" });
    try {
        const snapshot = await firestore.collection('students').where('uid', '==', req.params.uid).get();
        const batch = firestore.batch();
        snapshot.forEach(doc => batch.update(doc.ref, { photo: admin.firestore.FieldValue.delete() }));
        await batch.commit();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to delete" }); }
});

app.post('/api/admin/student/photo', authorize, async (req: Request, res: Response) => {
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
    if (token !== AUTH_TOKEN) return res.status(401).send('Unauthorized');
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
    else res.status(404).json({ error: "Not found" });
});

// Helper functions for time calculation
const getTimeSlotInfo = (dateObj: Date = new Date()) => {
    const taipeiTime = new Date(dateObj.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const currentTimeStr = `${taipeiTime.getHours().toString().padStart(2, '0')}:${taipeiTime.getMinutes().toString().padStart(2, '0')}`;
    const day = taipeiTime.getDay();
    const specific = slotConfigs.find(s => {
        const matchDay = (s.day !== undefined && s.day === day) || (s.days !== undefined && s.days.includes(day));
        return matchDay && currentTimeStr >= s.start && currentTimeStr < s.end;
    });
    if (specific) return specific;
    const general = slotConfigs.find(s => s.day === undefined && s.days === undefined && currentTimeStr >= s.start && currentTimeStr < s.end);
    if (general) return general;
    return { ...defaultSlot, start: "00:00", end: "23:59" };
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
