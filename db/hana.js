// backend/db/hana.js
const hana = require('@sap/hana-client');

const connParams = {
  serverNode: `${process.env.HANA_HOST}:${process.env.HANA_PORT}`,
  uid: process.env.HANA_USER,
  pwd: process.env.HANA_PASSWORD,
  encrypt: 'true',
  sslValidateCertificate: 'false',
};

let connection = null;

async function getConnection() {
  if (connection) return connection;
  connection = hana.createConnection();
  await new Promise((resolve, reject) => {
    connection.connect(connParams, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
  console.log('✅ Connected to SAP HANA');
  return connection;
}

async function query(sql, params = []) {
  const conn = await getConnection();
  return new Promise((resolve, reject) => {
    conn.exec(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

module.exports = { getConnection, query };
