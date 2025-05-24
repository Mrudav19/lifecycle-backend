CREATE TABLE questionnaire_responses (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  dlq_id VARCHAR(20),
  section VARCHAR(255),
  question TEXT,
  response TEXT,
  submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

