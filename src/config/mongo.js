import { MongoClient } from 'mongodb';
import { getMongoConfig } from './env.js';

let connection;

// Reuse the pool across requests in a warm serverless instance.
export async function getDatabase() {
  if (!connection) {
    const { uri, database } = getMongoConfig();
    const client = new MongoClient(uri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
    });
    connection = client.connect().then(() => ({ client, db: client.db(database) }))
      .catch(async (error) => {
        connection = undefined;
        await client.close();
        throw error;
      });
  }
  return connection;
}

export async function closeDatabase() {
  if (connection) {
    const { client } = await connection;
    connection = undefined;
    await client.close();
  }
}
