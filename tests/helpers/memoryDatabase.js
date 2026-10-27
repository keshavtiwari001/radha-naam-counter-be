import { ObjectId } from 'mongodb';

// In-memory Mongo-shaped adapter for service rules. This is deliberately not a
// replacement for replica-set integration tests of MongoDB's concurrency.
export function memoryDatabase() {
  let data = {};
  const equal = (a, b) => a instanceof ObjectId || b instanceof ObjectId ? String(a) === String(b) : a === b;
  const matches = (document, filter) => Object.entries(filter).every(([key, value]) => {
    if (key === '$or') return value.some((branch) => matches(document, branch));
    if (value && typeof value === 'object' && '$in' in value) return value.$in.some((item) => equal(document[key], item));
    if (value && typeof value === 'object' && '$lt' in value) return String(document[key]) < String(value.$lt);
    if (value && typeof value === 'object' && '$gt' in value) return document[key] > value.$gt;
    return equal(document[key], value);
  });
  function copy(value) {
    if (value instanceof ObjectId) return new ObjectId(value);
    if (value instanceof Date) return new Date(value);
    if (Array.isArray(value)) return value.map(copy);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copy(item)]));
    return value;
  }
  const db = {
    collection(name) {
      const rows = () => data[name] ??= [];
      return {
        find(filter) {
          let result = rows().filter((row) => matches(row, filter));
          const cursor = {
            sort(order) { result.sort((a, b) => {
              for (const [key, direction] of Object.entries(order)) {
                const left = a[key] instanceof ObjectId ? String(a[key]) : a[key];
                const right = b[key] instanceof ObjectId ? String(b[key]) : b[key];
                if (left !== right) return (left < right ? -1 : 1) * direction;
              }
              return 0;
            }); return cursor; },
            limit(count) { result = result.slice(0, count); return cursor; },
            async toArray() { return copy(result); },
          };
          return cursor;
        },
        async countDocuments(filter) { return rows().filter((row) => matches(row, filter)).length; },
        async findOne(filter) { return copy(rows().find((row) => matches(row, filter)) ?? null); },
        async insertOne(document) { rows().push(copy(document)); return { insertedId: document._id }; },
        async updateOne(filter, update, options = {}) {
          let row = rows().find((item) => matches(item, filter));
          const inserted = !row;
          if (!row && options.upsert) { row = copy(filter); rows().push(row); }
          if (!row) return { matchedCount: 0 };
          if (inserted) Object.assign(row, copy(update.$setOnInsert || {}));
          Object.assign(row, copy(update.$set || {}));
          for (const [key, value] of Object.entries(update.$inc || {})) row[key] = (row[key] || 0) + value;
          for (const [key, value] of Object.entries(update.$addToSet || {})) {
            row[key] ??= [];
            if (!row[key].includes(value)) row[key].push(value);
          }
          for (const [key, value] of Object.entries(update.$push || {})) {
            row[key] ??= [];
            row[key].push(copy(value));
          }
          for (const key of Object.keys(update.$unset || {})) delete row[key];
          return { matchedCount: 1 };
        },
        async deleteMany(filter) { data[name] = rows().filter((item) => !matches(item, filter)); },
      };
    },
  };
  const client = {
    async withSession(callback) {
      return callback({
        async withTransaction(action) {
          const backup = copy(data);
          try { return await action(); } catch (error) { data = backup; throw error; }
        },
      });
    },
  };
  return { db, client };
}
