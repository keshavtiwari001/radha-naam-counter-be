import { getDatabase, closeDatabase } from '../config/mongo.js';
import { createIndexes } from '../models/index.js';

try {
  const { db } = await getDatabase();
  await createIndexes(db);
  console.log('Database indexes ready.');
} catch {
  // Connection errors can contain credentials; keep console output private-safe.
  console.error('Could not create indexes. Check database configuration and connectivity.');
  process.exitCode = 1;
} finally {
  await closeDatabase();
}
