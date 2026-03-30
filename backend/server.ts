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
app.use(express.json({ limit: '10mb' })); // Increased limit for base64 photo uploads

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
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        firestore = admin.firestore();
        console.log('[Database] Firestore initialized successfully.');

        // Bootstrap: Ensure at least one admin exists
        const bootstrap = async () => {
            const accountsSnapshot = await firestore!.collection('accounts').limit(1).get();
            if (accountsSnapshot.empty) {
                console.log('[Auth] No accounts found. Creating default admin...');
                await firestore!.collection('accounts').doc('admin').set({
                    username: 'admin',
                    password: 'admin123',
                    name: 'System Admin',
                    type: 'admin'
                });
            }
        };
        bootstrap();
    } catch (err) {
        console.error('[Error] Failed to initialize Firestore:', err);
    }
} else {
    console.log('[Database] No credentials found. Falling back to Local Mode (CSV/JSON).');
    
    // Bootstrap Local Mode
    const accountsPath = path.resolve(__dirname, 'accounts.json');
    if (!fs.existsSync(accountsPath)) {
        console.log('[Auth] No accounts.json found. Creating default admin...');
        fs.writeFileSync(accountsPath, JSON.stringify([{
            username: 'admin',
            password: 'admin123',
            name: 'System Admin',
            type: 'admin'
        }], null, 2), 'utf8');
    }
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
  photo?: string; // Base64 encoded JPEG
}

// --- Time Slot Helper ---
interface SlotMapping {
    day?: number; // 0-6 (Sun-Sat)
    days?: number[]; // Array of 0-6 for groups (e.g. [1,2,3,4] for Mon-Thu)
    start: string; // HH:mm
    end: string;
    csvType: string; // "arrival" | "full_departure" | "night_class_afternoon" | "night_class_night"
    label: string;
    isTemp?: boolean;
}

// Default rules as specified by user
let slotConfigs: SlotMapping[] = [
    { start: "07:00", end: "09:00", csvType: "arrival", label: "Morning" },
    { day: 5, start: "16:00", end: "18:00", csvType: "full_departure", label: "Friday Afternoon" },
    { days: [1, 2, 3, 4], start: "16:00", end: "18:00", csvType: "night_class_afternoon", label: "Mon-Thu Afternoon" },
    { days: [1, 2, 3, 4], start: "19:00", end: "21:00", csvType: "night_class_night", label: "Mon-Thu Night" }
];

let defaultSlot: Omit<SlotMapping, 'start' | 'end'> = { csvType: "arrival", label: "Not in time" };

const getTimeSlotInfo = (dateObj: Date = new Date()) => {
    const taipeiTime = new Date(dateObj.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const day = taipeiTime.getDay();
    const hours = taipeiTime.getHours();
    const minutes = taipeiTime.getMinutes();
    const currentTimeStr = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;

    console.log(`[TimeSlot] Checking for ${currentTimeStr} (Day ${day})`);

    // 1. Check for temporary slots first (Priority 1)
    const tempSlot = slotConfigs.find(s => s.isTemp && currentTimeStr >= s.start && currentTimeStr < s.end);
    if (tempSlot) {
        console.log(`[TimeSlot] Matched Temp: ${tempSlot.label}`);
        return tempSlot;
    }

    // 2. Check for specific day overrides (Priority 2)
    const specificSlot = slotConfigs.find(s => {
        const matchesDay = (s.day !== undefined && s.day === day) || (s.days !== undefined && s.days.includes(day));
        return matchesDay && currentTimeStr >= s.start && currentTimeStr < s.end;
    });
    if (specificSlot) {
        console.log(`[TimeSlot] Matched Day-Specific: ${specificSlot.label}`);
        return specificSlot;
    }

    // 3. Check for general slots (no day specified) (Priority 3)
    const generalSlot = slotConfigs.find(s => s.day === undefined && s.days === undefined && currentTimeStr >= s.start && currentTimeStr < s.end);
    if (generalSlot) {
        console.log(`[TimeSlot] Matched General: ${generalSlot.label}`);
        return generalSlot;
    }

    // 4. Return the configurable default
    console.log(`[TimeSlot] No match, returning default: ${defaultSlot.label}`);
    return { ...defaultSlot, start: "00:00", end: "23:59" };
};

const getTimeSlot = (dateObj: Date = new Date()) => {
    const info = getTimeSlotInfo(dateObj);
    return info.label === defaultSlot.label ? defaultSlot.label : `${info.start}-${info.end}`;
};

// --- Local Helpers (Fallbacks) ---
const loadStudentsLocal = (csvType: string = "arrival"): Record<string, Student> => {
    const filename = csvType === "arrival" ? 'students.csv' : `students_${csvType}.csv`;
    const csvFilePath = path.resolve(__dirname, filename);
    
    // Fallback to legacy students.csv if the specific one doesn't exist
    let finalPath = csvFilePath;
    if (!fs.existsSync(csvFilePath)) {
        finalPath = path.resolve(__dirname, 'students.csv');
    }

    try {
        const fileContent = fs.readFileSync(finalPath, { encoding: 'utf-8' });
        const records: any[] = parse(fileContent, {
            columns: true, skip_empty_lines: true, trim: true, bom: true
        });
        const studentsMap: Record<string, Student> = {};
        records.forEach(r => studentsMap[r.uid] = { uid: r.uid, name: r.name, badge: r.badge, bus: r.bus || "" });
        return studentsMap;
    } catch (err) { return {}; }
};

const saveRollCallLocal = (uid: string, name: string, badge: string, bus: string, timestamp: string, dateStr: string, timeSlot: string) => {
    const rollCallPath = path.resolve(__dirname, 'roll-call.csv');
    const localTime = new Date(timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

    if (!fs.existsSync(rollCallPath)) {
        fs.writeFileSync(rollCallPath, '\ufeff' + 'timestamp,date,timeSlot,uid,name,badge,bus\n', 'utf8');
    }
    const line = `"${localTime}","${dateStr}","${timeSlot}","${uid}","${name}","${badge}","${bus}"\n`;
    fs.appendFileSync(rollCallPath, line, 'utf8');
};

async function getTemporaryRider(uid: string, date: string, timeSlot: string) {
    console.log(`[Lookup] Checking temp rider for UID: ${uid}, Date: ${date}, Slot: ${timeSlot}`);
    if (firestore) {
        try {
            const snapshot = await firestore!.collection('temporaryRiders')
                .where('uid', '==', uid)
                .where('date', '==', date)
                .where('timeSlot', '==', timeSlot)
                .limit(1).get();
            if (!snapshot.empty) {
                console.log(`[Lookup] Found Firestore match for ${uid}`);
                return snapshot.docs[0].data();
            }
        } catch (err) {
            console.error(`[Lookup] Firestore error in getTemporaryRider:`, err);
        }
    } else {
        const tempPath = path.resolve(__dirname, 'temporary-riders.json');
        if (fs.existsSync(tempPath)) {
            const riders = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
            const match = riders.find((r: any) => r.uid === uid && r.date === date && r.timeSlot === timeSlot) || null;
            if (match) console.log(`[Lookup] Found local match for ${uid}`);
            return match;
        }
    }
    return null;
}

// New helper to fetch temp riders without extra logging if needed
async function fetchTemporaryRidersRaw(date: string, timeSlot: string): Promise<any[]> {
    if (firestore) {
        const snapshot = await firestore!.collection('temporaryRiders')
            .where('date', '==', date)
            .where('timeSlot', '==', timeSlot)
            .get();
        let riders: any[] = [];
        snapshot.forEach(doc => riders.push(doc.data()));
        return riders;
    } else {
        const tempPath = path.resolve(__dirname, 'temporary-riders.json');
        if (fs.existsSync(tempPath)) {
            const allTemp = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
            return allTemp.filter((r: any) => r.date === date && r.timeSlot === timeSlot);
        }
    }
    return [];
}

async function getStudentsForSlot(slotLabel: string, dateStr?: string) {
    const matchingConfig = slotConfigs.find(s => `${s.start}-${s.end}` === slotLabel);
    const csvType = matchingConfig?.csvType || "arrival";
    console.log(`[Helper] getStudentsForSlot: Label=${slotLabel}, Date=${dateStr}, Type=${csvType}`);
    
    let students: any[] = [];
    if (firestore) {
        try {
            // 1. Fetch students for this specific slot
            const snapshot = await firestore!.collection('students').where('listType', '==', csvType).get();
            snapshot.forEach(doc => students.push(doc.data()));
            console.log(`[Helper] Primary fetch found ${students.length} students`);

            // 2. Include legacy students if this is 'arrival' or if the primary slot is empty
            if (csvType === "arrival" || students.length === 0) {
                const legacySnapshot = await firestore!.collection('students').get();
                let added = 0;
                legacySnapshot.forEach(doc => {
                    const data = doc.data();
                    // Legacy student has no listType
                    if (!data.listType || (students.length === 0 && data.listType === "arrival")) {
                        if (!students.some(s => s.uid === data.uid)) {
                            if (!data.badge) data.badge = "";
                            students.push(data);
                            added++;
                        }
                    }
                });
                if (added > 0) console.log(`[Helper] Added ${added} legacy students to list`);
            }
        } catch (err) {
            console.error('[Helper] Firestore error in getStudentsForSlot:', err);
        }
    } else {
        const studentsMap = loadStudentsLocal(csvType);
        students = Object.values(studentsMap);
    }

    // Apply temporary overrides for a specific date if provided
    if (dateStr) {
        const tempRiders = await fetchTemporaryRidersRaw(dateStr, slotLabel);
        console.log(`[Helper] Found ${tempRiders.length} temporary riders for this specific trip`);

        // Create a map for quick lookup
        const tempMap = new Map(tempRiders.map(r => [r.uid, r]));
        
        // Apply overrides to existing students and track handled UIDs
        const finalStudents = students.map(s => {
            if (tempMap.has(s.uid)) {
                const override = tempMap.get(s.uid);
                tempMap.delete(s.uid); // Mark as handled
                return { ...s, bus: override.bus, isTemp: true, name: override.name, badge: override.badge };
            }
            return s;
        });

        // Add students who are ONLY on the temporary list for this trip
        tempMap.forEach(override => {
            finalStudents.push({
                uid: override.uid,
                name: override.name,
                badge: override.badge || "---",
                bus: override.bus,
                isTemp: true
            });
        });

        return { students: finalStudents, csvType };
    }

    return { students, csvType };
}

// --- Student Lookup Helper ---
async function findStudentData(uid: string, preferredCsvType?: string): Promise<Student | null> {
    // 1. Always check for Temporary Rider first (using current context if needed)
    const now = new Date();
    const taipeiDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const dateStr = taipeiDate.getFullYear() + '-' + 
                   String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + 
                   String(taipeiDate.getDate()).padStart(2, '0');
    const timeSlot = getTimeSlot(now);

    const tempRider: any = await getTemporaryRider(uid, dateStr, timeSlot);
    if (tempRider) {
        return {
            uid: tempRider.uid,
            name: tempRider.name,
            badge: tempRider.badge || "---",
            bus: tempRider.bus,
            listType: 'temporary'
        };
    }

    if (firestore) {
        try {
            let student: Student | null = null;
            // 2. Try preferred trip/slot first if provided
            if (preferredCsvType) {
                const docId = `${uid}_${preferredCsvType}`;
                const tripDoc = await firestore!.collection('students').doc(docId).get();
                if (tripDoc.exists) student = tripDoc.data() as Student;
            }

            if (!student) {
                // 3. Try arrival (standard primary list)
                const arrivalDoc = await firestore!.collection('students').doc(`${uid}_arrival`).get();
                if (arrivalDoc.exists) student = arrivalDoc.data() as Student;
            }

            if (!student) {
                // 4. Try legacy ID (just UID)
                const legacyDoc = await firestore!.collection('students').doc(uid).get();
                if (legacyDoc.exists) student = legacyDoc.data() as Student;
            }

            if (!student) {
                // 5. Final search across all documents for this UID
                const snapshot = await firestore!.collection('students').where('uid', '==', uid).limit(1).get();
                if (!snapshot.empty) student = snapshot.docs[0].data() as Student;
            }

            if (student) {
                if (!student.badge) student.badge = "";
                return student;
            }

        } catch (err) {
            console.error(`[Lookup] Firestore error finding student ${uid}:`, err);
        }
    } else {
        const students = loadStudentsLocal(preferredCsvType || "arrival");
        if (students[uid]) return students[uid];
        const arrivalStudents = loadStudentsLocal("arrival");
        if (arrivalStudents[uid]) return arrivalStudents[uid];
    }
    return null;
}

// --- Endpoints ---

app.post('/api/login', async (req: Request, res: Response) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: "Username and password are required" });
    }

    console.log(`[Auth] Login attempt for: ${username}`);
    
    if (firestore) {
        try {
            const userDoc = await firestore!.collection('accounts').doc(username).get();
            const user = userDoc.data();
            if (user && user.password === password) {
                const { password: _, ...userWithoutPassword } = user;
                if (!userWithoutPassword.type) userWithoutPassword.type = 'user';
                console.log(`[Auth] Login success: ${username}`);
                return res.json({ token: AUTH_TOKEN, user: { ...userWithoutPassword, username } });
            }
        } catch (err) {
            console.error(`[Auth] Firestore error during login:`, err);
        }
    } else {
        const accountsPath = path.resolve(__dirname, 'accounts.json');
        if (fs.existsSync(accountsPath)) {
            try {
                const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
                const user = accounts.find((a: any) => a.username === username && a.password === password);
                if (user) {
                    const { password: _, ...userWithoutPassword } = user;
                    if (!userWithoutPassword.type) userWithoutPassword.type = 'user';
                    console.log(`[Auth] Login success (Local): ${username}`);
                    return res.json({ token: AUTH_TOKEN, user: userWithoutPassword });
                }
            } catch (err) {
                console.error(`[Auth] Local accounts error during login:`, err);
            }
        }
    }
    console.warn(`[Auth] Login failed for: ${username}`);
    res.status(401).json({ error: "Invalid credentials" });
});

app.get('/api/buses', authorize, async (req: Request, res: Response) => {
    const info = getTimeSlotInfo();
    const csvType = info.csvType;
    console.log(`[Buses] Fetching for csvType: ${csvType}`);

    if (firestore) {
        try {
            const configDoc = await firestore!.collection('config').doc(`buses_${csvType}`).get();
            let buses = configDoc.data()?.list || [];
            console.log(`[Buses] Primary fetch (buses_${csvType}): Found ${buses.length}`);

            if (buses.length === 0) {
                console.log(`[Buses] Falling back to default 'buses' config`);
                const defaultDoc = await firestore!.collection('config').doc('buses').get();
                buses = defaultDoc.data()?.list || [];
                console.log(`[Buses] Fallback fetch: Found ${buses.length}`);
            }
            return res.json(buses);
        } catch (err) {
            console.error('[Error] Firestore error fetching buses:', err);
            return res.status(500).json({ error: "Failed to fetch buses" });
        }
    } else {
        res.json(loadBusesLocal(csvType));
    }
});

app.get('/api/students', authorize, async (req: Request, res: Response) => {
    const { date } = req.query;
    const info = getTimeSlotInfo();
    const timeSlot = getTimeSlot();
    const csvType = info.csvType;

    if (date) {
        const { students } = await getStudentsForSlot(timeSlot, date as string);
        const studentMap: Record<string, any> = {};
        students.forEach(s => studentMap[s.uid] = s);
        return res.json(studentMap);
    }

    if (firestore) {
        try {
            let students: Record<string, any> = {};
            const snapshot = await firestore!.collection('students').where('listType', '==', csvType).get();
            snapshot.forEach(doc => students[doc.data().uid] = doc.data());

            if (csvType === "arrival" || snapshot.empty) {
                const allDocs = await firestore!.collection('students').get();
                allDocs.forEach(doc => {
                    const data = doc.data();
                    if (!data.listType || (snapshot.empty && data.listType === "arrival")) {
                        if (!students[data.uid]) {
                            if (!data.badge) data.badge = "";
                            students[data.uid] = data;
                        }
                    }
                });
            }
            res.json(students);
        } catch (err) {
            res.status(500).json({ error: "Failed to fetch students" });
        }
    } else {
        res.json(loadStudentsLocal(csvType));
    }
});

app.get('/api/student/:uid', authorize, async (req: Request, res: Response) => {
    const uid = req.params.uid;
    const info = getTimeSlotInfo();
    const student = await findStudentData(uid, info.csvType);
    if (student) return res.json(student);
    res.status(404).json({ error: "Student not found" });
});

async function processRollCall(uid: string, providedTimestamp?: string) {
    const timestamp = providedTimestamp || new Date().toISOString();
    const dateObj = new Date(timestamp);
    const taipeiDate = new Date(dateObj.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
    const dateStr = taipeiDate.getFullYear() + '-' + String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + String(taipeiDate.getDate()).padStart(2, '0');
    const info = getTimeSlotInfo(dateObj);
    const timeSlot = getTimeSlot(dateObj);
    const csvType = info.csvType;

    const studentData = await findStudentData(uid, csvType);
    const name = studentData?.name || "Unknown Tag";
    const badge = studentData?.badge || "---";
    const bus = studentData?.bus || "Unknown";
    const isTemp = studentData?.listType === 'temporary';
    
    if (firestore) {
        try {
            await firestore!.collection('rollCalls').add({ 
                uid, name, badge, bus, timestamp, timeSlot, date: dateStr, isTemp: isTemp
            });
        } catch (err) { console.error(err); }
    } else {
        saveRollCallLocal(uid, name, badge, bus, timestamp, dateStr, timeSlot);
    }
}

app.post('/api/rollcall', authorize, async (req: Request, res: Response) => {
    const { uid, timestamp } = req.body;
    await processRollCall(uid, timestamp);
    res.json({ success: true });
});

app.post('/api/rollcall/batch', authorize, async (req: Request, res: Response) => {
    const { records } = req.body;
    if (!Array.isArray(records)) return res.status(400).json({ error: "Invalid format" });
    for (const record of records) {
        await processRollCall(record.uid, record.timestamp);
    }
    res.json({ success: true });
});

// --- Admin Photo Management ---

app.get('/api/photo/:uid', authorize, async (req: Request, res: Response) => {
    const uid = req.params.uid as string;
    const student = await findStudentData(uid);
    if (student?.photo) {
        try {
            const buffer = Buffer.from(student.photo, 'base64');
            res.setHeader('Content-Type', 'image/jpeg');
            res.setHeader('Cache-Control', 'public, max-age=86400');
            return res.send(buffer);
        } catch (err) { console.error(err); }
    }
    res.status(404).json({ error: "Photo not found" });
});

app.get('/api/admin/photos', authorize, async (req: Request, res: Response) => {
    if (firestore) {
        try {
            const snapshot = await firestore!.collection('students').orderBy('name').get();
            const photos = snapshot.docs
                .map(doc => {
                    const data = doc.data();
                    if (!data.photo) return null;
                    return { uid: data.uid, name: data.name, badge: data.badge };
                })
                .filter(p => p !== null);
            res.json(photos);
        } catch (err) { res.status(500).json({ error: "Failed to list photos" }); }
    } else {
        res.status(400).json({ error: "Firestore required" });
    }
});

app.post('/api/admin/student/photo', authorize, async (req: Request, res: Response) => {
    const { uid, photo } = req.body;
    if (!uid || !photo || !firestore) return res.status(400).json({ error: "Invalid request" });
    try {
        const snapshot = await firestore!.collection('students').where('uid', '==', uid).get();
        const batch = firestore!.batch();
        snapshot.forEach(doc => batch.update(doc.ref, { photo }));
        await batch.commit();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to save photo" }); }
});

app.delete('/api/admin/student/photo/:uid', authorize, async (req: Request, res: Response) => {
    const uid = req.params.uid;
    if (!firestore) return res.status(400).json({ error: "Firestore required" });
    try {
        const snapshot = await firestore!.collection('students').where('uid', '==', uid).get();
        const batch = firestore!.batch();
        snapshot.forEach(doc => batch.update(doc.ref, { photo: admin.firestore.FieldValue.delete() }));
        await batch.commit();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to delete" }); }
});

// --- Admin Management Endpoints ---

app.get('/api/admin/temporary-riders', authorize, async (req: Request, res: Response) => {
    if (firestore) {
        const snapshot = await firestore!.collection('temporaryRiders').get();
        res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
    } else { res.json([]); }
});

app.post('/api/admin/temporary-riders', authorize, async (req: Request, res: Response) => {
    const { date, timeSlot, bus, uid, name, badge } = req.body;
    if (!firestore) return res.status(400).json({ error: "Firestore required" });
    try {
        await firestore!.collection('temporaryRiders').add({ date, timeSlot, bus, uid, name, badge: badge || "---" });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: "Failed to add" }); }
});

app.get('/api/admin/bus-occupancy', authorize, async (req: Request, res: Response) => {
    const { date, timeSlot, bus } = req.query;
    if (!firestore || !date || !timeSlot || !bus) return res.status(400).json({ error: "Missing fields" });
    try {
        const configDoc = await firestore!.collection('config').doc(`buses_arrival`).get();
        const busList = configDoc.data()?.list || [];
        const busObj = busList.find((b: any) => (b.name || b) === bus);
        const limit = busObj?.overflow || 40;
        const students = await firestore!.collection('students').where('bus', '==', bus).get();
        const temps = await firestore!.collection('temporaryRiders').where('date', '==', date).where('timeSlot', '==', timeSlot).where('bus', '==', bus).get();
        res.json({ count: students.size + temps.size, overflowLimit: limit });
    } catch (err) { res.status(500).json({ error: "Failed to check" }); }
});

// Time Slot Config Endpoints (Standard Logic Retained)
app.get('/api/admin/config/slots', authorize, (req, res) => res.json({ slots: slotConfigs, default: defaultSlot }));
app.post('/api/admin/config/slots', authorize, (req, res) => {
    const { slots, default: newDefault } = req.body;
    slotConfigs = slots;
    if (newDefault) defaultSlot = newDefault;
    fs.writeFileSync(SLOT_CONFIG_PATH, JSON.stringify({ slots: slotConfigs, default: defaultSlot }, null, 2));
    res.json({ success: true });
});

app.post('/api/admin/config/students', authorize, async (req, res) => {
    const { students, csvType } = req.body;
    const type = csvType || "arrival";
    if (firestore) {
        for (let i = 0; i < students.length; i += 450) {
            const batch = firestore!.batch();
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
    if (firestore) await firestore!.collection('config').doc(`buses_${csvType || 'arrival'}`).set({ list: buses });
    res.json({ success: true });
});

app.post('/api/admin/config/accounts', authorize, async (req, res) => {
    const accounts = req.body;
    if (firestore) {
        const batch = firestore!.batch();
        accounts.forEach((a: any) => batch.set(firestore!.collection('accounts').doc(a.username), a));
        await batch.commit();
    }
    res.json({ success: true });
});

const SLOT_CONFIG_PATH = path.resolve(__dirname, 'slot-configs.json');
const saveSlotConfigs = () => fs.writeFileSync(SLOT_CONFIG_PATH, JSON.stringify({ slots: slotConfigs, default: defaultSlot }, null, 2));

export default app;
if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`Server on ${PORT}`));
}
