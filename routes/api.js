const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('../db');
const auth = require('../middleware/auth');
require('dotenv').config();

// Helper: Validate Date of Birth
function isFutureDate(dateStr) {
  return new Date(dateStr) > new Date();
}

// POST /register
router.post('/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "All fields required" });

  try {
    const userCheck = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userCheck.rows.length > 0) return res.status(409).json({ error: "Email already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = await pool.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [name, email, hashedPassword]
    );

    res.json({ message: "User registered successfully", userId: newUser.rows[0].id });
  } catch (err) {
    console.error("Registration error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "All fields required" });

  try {
    const user = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (user.rows.length === 0) return res.status(401).json({ error: "Invalid credentials" });

    const valid = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign({ id: user.rows[0].id }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// Generate short report ID
function generateReportId(name, condition) {
  const first = name[0]?.toUpperCase() || 'X';
  const second = condition[0]?.toUpperCase() || 'Z';
  const timestamp = Date.now().toString().slice(-4);
  const rand = Math.floor(Math.random() * 10);
  return `${first}${second}${timestamp}${rand}`;
}

// POST /record – Protected
router.post('/record', auth, async (req, res) => {
  const { condition, dob, gender } = req.body;
  if (!condition || !dob || !gender) return res.status(400).json({ error: "All fields required" });
  if (isFutureDate(dob)) return res.status(400).json({ error: "DOB cannot be in the future" });

  try {
    const userRes = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const name = userRes.rows[0]?.name || "Unknown";
    const reportId = generateReportId(name, condition);

    await pool.query(
      'INSERT INTO health_records (user_id, report_id, condition, dob, gender) VALUES ($1, $2, $3, $4, $5)',
      [req.user.id, reportId, condition, dob, gender]
    );

    res.json({ message: "Health record created", reportId });
  } catch (err) {
    console.error("POST /record error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /record/:reportId
router.get('/record/:reportId', async (req, res) => {
  try {
    const rec = await pool.query(
      `SELECT u.name, h.condition, h.dob, h.gender, h.report_id 
       FROM health_records h JOIN users u ON h.user_id = u.id
       WHERE h.report_id = $1`,
      [req.params.reportId]
    );

    if (rec.rows.length === 0) return res.status(404).json({ error: "Record not found" });

    res.json(rec.rows[0]);
  } catch (err) {
    console.error("GET /record/:reportId error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /record/:reportId – Protected
router.put('/record/:reportId', auth, async (req, res) => {
  const { condition, dob, gender } = req.body;
  if (!condition || !dob || !gender) return res.status(400).json({ error: "All fields required" });
  if (isFutureDate(dob)) return res.status(400).json({ error: "DOB cannot be in the future" });

  try {
    const result = await pool.query(
      'UPDATE health_records SET condition=$1, dob=$2, gender=$3, updated_at=NOW() WHERE report_id=$4 RETURNING *',
      [condition, dob, gender, req.params.reportId]
    );

    if (result.rowCount === 0) return res.status(404).json({ error: "Record not found" });

    res.json({ message: "Record updated successfully" });
  } catch (err) {
    console.error("PUT /record/:reportId error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /submit-questionnaire – Save DLQ responses with unique DLQ ID
router.post('/submit-questionnaire', auth, async (req, res) => {
  const { responses } = req.body;

  if (!Array.isArray(responses) || responses.length === 0) {
    return res.status(400).json({ error: "No responses provided" });
  }

  try {
    const userRes = await pool.query('SELECT name FROM users WHERE id = $1', [req.user.id]);
    const fullName = userRes.rows[0]?.name || "User";
    const initials = fullName.split(" ").map(n => n[0]).join('').toUpperCase().slice(0, 2);
    const random = Math.floor(1000 + Math.random() * 9000);
    const dlqId = `DLQ_${initials}${random}`;

    // Filter invalid and clean responses
    const values = responses
      .filter(r => r.section && r.question && typeof r.response !== 'undefined')
      .map(r => [
        req.user.id,
        dlqId,
        r.section.trim(),
        r.question.trim(),
        String(r.response).trim()
      ]);

    if (values.length === 0) {
      return res.status(400).json({ error: "No valid responses to save." });
    }

    const placeholders = values
      .map((_, i) =>
        `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`
      ).join(', ');

    const query = `
      INSERT INTO questionnaire_responses (user_id, dlq_id, section, question, response)
      VALUES ${placeholders}
    `;

    // For debugging if needed:
    // console.log("Insert SQL:", query);
    // console.log("With values:", values.flat());

    await pool.query(query, values.flat());

    res.json({ message: "Responses saved successfully!", dlqId });

  } catch (err) {
    console.error("POST /submit-questionnaire error:", err);
    res.status(500).json({ error: "Failed to save responses" });
  }
});

// GET /dlq/:dlqId – Fetch DLQ responses by unique ID
router.get('/dlq/:dlqId', async (req, res) => {
  const { dlqId } = req.params;

  try {
    const results = await pool.query(
      'SELECT section, question, response FROM questionnaire_responses WHERE dlq_id = $1 ORDER BY id',
      [dlqId]
    );

    if (results.rows.length === 0) {
      return res.status(404).json({ error: "No responses found for this DLQ ID." });
    }

    res.json({ dlqId, responses: results.rows });
  } catch (err) {
    console.error("GET /dlq/:dlqId error:", err);
    res.status(500).json({ error: "Server error while fetching responses." });
  }
});

module.exports = router;