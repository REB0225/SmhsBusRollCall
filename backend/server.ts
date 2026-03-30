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

// Allow photos to be served from a custom path (e.g., a Samba mount)
const photosPath = process.env.PHOTOS_PATH ? path.resolve(process.env.PHOTOS_PATH) : path.resolve(__dirname, 'Photos');
console.log(`[System] Serving photos from: ${photosPath}`);

const app = express();
const PORT = 5001;

app.use(cors());
app.use(express.json());

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
  const token = req.headers['authorization'];
  if (token === `Bearer ${AUTH_TOKEN}`) {
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

app.get('/api/admin/temporary-riders', authorize, async (req: Request, res: Response) => {
    if (firestore) {
        const snapshot = await firestore!.collection('temporaryRiders').get();
        const riders: any[] = [];
        snapshot.forEach(doc => riders.push({ id: doc.id, ...doc.data() }));
        res.json(riders);
    } else {
        const tempPath = path.resolve(__dirname, 'temporary-riders.json');
        if (fs.existsSync(tempPath)) {
            res.json(JSON.parse(fs.readFileSync(tempPath, 'utf8')));
        } else {
            res.json([]);
        }
    }
});

app.post('/api/admin/temporary-riders', authorize, async (req: Request, res: Response) => {
    const { date, timeSlot, bus, uid, name, badge } = req.body;
    if (!date || !timeSlot || !bus || !uid || !name) return res.status(400).json({ error: "Missing fields" });

    try {
        console.log(`[Admin] Adding temp rider: ${name} (${uid}) for ${date} slot ${timeSlot}`);
        if (firestore) {
            await firestore!.collection('temporaryRiders').add({ 
                date, 
                timeSlot, 
                bus, 
                uid, 
                name, 
                badge: badge || "---",
                createdAt: new Date().toISOString()
            });
            console.log(`[Admin] Successfully saved ${uid} to Firestore 'temporaryRiders'`);
        } else {
            const tempPath = path.resolve(__dirname, 'temporary-riders.json');
            const riders = fs.existsSync(tempPath) ? JSON.parse(fs.readFileSync(tempPath, 'utf8')) : [];
            riders.push({ id: Date.now().toString(), date, timeSlot, bus, uid, name, badge: badge || "---" });
            fs.writeFileSync(tempPath, JSON.stringify(riders, null, 2), 'utf8');
            console.log(`[Admin] Successfully saved ${uid} to local JSON`);
        }
        res.json({ success: true });
    } catch (err) {
        console.error('[Error] Failed to save temporary rider:', err);
        res.status(500).json({ error: "Database error while saving temporary rider" });
    }
});

app.delete('/api/admin/temporary-riders/:id', authorize, async (req: Request, res: Response) => {
    const id = req.params.id;
    if (firestore) {
        await firestore!.collection('temporaryRiders').doc(id).delete();
    } else {
        const tempPath = path.resolve(__dirname, 'temporary-riders.json');
        if (fs.existsSync(tempPath)) {
            let riders = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
            riders = riders.filter((r: any) => r.id !== id);
            fs.writeFileSync(tempPath, JSON.stringify(riders, null, 2), 'utf8');
        }
    }
    res.json({ success: true });
});

app.get('/api/admin/bus-occupancy', authorize, async (req: Request, res: Response) => {
    const { date, timeSlot, bus } = req.query;
    if (!date || !timeSlot || !bus) return res.status(400).json({ error: "Missing fields" });

    const matchingConfig = slotConfigs.find(s => `${s.start}-${s.end}` === (timeSlot as string));
    const csvType = matchingConfig?.csvType || "arrival";

    // 1. Get bus overflow limit
    let overflowLimit = 40; // Default
    if (firestore) {
        const configDoc = await firestore!.collection('config').doc(`buses_${csvType}`).get();
        const busList: any[] = configDoc.data()?.list || [];
        const busObj = busList.find(b => (b.name || b) === (bus as string));
        if (busObj && typeof busObj === 'object') overflowLimit = busObj.overflow || 40;
    } else {
        const buses = loadBusesLocal(csvType);
        const busObj = buses.find(b => b.name === bus);
        if (busObj) overflowLimit = busObj.overflow || 40;
    }

    let count = 0;
    // 2. Regular students
    if (firestore) {
        const snapshot = await firestore!.collection('students')
            .where('listType', '==', csvType)
            .where('bus', '==', (bus as string))
            .get();
        count = snapshot.size;

        // 3. Temporary riders ADDED to this bus
        const tempIn = await firestore!.collection('temporaryRiders')
            .where('date', '==', (date as string))
            .where('timeSlot', '==', (timeSlot as string))
            .where('bus', '==', (bus as string))
            .get();
        count += tempIn.size;
    } else {
        const students = loadStudentsLocal(csvType);
        count = Object.values(students).filter(s => s.bus === bus).length;

        const tempPath = path.resolve(__dirname, 'temporary-riders.json');
        if (fs.existsSync(tempPath)) {
            const riders = JSON.parse(fs.readFileSync(tempPath, 'utf8'));
            const added = riders.filter((r: any) => r.date === date && r.timeSlot === timeSlot && r.bus === bus).length;
            count += added;
        }
    }

    res.json({ count, overflowLimit });
});

// Load slot configs from file if available
const SLOT_CONFIG_PATH = path.resolve(__dirname, 'slot-configs.json');
if (fs.existsSync(SLOT_CONFIG_PATH)) {
    try {
        const saved = JSON.parse(fs.readFileSync(SLOT_CONFIG_PATH, 'utf8'));
        slotConfigs = saved.slots || slotConfigs;
        defaultSlot = saved.default || defaultSlot;
    } catch (err) { console.error("Error loading slot-configs.json"); }
}

const saveSlotConfigs = () => {
    fs.writeFileSync(SLOT_CONFIG_PATH, JSON.stringify({ slots: slotConfigs, default: defaultSlot }, null, 2), 'utf8');
};

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

function loadBusesLocal(type: string): { name: string, overflow: number }[] {
    const filename = type === "arrival" ? 'current-bus.csv' : `current-bus_${type}.csv`;
    let busFilePath = path.resolve(__dirname, filename);
    if (!fs.existsSync(busFilePath)) busFilePath = path.resolve(__dirname, 'current-bus.csv');

    if (fs.existsSync(busFilePath)) {
        const fileContent = fs.readFileSync(busFilePath, { encoding: 'utf-8' });
        const records: any[] = parse(fileContent, { columns: true, skip_empty_lines: true, trim: true, bom: true, relax_column_count: true });
        return records.map(r => ({
            name: (r.bus || r.name || Object.values(r)[0]) as string,
            overflow: parseInt(r.overflow) || 40
        })).filter(b => b.name);
    }
    return [];
}

app.get('/api/buses', authorize, async (req: Request, res: Response) => {
    const info = getTimeSlotInfo();
    const csvType = info.csvType;
    console.log(`[Buses] Fetching for csvType: ${csvType}`);

    if (firestore) {
        try {
            const configDoc = await firestore!.collection('config').doc(`buses_${csvType}`).get();
            let buses = configDoc.data()?.list || [];
            console.log(`[Buses] Primary fetch (buses_${csvType}): Found ${buses.length}`);

            // Always fallback if empty, regardless of csvType
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
        const localBuses = loadBusesLocal(csvType);
        console.log(`[Buses] Local fetch: Found ${localBuses.length}`);
        res.json(localBuses);
    }
});

app.get('/api/students', authorize, async (req: Request, res: Response) => {
    const { date } = req.query;
    const info = getTimeSlotInfo();
    const timeSlot = getTimeSlot();
    const csvType = info.csvType;

    if (date) {
        console.log(`[Students] Fetching for Date: ${date}, Slot: ${timeSlot}`);
        const { students } = await getStudentsForSlot(timeSlot, date as string);
        console.log(`[Students] Helper returned ${students.length} students`);
        const studentMap: Record<string, any> = {};
        students.forEach(s => studentMap[s.uid] = s);
        return res.json(studentMap);
    }

    console.log(`[Students] Fetching for csvType: ${csvType} (No date provided)`);
    if (firestore) {
        try {
            let students: Record<string, any> = {};
            
            // 1. Try to fetch students for this specific slot
            const snapshot = await firestore!.collection('students').where('listType', '==', csvType).get();
            snapshot.forEach(doc => students[doc.data().uid] = doc.data());
            console.log(`[Students] Primary fetch (${csvType}): Found ${snapshot.size}`);

            // 2. Legacy fallback
            if (csvType === "arrival" || snapshot.empty) {
                const allDocs = await firestore!.collection('students').get();
                let legacyCount = 0;
                allDocs.forEach(doc => {
                    const data = doc.data();
                    if (!data.listType || (snapshot.empty && data.listType === "arrival")) {
                        if (!students[data.uid]) {
                            // Ensure badge exists
                            if (!data.badge) data.badge = "";
                            students[data.uid] = data;
                            legacyCount++;
                        }
                    }
                });
                console.log(`[Students] Legacy/Fallback fetch: Added ${legacyCount} students`);
            }
            res.json(students);
        } catch (err) {
            console.error('[Error] Firestore error fetching students:', err);
            res.status(500).json({ error: "Failed to fetch students" });
        }
    } else {
        const localStudents = loadStudentsLocal(csvType);
        console.log(`[Students] Local fetch: Found ${Object.keys(localStudents).length}`);
        res.json(localStudents);
    }
});

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
    const dateStr = taipeiDate.getFullYear() + '-' + 
                   String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + 
                   String(taipeiDate.getDate()).padStart(2, '0');

    const info = getTimeSlotInfo(dateObj);
    const timeSlot = getTimeSlot(dateObj);
    const csvType = info.csvType;

    console.log(`[RollCall] Processing scan: UID=${uid}, Slot=${timeSlot}, Date=${dateStr}`);

    // findStudentData now handles tempRider check internally
    const studentData = await findStudentData(uid, csvType);

    const name = studentData?.name || "Unknown Tag";
    const badge = studentData?.badge || "---";
    const bus = studentData?.bus || "Unknown";
    const isTemp = studentData?.listType === 'temporary';
    
    console.log(`[RollCall] Identity Resolved: ${name} (Bus: ${bus}, Temp: ${isTemp})`);

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
    res.json({ success: true, message: "Roll call recorded" });
});

app.post('/api/rollcall/batch', authorize, async (req: Request, res: Response) => {
    const { records } = req.body;
    if (!Array.isArray(records)) return res.status(400).json({ error: "Invalid format. Expected 'records' array." });
    
    for (const record of records) {
        const { uid, timestamp } = record;
        await processRollCall(uid, timestamp);
    }
    res.json({ success: true, message: `Recorded ${records.length} roll calls` });
});

app.get('/api/admin/rollcall-week', authorize, async (req: Request, res: Response) => {
    const { startDate, endDate } = req.query;
    
    if (!startDate || !endDate) {
        return res.status(400).json({ error: "StartDate and EndDate are required" });
    }

    // Get all unique time slots from config
    const timeSlots = [...new Set(slotConfigs.map(s => `${s.start}-${s.end}`))];
    if (!timeSlots.includes(defaultSlot.label)) {
        timeSlots.push(defaultSlot.label);
    }

    try {
        const results: Record<string, any> = {};

        // 1. Fetch all unique student lists needed for the slots
        const slotDataMap: Record<string, { students: any[], csvType: string }> = {};
        for (const slot of timeSlots) {
            slotDataMap[slot] = await getStudentsForSlot(slot);
        }

        // 2. Fetch all roll calls in the date range
        let allRollCalls: any[] = [];
        if (firestore) {
            const snapshot = await firestore!.collection('rollCalls')
                .where('date', '>=', (startDate as string))
                .where('date', '<=', (endDate as string))
                .get();
            snapshot.forEach(doc => allRollCalls.push(doc.data()));
        } else {
            const rollCallPath = path.resolve(__dirname, 'roll-call.csv');
            if (fs.existsSync(rollCallPath)) {
                const fileContent = fs.readFileSync(rollCallPath, { encoding: 'utf-8' });
                const records: any[] = parse(fileContent, { columns: true, skip_empty_lines: true, trim: true, bom: true });
                allRollCalls = records.filter(r => r.date >= startDate && r.date <= endDate);
            }
        }

        // 3. Group roll calls by date and slot
        const rollCallGroups: Record<string, Record<string, Record<string, any>>> = {};
        allRollCalls.forEach(rc => {
            if (!rollCallGroups[rc.date]) rollCallGroups[rc.date] = {};
            if (!rollCallGroups[rc.date][rc.timeSlot]) rollCallGroups[rc.date][rc.timeSlot] = {};
            rollCallGroups[rc.date][rc.timeSlot][rc.uid] = rc;
        });

        // 4. Generate CSV data for each date and slot
        const dates: string[] = [];
        let curr = new Date(startDate as string);
        const end = new Date(endDate as string);
        while (curr <= end) {
            dates.push(curr.toISOString().split('T')[0]);
            curr.setDate(curr.getDate() + 1);
        }

        const files: Record<string, string> = {};
        const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        const allSlotsToProcess = [
            ...slotConfigs.map(s => ({ ...s, isDefault: false })),
            { ...defaultSlot, start: "00:00", end: "23:59", isDefault: true, label: "Not in time" }
        ];

        for (const slotConfig of allSlotsToProcess) {
            const slotLabel = slotConfig.isDefault ? slotConfig.label : `${slotConfig.start}-${slotConfig.end}`;
            
            // Determine which dates in the range match this slot's day requirements
            const applicableDates = dates.filter(dateStr => {
                if (slotConfig.isDefault) return true; // Default slot applies to all days
                const d = new Date(dateStr).getDay();
                if (slotConfig.day !== undefined) return slotConfig.day === d;
                if (slotConfig.days !== undefined) return slotConfig.days.includes(d);
                return true; // General slot
            });

            if (applicableDates.length === 0) continue;

            // Get Master Students for this slot (Global baseline)
            const { students: baseStudents } = await getStudentsForSlot(slotLabel);

            // Header: UID, Name, Badge, Bus, Date1, Date2...
            let csv = '\ufeffuid,name,badge,bus';
            applicableDates.forEach(d => {
                const dateObj = new Date(d);
                csv += `,"${dayNames[dateObj.getDay()]} (${d})"`;
            });
            csv += '\n';

            // Track a union of all students (base + any temps appearing on any of the applicable dates)
            const masterStudentMap = new Map<string, any>(baseStudents.map(s => [s.uid, s]));
            
            // Collect any temp riders on any of the applicable dates to ensure they have a row
            for (const date of applicableDates) {
                const { students: dailyStudents } = await getStudentsForSlot(slotLabel, date);
                dailyStudents.forEach(s => {
                    if (!masterStudentMap.has(s.uid)) {
                        masterStudentMap.set(s.uid, s);
                    }
                });
            }

            const processedUids = new Set<string>();

            // Add All Master Students (Base + Temps)
            masterStudentMap.forEach(s => {
                let row = `"${s.uid}","${s.name}","${s.badge}"`;
                let hasAnyData = false;
                
                // For 'Bus' column in consolidated view, we use their BASE bus 
                // BUT for temporary riders we might want to show their override if they are primarily a temp for this slot.
                let busForThisRow = s.bus || "Unknown";
                let rowValues = "";

                applicableDates.forEach(date => {
                    const group = rollCallGroups[date];
                    const labelsToCheck = slotConfig.isDefault ? [slotLabel, defaultSlot.label] : [slotLabel];
                    let studentInSlot: any = null;
                    labelsToCheck.forEach(label => {
                        const subGroup = group ? group[label] : null;
                        if (subGroup && subGroup[s.uid]) studentInSlot = subGroup[s.uid];
                    });

                    const timestamp = studentInSlot ? (studentInSlot.timestamp.includes('T') ? new Date(studentInSlot.timestamp).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' }) : studentInSlot.timestamp) : "";
                    if (timestamp) {
                        hasAnyData = true;
                        busForThisRow = studentInSlot.bus; // Use the bus they actually scanned for
                    }
                    rowValues += `,"${timestamp}"`;
                });
                
                row = `"${s.uid}","${s.name}","${s.badge}","${busForThisRow}"` + rowValues;

                // For default slot, only include students who actually scanned 'not in time'
                if (!slotConfig.isDefault || hasAnyData) {
                    csv += row + '\n';
                    processedUids.add(s.uid);
                }
            });

            // Add any extra students who were scanned but not in ANY master or temp list (Unknown Tags)
            const extras = new Set<string>();
            applicableDates.forEach(date => {
                const group = rollCallGroups[date] || {};
                const labelsToCheck = slotConfig.isDefault ? [slotLabel, defaultSlot.label] : [slotLabel];
                labelsToCheck.forEach(label => {
                    const subGroup = group[label] || {};
                    Object.keys(subGroup).forEach(uid => {
                        if (!processedUids.has(uid)) extras.add(uid);
                    });
                });
            });

            extras.forEach(uid => {
                let info: any = null;
                applicableDates.forEach(date => {
                    const group = rollCallGroups[date] || {};
                    const labelsToCheck = slotConfig.isDefault ? [slotLabel, defaultSlot.label] : [slotLabel];
                    labelsToCheck.forEach(label => {
                        if (group[label] && group[label][uid]) info = group[label][uid];
                    });
                });

                if (info) {
                    let row = `"${uid}","${info.name}","${info.badge}","${info.bus}"`;
                    applicableDates.forEach(date => {
                        const group = rollCallGroups[date] || {};
                        const labelsToCheck = slotConfig.isDefault ? [slotLabel, defaultSlot.label] : [slotLabel];
                        let studentInSlot: any = null;
                        labelsToCheck.forEach(label => {
                            if (group[label] && group[label][uid]) studentInSlot = group[label][uid];
                        });
                        const timestamp = studentInSlot ? (studentInSlot.timestamp.includes('T') ? new Date(studentInSlot.timestamp).toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false, hour: '2-digit', minute: '2-digit' }) : studentInSlot.timestamp) : "";
                        row += `,"${timestamp}"`;
                    });
                    csv += row + '\n';
                }
            });

            const rowCount = csv.split('\n').length - 2;
            if (rowCount > 0 || !slotConfig.isDefault) {
                const safeLabel = slotConfig.label.replace(/[^a-z0-9]/gi, '_');
                files[`${safeLabel}_${startDate}_to_${endDate}.csv`] = csv;
            }
        }

        res.json({ files });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/api/admin/rollcall-csv', authorize, async (req: Request, res: Response) => {
    const { date, timeSlot } = req.query;
    
    if (!date || !timeSlot) {
        return res.status(400).json({ error: "Date and TimeSlot are required" });
    }

    const { students } = await getStudentsForSlot(timeSlot as string, date as string);

    if (firestore) {
        // Fetch roll call records for the given date and time slot
        const snapshot = await firestore!.collection('rollCalls')
            .where('date', '==', date)
            .where('timeSlot', '==', timeSlot)
            .get();
            
        const calledMap: Record<string, any> = {};
        snapshot.forEach(doc => {
            const data = doc.data();
            calledMap[data.uid] = data;
        });

        let csv = '\ufefftimestamp,uid,name,badge,bus,status\n';
        const processedUids = new Set<string>();

        // Add all master students (which now includes daily overrides/temps)
        students.forEach(s => {
            const calledData = calledMap[s.uid];
            const localTime = calledData ? new Date(calledData.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : "";
            const status = calledData ? "registered" : "";
            csv += `"${localTime}","${s.uid}","${s.name}","${s.badge}","${s.bus || ""}","${status}"\n`;
            processedUids.add(s.uid);
        });

        // Add any students who were called but not in the daily student list (Unknown Tags)
        Object.values(calledMap).forEach(data => {
            if (!processedUids.has(data.uid)) {
                const localTime = new Date(data.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
                csv += `"${localTime}","${data.uid}","${data.name}","${data.badge}","${data.bus}","registered"\n`;
            }
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=roll-call-${date}-${timeSlot}.csv`);
        res.send(csv);
    } else {
        const rollCallPath = path.resolve(__dirname, 'roll-call.csv');
        const calledMap: Record<string, any> = {};

        if (fs.existsSync(rollCallPath)) {
            const fileContent = fs.readFileSync(rollCallPath, { encoding: 'utf-8' });
            const records: any[] = parse(fileContent, { columns: true, skip_empty_lines: true, trim: true, bom: true });
            
            const filtered = records.filter(r => r.date === date && r.timeSlot === timeSlot);
            filtered.forEach(r => {
                calledMap[r.uid] = r;
            });
        }

        let csv = '\ufefftimestamp,uid,name,badge,bus,status\n';
        const processedUids = new Set<string>();

        // Add all master students (which now includes daily overrides/temps)
        students.forEach(s => {
            const calledData = calledMap[s.uid];
            const timestamp = calledData ? calledData.timestamp : "";
            const status = calledData ? "registered" : "";
            csv += `"${timestamp}","${s.uid}","${s.name}","${s.badge}","${s.bus || ""}","${status}"\n`;
            processedUids.add(s.uid);
        });

        // Add any students who were called but not in the daily student list
        Object.values(calledMap).forEach(r => {
            if (!processedUids.has(r.uid)) {
                csv += `"${r.timestamp}","${r.uid}","${r.name}","${r.badge}","${r.bus}","registered"\n`;
            }
        });

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=roll-call-${date}-${timeSlot}.csv`);
        res.send(csv);
    }
});

app.get('/api/admin/accounts', authorize, async (req: Request, res: Response) => {
    if (firestore) {
        const snapshot = await firestore!.collection('accounts').get();
        const accounts: any[] = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            accounts.push({ username: doc.id, ...data });
        });
        res.json(accounts);
    } else {
        const accountsPath = path.resolve(__dirname, 'accounts.json');
        if (fs.existsSync(accountsPath)) {
            const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
            res.json(accounts);
        } else {
            res.json([]);
        }
    }
});

// Admin Configuration Endpoints

app.get('/api/admin/config/slots', authorize, (req: Request, res: Response) => {
    res.json({ slots: slotConfigs, default: defaultSlot });
});

app.post('/api/admin/config/slots', authorize, (req: Request, res: Response) => {
    const { slots, default: newDefault } = req.body;
    if (!Array.isArray(slots)) return res.status(400).json({ error: "Invalid format" });
    
    // Server-side overlap check
    for (let i = 0; i < slots.length; i++) {
        for (let j = i + 1; j < slots.length; j++) {
            const s1 = slots[i];
            const s2 = slots[j];
            
            // Check if days overlap
            let daysOverlap = false;
            if (s1.day === undefined && s1.days === undefined && s2.day === undefined && s2.days === undefined) daysOverlap = true;
            else {
                const d1 = s1.day !== undefined ? [s1.day] : (s1.days || [0,1,2,3,4,5,6]);
                const d2 = s2.day !== undefined ? [s2.day] : (s2.days || [0,1,2,3,4,5,6]);
                daysOverlap = d1.some((d: number) => d2.includes(d));
            }

            if (daysOverlap) {
                // Check if times overlap
                if (s1.start < s2.end && s2.start < s1.end) {
                    return res.status(400).json({ error: `Overlap detected between ${s1.label} and ${s2.label}` });
                }
            }
        }
    }

    slotConfigs = slots;
    if (newDefault) defaultSlot = newDefault;
    saveSlotConfigs();
    res.json({ success: true });
});

app.post('/api/admin/config/students', authorize, async (req: Request, res: Response) => {
    try {
        const { students, csvType } = req.body;
        if (!Array.isArray(students)) return res.status(400).json({ error: "Invalid format. Expected array." });
        const type = csvType || "arrival";

        if (firestore) {
            // Fetch students belonging to this specific list type
            const snapshot = await firestore!.collection('students').where('listType', '==', type).get();
            const existingDocs = snapshot.docs;
            const newDocIds = new Set(students.map((s: any) => `${s.uid}_${type}`));

            // Add or Update students in this specific list
            for (let i = 0; i < students.length; i += 450) {
                const batch = firestore!.batch();
                const chunk = students.slice(i, i + 450);
                chunk.forEach((s: any) => {
                    if (s.uid) {
                        const docId = `${s.uid}_${type}`;
                        batch.set(firestore!.collection('students').doc(docId), { ...s, listType: type });
                    }
                });
                await batch.commit();
            }

            // Delete students that are no longer in this specific list
            const toDelete = existingDocs.filter(doc => !newDocIds.has(doc.id));
            for (let i = 0; i < toDelete.length; i += 450) {
                const batch = firestore!.batch();
                const chunk = toDelete.slice(i, i + 450);
                chunk.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            }
        } else {
            const filename = type === "arrival" ? 'students.csv' : `students_${type}.csv`;
            const studentsPath = path.resolve(__dirname, filename);
            let csv = '\ufeffuid,name,badge,bus\n';
            students.forEach(s => {
                csv += `"${s.uid}","${s.name}","${s.badge}","${s.bus || ""}"\n`;
            });
            fs.writeFileSync(studentsPath, csv, 'utf8');
            
            if (type === "arrival") {
                 fs.writeFileSync(path.resolve(__dirname, 'students.csv'), csv, 'utf8');
            }
        }
        res.json({ success: true, message: `Successfully updated ${students.length} students for ${type}` });
    } catch (err) {
        console.error('[Error] Failed to update students config:', err);
        res.status(500).json({ error: "Internal server error while updating students" });
    }
});

app.post('/api/admin/config/buses', authorize, async (req: Request, res: Response) => {
    try {
        const { buses, csvType } = req.body;
        if (!Array.isArray(buses)) return res.status(400).json({ error: "Invalid format. Expected array of objects." });
        const type = csvType || "arrival";

        if (firestore) {
            await firestore!.collection('config').doc(`buses_${type}`).set({ list: buses });
            if (type === "arrival") {
                await firestore!.collection('config').doc('buses').set({ list: buses });
            }
        } else {
            const filename = type === "arrival" ? 'current-bus.csv' : `current-bus_${type}.csv`;
            const busFilePath = path.resolve(__dirname, filename);
            let csv = '\ufeffbus,overflow\n';
            buses.forEach(b => {
                const name = typeof b === 'string' ? b : b.name;
                const overflow = typeof b === 'string' ? 40 : (b.overflow || 40);
                csv += `"${name}","${overflow}"\n`;
            });
            fs.writeFileSync(busFilePath, csv, 'utf8');
            if (type === "arrival") {
                fs.writeFileSync(path.resolve(__dirname, 'current-bus.csv'), csv, 'utf8');
            }
        }
        res.json({ success: true, message: `Successfully updated ${buses.length} buses for ${type}` });
    } catch (err) {
        console.error('[Error] Failed to update buses config:', err);
        res.status(500).json({ error: "Internal server error while updating buses" });
    }
});

app.post('/api/admin/config/accounts', authorize, async (req: Request, res: Response) => {
    try {
        const accounts: any[] = req.body;
        if (!Array.isArray(accounts)) return res.status(400).json({ error: "Invalid format. Expected array." });

        // Ensure all accounts have a type, defaulting to 'user'
        const processedAccounts = accounts.map(a => ({
            ...a,
            type: a.type || 'user'
        }));

        if (firestore) {
            const snapshot = await firestore!.collection('accounts').get();
            const existingDocs = snapshot.docs;
            const newUsernames = new Set(processedAccounts.map((a: any) => a.username));

            // Update or Set new accounts in batches of 450
            for (let i = 0; i < processedAccounts.length; i += 450) {
                const batch = firestore!.batch();
                const chunk = processedAccounts.slice(i, i + 450);
                chunk.forEach((acc: any) => {
                    if (acc.username) {
                        batch.set(firestore!.collection('accounts').doc(acc.username), acc);
                    }
                });
                await batch.commit();
            }

            // Delete accounts that are no longer in the list in batches of 450
            const toDelete = existingDocs.filter(doc => !newUsernames.has(doc.id));
            for (let i = 0; i < toDelete.length; i += 450) {
                const batch = firestore!.batch();
                const chunk = toDelete.slice(i, i + 450);
                chunk.forEach(doc => batch.delete(doc.ref));
                await batch.commit();
            }
        } else {
            const accountsPath = path.resolve(__dirname, 'accounts.json');
            fs.writeFileSync(accountsPath, JSON.stringify(processedAccounts, null, 2), 'utf8');
        }
        res.json({ success: true, message: `Successfully updated ${processedAccounts.length} accounts` });
    } catch (err) {
        console.error('[Error] Failed to update accounts config:', err);
        res.status(500).json({ error: "Internal server error while updating accounts" });
    }
});

// --- Google Drive Service Account Auth ---
let driveTokenCache: { token: string, expiry: number } | null = null;

async function getDriveAccessToken() {
    // Return cached token if valid (with 5 min buffer)
    if (driveTokenCache && driveTokenCache.expiry > Date.now() + 300000) {
        return driveTokenCache.token;
    }

    if (!serviceAccount) return null;

    try {
        // Use the parsed serviceAccount object
        const tokenResponse = await admin.credential.cert(serviceAccount).getAccessToken();
        
        driveTokenCache = {
            token: tokenResponse.access_token,
            expiry: Date.now() + 3600000 // Tokens are usually valid for 1 hour
        };
        return tokenResponse.access_token;
    } catch (err) {
        console.error("[Auth] Failed to get Drive Access Token:", err);
        return null;
    }
}

app.get('/api/photo/:uid', authorize, async (req: Request, res: Response) => {
    const uid = req.params.uid as string;
    const student = await findStudentData(uid);
    const badge = student?.badge;

    if (!badge) {
        return res.status(404).json({ error: "Student badge not found" });
    }

    const gdriveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
    const accessToken = await getDriveAccessToken();

    if (!gdriveFolderId || !accessToken) {
        console.error("[GDrive] Missing configuration or auth token");
        return res.status(500).json({ error: "Server photo configuration error" });
    }

    const filename = `${badge}.jpg`;

    try {
        console.log(`[GDrive] Searching for ${filename} (Private Access)...`);
        
        const query = encodeURIComponent(`name='${filename}' and '${gdriveFolderId}' in parents and trashed=false`);
        const searchUrl = `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id)`;
        
        const searchRes = await fetch(searchUrl, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const searchData: any = await searchRes.json();

        if (searchData.files && searchData.files.length > 0) {
            const fileId = searchData.files[0].id;
            
            const downloadUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
            const downloadRes = await fetch(downloadUrl, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            
            if (downloadRes.ok) {
                const arrayBuffer = await downloadRes.arrayBuffer();
                res.setHeader('Content-Type', 'image/jpeg');
                res.setHeader('Cache-Control', 'public, max-age=3600');
                return res.send(Buffer.from(arrayBuffer));
            }
        }
        
        res.status(404).json({ error: "Photo not found in Drive" });
    } catch (err) {
        console.error(`[GDrive] API Error:`, err);
        res.status(500).json({ error: "Error communicating with Google Drive" });
    }
});

app.use('/photos', authorize, express.static(photosPath));

export default app;

if (process.env.NODE_ENV !== 'production' || !process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}
