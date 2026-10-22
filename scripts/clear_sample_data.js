import 'dotenv/config';
import pg from 'pg';

const pool = new pg.Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: { rejectUnauthorized: false }
});

console.log('Connecting to database...');
const client = await pool.connect();

try {
  console.log('Beginning transaction to clear sample inspection data...');
  await client.query('BEGIN');

  // Ladder inspection records
  const delLadderResults = await client.query('DELETE FROM inspection_results');
  const delLadderInspections = await client.query('DELETE FROM inspections');
  console.log(`✔ Cleared Ladder inspections: ${delLadderInspections.rowCount} inspections, ${delLadderResults.rowCount} result items.`);

  // Fire extinguisher inspection records
  const delFireResults = await client.query('DELETE FROM fire_inspection_results');
  const delFireInspections = await client.query('DELETE FROM fire_inspections');
  console.log(`✔ Cleared Fire inspections: ${delFireInspections.rowCount} inspections, ${delFireResults.rowCount} result items.`);

  // First Aid inspection records
  const delFirstAidResults = await client.query('DELETE FROM firstaid_inspection_results');
  const delFirstAidInspections = await client.query('DELETE FROM firstaid_inspections');
  console.log(`✔ Cleared First Aid inspections: ${delFirstAidInspections.rowCount} inspections, ${delFirstAidResults.rowCount} result items.`);

  await client.query('COMMIT');
  console.log('✔ Transaction committed successfully! All sample data has been removed.');
} catch (err) {
  await client.query('ROLLBACK');
  console.error('❌ Error during deletion, transaction rolled back:', err);
} finally {
  client.release();
}

// Verify counts
console.log('\n--- Current Database Record Counts ---');
const tables = [
  'inspections', 'inspection_results',
  'fire_inspections', 'fire_inspection_results',
  'firstaid_inspections', 'firstaid_inspection_results',
  'inspection_points', 'question_options',
  'fire_inspection_points', 'fire_question_options',
  'firstaid_inspection_points', 'firstaid_question_options'
];

for (const t of tables) {
  const countRes = await pool.query(`SELECT COUNT(*) FROM ${t}`);
  console.log(`${t.padEnd(30)} : ${countRes.rows[0].count}`);
}

await pool.end();
