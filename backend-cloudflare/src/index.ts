import { Hono } from 'hono';
import { cors } from 'hono/cors';

type Bindings = {
  DB: D1Database;
  ADMIN_TOKEN: string;
  USER_TOKEN: string;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use('*', cors());

const authorize = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  const queryToken = c.req.query('token');
  const token = (authHeader && authHeader.startsWith('Bearer ')) 
    ? authHeader.substring(7) 
    : queryToken;
  
  if (token === c.env.ADMIN_TOKEN || token === c.env.USER_TOKEN) {
    await next();
  } else {
    return c.json({ error: "Unauthorized" }, 401);
  }
};

const authorizeAdmin = async (c: any, next: any) => {
  const authHeader = c.req.header('Authorization');
  const queryToken = c.req.query('token');
  const token = (authHeader && authHeader.startsWith('Bearer ')) 
    ? authHeader.substring(7) 
    : queryToken;
  
  if (token === c.env.ADMIN_TOKEN) {
    await next();
  } else {
    return c.json({ error: "Forbidden: Admin access required" }, 403);
  }
};

// --- Helpers ---

const getSlotConfigs = async (db: D1Database) => {
  const slots = await db.prepare("SELECT value FROM config WHERE key = 'slots'").first<string>("value");
  const defaultSlot = await db.prepare("SELECT value FROM config WHERE key = 'default_slot'").first<string>("value");
  return {
    slots: slots ? JSON.parse(slots) : [],
    default: defaultSlot ? JSON.parse(defaultSlot) : { csvType: "arrival", label: "不在時段內" }
  };
};

const getTimeSlotInfo = (slots: any[], defaultSlot: any, dateObj: Date = new Date()) => {
  const taipeiTime = new Date(dateObj.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const currentTimeStr = `${taipeiTime.getHours().toString().padStart(2, '0')}:${taipeiTime.getMinutes().toString().padStart(2, '0')}`;
  const day = taipeiTime.getDay();

  const matches = slots.filter((s: any) => {
    const matchDay = (s.day === undefined && s.days === undefined) || 
                    (s.day !== undefined && s.day === day) || 
                    (s.days !== undefined && s.days.includes(day));
    return matchDay && currentTimeStr >= s.start && currentTimeStr < s.end;
  });

  if (matches.length === 0) {
    return { ...defaultSlot, start: "00:00", end: "23:59" };
  }

  return matches.sort((a: any, b: any) => {
    const aTemp = !!a.isTemp;
    const bTemp = !!b.isTemp;
    if (aTemp && !bTemp) return -1;
    if (!aTemp && bTemp) return 1;

    const aSpecific = a.day !== undefined || a.days !== undefined;
    const bSpecific = b.day !== undefined || b.days !== undefined;
    if (aSpecific && !bSpecific) return -1;
    if (!aSpecific && bSpecific) return 1;

    return 0;
  })[0];
};

const getTimeSlot = (slots: any[], defaultSlot: any, dateObj: Date = new Date()) => {
  const info = getTimeSlotInfo(slots, defaultSlot, dateObj);
  return info.label === defaultSlot.label ? defaultSlot.label : `${info.start}-${info.end}`;
};

// --- Endpoints ---

app.post('/api/login', async (c) => {
  const { username, password } = await c.req.json();
  if (!username || !password) return c.json({ error: "Username and password required" }, 400);

  const user = await c.env.DB.prepare("SELECT * FROM accounts WHERE username = ?").bind(username).first<any>();
  
  if (user && user.password === password) {
    const isAdmin = (user.type === 'admin' || username === 'admin');
    const token = isAdmin ? c.env.ADMIN_TOKEN : c.env.USER_TOKEN; // ← fix this line
    return c.json({ token, user: { name: user.name, username, type: isAdmin ? 'admin' : 'user' } });
  }
  
  return c.json({ error: "Invalid credentials" }, 401);
});

app.get('/api/buses', authorize, async (c) => {
  const { slots, default: defaultSlot } = await getSlotConfigs(c.env.DB);
  const queryCsvType = c.req.query('csvType');
  const info = getTimeSlotInfo(slots, defaultSlot);
  
  const csvType = queryCsvType || info.csvType;
  const configKey = `buses_${csvType}`;
  let busesJson = await c.env.DB.prepare("SELECT value FROM config WHERE key = ?").bind(configKey).first<string>("value");
  
  if (!busesJson) {
    busesJson = await c.env.DB.prepare("SELECT value FROM config WHERE key = 'buses'").first<string>("value");
  }
  
  return c.json(busesJson ? JSON.parse(busesJson) : []);
});

app.get('/api/students', authorize, async (c) => {
  const queryDate = c.req.query('date');
  const queryCsvType = c.req.query('csvType');
  const now = new Date();
  const taipeiDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const currentDateStr = taipeiDate.getFullYear() + '-' + String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + String(taipeiDate.getDate()).padStart(2, '0');
  
  const targetDateStr = queryDate || currentDateStr;
  const { slots, default: defaultSlot } = await getSlotConfigs(c.env.DB);
  const timeSlot = getTimeSlot(slots, defaultSlot, now);
  const info = getTimeSlotInfo(slots, defaultSlot, now);
  const activeCsvType = queryCsvType || info.csvType;

  const students: Record<string, any> = {};

  // 1. Fetch Students strictly for the active slot type
  const { results: studentList } = await c.env.DB.prepare("SELECT uid, name, badge, class, bus, listType FROM students WHERE listType = ?").bind(activeCsvType).all<any>();
  studentList.forEach(s => {
    students[s.uid] = s;
  });

  // 2. Fetch Temporary Riders (Override/Add for this specific trip)
  const { results: temps } = await c.env.DB.prepare("SELECT * FROM temporary_riders WHERE date = ? AND timeSlot = ?")
    .bind(targetDateStr, timeSlot)
    .all<any>();
  
  temps.forEach(t => {
    students[t.uid] = { ...t, listType: 'temporary', isTemporary: true };
  });

  return c.json(students);
});

app.get('/api/admin/config/slots', authorizeAdmin, async (c) => {
  const configs = await getSlotConfigs(c.env.DB);
  return c.json(configs);
});

app.post('/api/admin/config/slots', authorizeAdmin, async (c) => {
  const { slots, default: newDefault } = await c.req.json();
  await c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('slots', ?)").bind(JSON.stringify(slots)).run();
  if (newDefault) {
    await c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('default_slot', ?)").bind(JSON.stringify(newDefault)).run();
  }
  return c.json({ success: true });
});

app.get('/api/admin/accounts', authorizeAdmin, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM accounts").all();
  return c.json(results);
});

app.post('/api/admin/config/accounts', authorizeAdmin, async (c) => {
  const adminUser = c.req.header('x-admin-username');
  const accountsIn = await c.req.json();
  if (!Array.isArray(accountsIn)) return c.json({ error: "Invalid data format" }, 400);

  // Use a transaction for account sync
  const queries = [];
  
  // Get existing usernames to handle deletions
  const { results: existing } = await c.env.DB.prepare("SELECT username FROM accounts").all<any>();
  const existingUsernames = existing.map(u => u.username);
  const newUsernames = accountsIn.map((a: any) => a.username).filter(Boolean);
  
  const toDelete = existingUsernames.filter(u => !newUsernames.includes(u) && u !== adminUser && u !== 'admin');
  toDelete.forEach(u => {
    queries.push(c.env.DB.prepare("DELETE FROM accounts WHERE username = ?").bind(u));
  });

  accountsIn.forEach((a: any) => {
    const { username, password, type, name } = a;
    if (username) {
        let finalType = type;
        if (username === adminUser || username === 'admin') finalType = 'admin';
        queries.push(c.env.DB.prepare("INSERT OR REPLACE INTO accounts (username, password, type, name) VALUES (?, ?, ?, ?)")
            .bind(username, password, finalType, name));
    }
  });

  await c.env.DB.batch(queries);
  return c.json({ success: true });
});

app.get('/api/admin/temporary-riders', authorizeAdmin, async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM temporary_riders").all();
  return c.json(results);
});

app.post('/api/admin/temporary-riders', authorizeAdmin, async (c) => {
  const { date, timeSlot, bus, uid, name, badge, class: studentClass } = await c.req.json();
  await c.env.DB.prepare("INSERT INTO temporary_riders (date, timeSlot, bus, uid, name, badge, class) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(date, timeSlot, bus, uid, name, badge || "---", studentClass || "")
    .run();
  return c.json({ success: true });
});

app.delete('/api/admin/temporary-riders/:id', authorizeAdmin, async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare("DELETE FROM temporary_riders WHERE id = ?").bind(id).run();
  return c.json({ success: true });
});

app.get('/api/admin/bus-occupancy', authorizeAdmin, async (c) => {
  const { date, timeSlot, bus } = c.req.query();
  if (!date || !timeSlot || !bus) return c.json({ error: "Missing fields" }, 400);

  const { slots, default: defaultSlot } = await getSlotConfigs(c.env.DB);
  const matchingConfig = slots.find((s: any) => `${s.start}-${s.end}` === timeSlot) || slots.find((s: any) => s.label === timeSlot);
  const csvType = matchingConfig?.csvType || "arrival";

  // Get bus limit
  const configKey = `buses_${csvType}`;
  let busesJson = await c.env.DB.prepare("SELECT value FROM config WHERE key = ?").bind(configKey).first<string>("value");
  if (!busesJson) busesJson = await c.env.DB.prepare("SELECT value FROM config WHERE key = 'buses'").first<string>("value");
  
  const busList = busesJson ? JSON.parse(busesJson) : [];
  const busObj = busList.find((b: any) => (b.name || b.bus) === bus);
  const limit = busObj?.overflow || 40;

  // Count assigned students
  const { results: students } = await c.env.DB.prepare("SELECT bus FROM students WHERE listType = ?").bind(csvType).all<any>();
  let count = 0;
  students.forEach(s => {
    if (s.bus) {
      const buses = s.bus.split('/').map((b: string) => b.trim());
      if (buses.includes(bus)) count++;
    }
  });

  // Count temporary riders
  const tempCountResult = await c.env.DB.prepare("SELECT COUNT(*) as count FROM temporary_riders WHERE date = ? AND timeSlot = ? AND bus = ?")
    .bind(date, timeSlot, bus)
    .first<any>();
  
  return c.json({ count: count + (tempCountResult?.count || 0), overflowLimit: limit });
});

app.get('/api/admin/rollcall-csv', authorizeAdmin, async (c) => {
    const { date, timeSlot } = c.req.query();
    if (!date || !timeSlot) return c.json({ error: "Missing date or slot" }, 400);

    const { slots, default: defaultSlot } = await getSlotConfigs(c.env.DB);
    const matchingConfig = slots.find((s: any) => `${s.start}-${s.end}` === timeSlot) || slots.find((s: any) => s.label === timeSlot);
    const csvType = matchingConfig?.csvType || "arrival";

    const { results: students } = await c.env.DB.prepare("SELECT uid, name, badge, class, bus FROM students WHERE listType = ?").bind(csvType).all<any>();
    const { results: records } = await c.env.DB.prepare("SELECT * FROM rollcalls WHERE date = ? AND timeSlot = ?")
        .bind(date, timeSlot)
        .all<any>();
    
    let csv = '\uFEFFuid,name,badge,class,assigned_bus,status,timestamp\n';
    students.forEach((s: any) => {
        const record = records.find(r => r.uid === s.uid);
        const status = record ? '已簽到' : '未到';
        const time = record ? new Date(record.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '---';
        csv += `${s.uid},${s.name},${s.badge},${s.class || ''},"${s.bus || ''}",${status},${time}\n`;
    });

    // Add extra records
    records.forEach(r => {
        if (!students.some((s: any) => s.uid === r.uid)) {
            const time = new Date(r.timestamp).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
            csv += `${r.uid},未知/臨時,,,,,已簽到,${time}\n`;
        }
    });

    return new Response(csv, {
        headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="rollcall-${date}.csv"`
        }
    });
});

app.get('/api/admin/rollcall-week', authorizeAdmin, async (c) => {
    const { startDate, endDate } = c.req.query();
    if (!startDate || !endDate) return c.json({ error: "Missing date range" }, 400);

    const { slots, default: defaultSlot } = await getSlotConfigs(c.env.DB);
    const start = new Date(startDate);
    const end = new Date(endDate);
    const files: Record<string, string> = {};

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dateStr = d.toISOString().split('T')[0];
        const dayOfWeek = d.getDay();
        
        const relevantSlots = slots.filter((s: any) => {
            return (s.day === undefined && s.days === undefined) || 
                   (s.day !== undefined && s.day === dayOfWeek) || 
                   (s.days !== undefined && s.days.includes(dayOfWeek));
        });

        for (const slot of relevantSlots) {
            const slotLabel = `${slot.start}-${slot.end}`;
            const csvType = slot.csvType || "arrival";
            
            const { results: students } = await c.env.DB.prepare("SELECT uid, name, badge, class, bus FROM students WHERE listType = ?").bind(csvType).all<any>();
            const { results: records } = await c.env.DB.prepare("SELECT * FROM rollcalls WHERE date = ? AND timeSlot = ?")
                .bind(dateStr, slotLabel)
                .all<any>();
            
            let csv = '\uFEFFuid,name,badge,class,assigned_bus,status,timestamp\n';
            students.forEach((s: any) => {
                const record = records.find(r => r.uid === s.uid);
                csv += `${s.uid},${s.name},${s.badge},${s.class || ''},"${s.bus || ''}",${record ? '已簽到' : '未到'},${record ? record.timestamp : ''}\n`;
            });

            files[`rollcall-${dateStr}-${slot.label}.csv`] = csv;
        }
    }
    return c.json({ files });
});

app.delete('/api/admin/class/photos/:className', authorizeAdmin, async (c) => {
    const classNameIn = c.req.param('className');
    const className = classNameIn === '未分班' ? '' : classNameIn;
    
    let query;
    if (className === '') {
        query = c.env.DB.prepare("UPDATE students SET photo = NULL WHERE (class IS NULL OR class = '') AND photo IS NOT NULL");
    } else {
        query = c.env.DB.prepare("UPDATE students SET photo = NULL WHERE class = ? AND photo IS NOT NULL").bind(className);
    }
    
    const result = await query.run();
    return c.json({ success: true, count: result.meta.changes });
});

app.get('/api/admin/config/students/csv', authorizeAdmin, async (c) => {
    const csvType = c.req.query('csvType') || 'arrival';
    const { results: students } = await c.env.DB.prepare("SELECT uid, name, badge, class, bus FROM students WHERE listType = ?").bind(csvType).all<any>();
    
    let csv = '\uFEFFuid,name,badge,class,bus\n';
    students.forEach((s: any) => {
        csv += `${s.uid},${s.name},${s.badge},${s.class || ''},"${s.bus || ''}"\n`;
    });

    return new Response(csv, {
        headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="students-${csvType}.csv"`
        }
    });
});

app.get('/api/admin/config/buses/csv', authorizeAdmin, async (c) => {
    const csvType = c.req.query('csvType') || 'arrival';
    const key = `buses_${csvType}`;
    let busesJson = await c.env.DB.prepare("SELECT value FROM config WHERE key = ?").bind(key).first<string>("value");
    if (!busesJson) busesJson = await c.env.DB.prepare("SELECT value FROM config WHERE key = 'buses'").first<string>("value");
    
    const buses = busesJson ? JSON.parse(busesJson) : [];
    let csv = '\uFEFFbus,overflow\n';
    buses.forEach((b: any) => {
        csv += `"${b.name || b.bus}",${b.overflow || 40}\n`;
    });

    return new Response(csv, {
        headers: {
            'Content-Type': 'text/csv',
            'Content-Disposition': `attachment; filename="buses-${csvType}.csv"`
        }
    });
});

app.post('/api/admin/config/students', authorizeAdmin, async (c) => {
    const { students, csvType } = await c.req.json();
    const type = csvType || "arrival";
    
    // Deduplicate by uid — last entry wins
    const uniqueStudents = Object.values(
        students.reduce((acc: any, s: any) => {
            if (s.uid) acc[s.uid] = s;
            return acc;
        }, {})
    );

    await c.env.DB.prepare("DELETE FROM students WHERE listType = ?").bind(type).run();

    const queries = (uniqueStudents as any[]).map((s: any) => {
        return c.env.DB.prepare("INSERT INTO students (uid, listType, name, badge, class, bus, photo) VALUES (?, ?, ?, ?, ?, ?, ?)")
            .bind(s.uid, type, s.name, s.badge || "", s.class || "", s.bus || "", s.photo || null);
    });

    for (let i = 0; i < queries.length; i += 100) {
        await c.env.DB.batch(queries.slice(i, i + 100));
    }
    
    return c.json({ success: true, count: uniqueStudents.length });
});

app.post('/api/admin/config/buses', authorizeAdmin, async (c) => {
    const { buses, csvType } = await c.req.json();
    const key = `buses_${csvType || 'arrival'}`;
    await c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)").bind(key, JSON.stringify(buses)).run();
    return c.json({ success: true });
});

app.post('/api/admin/config/placeholder', authorizeAdmin, async (c) => {
    const { photo } = await c.req.json();
    if (!photo) return c.json({ error: "Missing data" }, 400);
    await c.env.DB.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('placeholder_photo', ?)")
        .bind(photo)
        .run();
    return c.json({ success: true });
});

app.get('/api/placeholder', async (c) => {
    const config = await c.env.DB.prepare("SELECT value FROM config WHERE key = 'placeholder_photo'").first<string>("value");
    
    if (config) {
        const base64Data = config.split(',')[1] || config;
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return new Response(bytes, {
            headers: { 'Content-Type': 'image/jpeg' }
        });
    }
    // Final fallback
    return c.redirect('https://ui-avatars.com/api/?name=?&background=random');
});

app.get('/api/admin/photos', authorizeAdmin, async (c) => {
    const { results } = await c.env.DB.prepare("SELECT uid, name, badge, class FROM students WHERE photo IS NOT NULL GROUP BY uid ORDER BY name").all();
    return c.json(results);
});

app.delete('/api/admin/student/photo/:uid', authorizeAdmin, async (c) => {
    const uid = c.req.param('uid');
    await c.env.DB.prepare("UPDATE students SET photo = NULL WHERE uid = ?").bind(uid).run();
    return c.json({ success: true });
});

app.post('/api/admin/student/photo', authorizeAdmin, async (c) => {
    const { uid, photo } = await c.req.json();
    if (!uid || !photo) return c.json({ error: "Missing data" }, 400);
    await c.env.DB.prepare("UPDATE students SET photo = ? WHERE uid = ?").bind(photo, uid).run();
    return c.json({ success: true });
});

app.get('/api/photo/:uid', authorize, async (c) => {
    const uid = c.req.param('uid');
    const student = await c.env.DB.prepare("SELECT photo FROM students WHERE uid = ? AND photo IS NOT NULL LIMIT 1").bind(uid).first<any>();
    
    if (student && student.photo) {
        const base64Data = student.photo.split(',')[1] || student.photo;
        const binaryString = atob(base64Data);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return new Response(bytes, {
            headers: { 'Content-Type': 'image/jpeg' }
        });
    }
    return c.text('Not found', 404);
});

app.get('/api/student/:uid', authorize, async (c) => {
  const uid = c.req.param('uid');
  const student = await c.env.DB.prepare("SELECT * FROM students WHERE uid = ? LIMIT 1").bind(uid).first<any>();
  if (student) return c.json(student);
  
  // Try temporary rider
  const now = new Date();
  const taipeiDate = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const dateStr = taipeiDate.getFullYear() + '-' + String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + String(taipeiDate.getDate()).padStart(2, '0');
  const { slots, default: defaultSlot } = await getSlotConfigs(c.env.DB);
  const timeSlot = getTimeSlot(slots, defaultSlot, now);
  
  const temp = await c.env.DB.prepare("SELECT * FROM temporary_riders WHERE uid = ? AND date = ? AND timeSlot = ?")
    .bind(uid, dateStr, timeSlot)
    .first<any>();
    
  if (temp) return c.json({ ...temp, listType: 'temporary' });
  
  return c.json({ error: "Student not found" }, 404);
});

app.get('/api/current-slot', authorize, async (c) => {
  const { slots, default: defaultSlot } = await getSlotConfigs(c.env.DB);
  const info = getTimeSlotInfo(slots, defaultSlot);
  const slot = info.label === defaultSlot.label 
      ? defaultSlot.label 
      : `${info.start}-${info.end}`;
  return c.json({ slot, label: info.label, csvType: info.csvType });
});

app.post('/api/rollcall/batch', authorize, async (c) => {
  const { records } = await c.req.json();
  if (!Array.isArray(records)) return c.json({ error: "Records array required" }, 400);

  const { slots, default: defaultSlot } = await getSlotConfigs(c.env.DB);
  const queries = [];

  for (const record of records) {
      const { uid, timestamp } = record;
      if (!uid || !timestamp) continue;

      const dateObj = new Date(timestamp);
      const taipeiDate = new Date(dateObj.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
      const dateStr = taipeiDate.getFullYear() + '-' + String(taipeiDate.getMonth() + 1).padStart(2, '0') + '-' + String(taipeiDate.getDate()).padStart(2, '0');
      const timeSlot = getTimeSlot(slots, defaultSlot, dateObj);

      const recordId = `${uid}_${dateStr}_${timeSlot.replace(/:/g, '-')}`;
      queries.push(c.env.DB.prepare("INSERT OR REPLACE INTO rollcalls (id, uid, timestamp, date, timeSlot, syncedAt) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(recordId, uid, timestamp, dateStr, timeSlot, new Date().toISOString()));
  }

  if (queries.length > 0) {
      for (let i = 0; i < queries.length; i += 100) {
          await c.env.DB.batch(queries.slice(i, i + 100));
      }
  }

  return c.json({ success: true, message: `Successfully synced ${records.length} records` });
});

export default app;