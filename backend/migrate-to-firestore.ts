import admin from 'firebase-admin';
import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Replace this with the path to your service account key file
const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, 'serviceAccountKey.json');

if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.error('Error: serviceAccountKey.json not found in the backend directory.');
    console.log('Please download it from the Firebase Console (Project Settings > Service accounts > Generate new private key) and save it as backend/serviceAccountKey.json');
    process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function migrate() {
  console.log('--- Starting Migration to Firestore ---');

  // 1. Migrate Accounts
  console.log('Migrating accounts...');
  const accountsPath = path.resolve(__dirname, 'accounts.json');
  if (fs.existsSync(accountsPath)) {
    const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    for (const account of accounts) {
        // Ensure type exists, default to 'user', but keep 'admin' as 'admin'
        if (account.username === 'admin') {
            account.type = 'admin';
        } else if (!account.type) {
            account.type = 'user';
        }
        await db.collection('accounts').doc(account.username).set(account);
        console.log(`  Migrated account: ${account.username} (${account.type})`);
    }
  }

  // 2. Migrate Students
  console.log('Migrating students...');
  const studentsPath = path.resolve(__dirname, 'students.csv');
  if (fs.existsSync(studentsPath)) {
    const fileContent = fs.readFileSync(studentsPath, { encoding: 'utf-8' });
    const records: any[] = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true
    });
    for (const record of records) {
        const docId = `${record.uid}_arrival`;
        await db.collection('students').doc(docId).set({
            uid: record.uid,
            name: record.name,
            badge: record.badge,
            bus: record.bus || "",
            listType: 'arrival'
        });
        console.log(`  Migrated student: ${record.name} (${record.uid}) as ${docId}`);
    }
  }

  // 3. Migrate Buses
  console.log('Migrating buses...');
  const busPath = path.resolve(__dirname, 'current-bus.csv');
  if (fs.existsSync(busPath)) {
    const fileContent = fs.readFileSync(busPath, { encoding: 'utf-8' });
    const records: any[] = parse(fileContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true
    });
    const buses = records.map(r => ({
        name: (r.bus || r.name || Object.values(r)[0]) as string,
        overflow: parseInt(r.overflow) || 40
    })).filter(b => b.name);
    await db.collection('config').doc('buses').set({ list: buses });
    console.log(`  Migrated ${buses.length} buses to 'buses' config`);
  }

  console.log('--- Migration Complete ---');
}

migrate().catch(console.error);
