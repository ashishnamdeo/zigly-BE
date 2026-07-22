const { Pool } = require('pg');
const { config } = require('../config/env');

const pool = new Pool({
  host: config.db.host,
  port: config.db.port,
  database: config.db.database,
  user: config.db.user,
  password: config.db.password,
  ssl: { rejectUnauthorized: false },
  max: 3,
});

module.exports = pool;
