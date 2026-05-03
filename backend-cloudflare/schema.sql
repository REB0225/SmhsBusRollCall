CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL -- JSON string
);

CREATE TABLE IF NOT EXISTS students (
    uid TEXT NOT NULL,
    listType TEXT NOT NULL,
    name TEXT NOT NULL,
    badge TEXT,
    class TEXT,
    bus TEXT,
    photo TEXT, -- Base64
    PRIMARY KEY (uid, listType)
);

CREATE TABLE IF NOT EXISTS temporary_riders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    timeSlot TEXT NOT NULL,
    bus TEXT NOT NULL,
    uid TEXT NOT NULL,
    name TEXT NOT NULL,
    badge TEXT,
    class TEXT
);

CREATE TABLE IF NOT EXISTS rollcalls (
    id TEXT PRIMARY KEY, -- uid_date_slot
    uid TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    date TEXT NOT NULL,
    timeSlot TEXT NOT NULL,
    syncedAt TEXT NOT NULL
);

-- Initial Admin Account (Ignore if exists to prevent overwrite)
INSERT OR IGNORE INTO accounts (username, password, type, name) VALUES ('admin', 'admin123', 'admin', 'System Admin');

-- Initial Config (Ignore if exists to keep user changes)
INSERT OR IGNORE INTO config (key, value) VALUES ('slots', '[{"start":"07:00","end":"09:00","csvType":"arrival","label":"早上"},{"day":5,"start":"16:00","end":"18:00","csvType":"full_departure","label":"週五下午"},{"days":[1,2,3,4],"start":"16:00","end":"18:00","csvType":"night_class_afternoon","label":"週一至四下午"},{"days":[1,2,3,4],"start":"19:00","end":"21:00","csvType":"night_class_night","label":"週一至四晚上"}]');
INSERT OR IGNORE INTO config (key, value) VALUES ('default_slot', '{"csvType":"arrival","label":"不在時段內"}');
