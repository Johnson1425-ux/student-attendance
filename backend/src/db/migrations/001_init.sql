-- =============================================================================
-- 001_init.sql — Core schema for the Student Fingerprint Attendance System
--
-- Design notes
--  * All instants are stored as TIMESTAMPTZ (UTC on the wire). Calendar days
--    ("which school day does this punch belong to?") are stored as DATE and are
--    always computed in the school's local timezone by the application layer.
--  * No fingerprint templates are ever persisted (PRD §8 Security). Only
--    enrollment *metadata* (which finger, when, on which terminal) is kept.
--  * attendance_records carries a UNIQUE (student_id, attendance_date)
--    constraint, which is the hard guarantee behind PRD §8 "no duplicate
--    attendance records per student per day".
-- =============================================================================

-- --------------------------------------------------------------------------
-- Enumerated types
-- --------------------------------------------------------------------------
CREATE TYPE user_role AS ENUM ('admin', 'teacher', 'office_staff');

CREATE TYPE student_status AS ENUM ('active', 'inactive', 'graduated', 'transferred');

CREATE TYPE attendance_status AS ENUM ('present', 'late', 'absent', 'excused');

CREATE TYPE attendance_source AS ENUM ('device', 'manual', 'system');

CREATE TYPE day_type AS ENUM ('school_day', 'weekend', 'holiday', 'break');

CREATE TYPE device_command_status AS ENUM ('pending', 'sent', 'acked', 'failed', 'expired');

CREATE TYPE alert_status AS ENUM ('open', 'acknowledged', 'resolved');

-- --------------------------------------------------------------------------
-- Utility: keep updated_at fresh
-- --------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- --------------------------------------------------------------------------
-- settings — single-row-per-key application configuration (school name,
-- timezone, bell times, absence thresholds). Editable by admins at runtime so
-- the school does not need a redeploy to change the late cut-off.
-- --------------------------------------------------------------------------
CREATE TABLE settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  description TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT
);

-- --------------------------------------------------------------------------
-- users — staff accounts (PRD §7.7)
-- --------------------------------------------------------------------------
CREATE TABLE users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT   NOT NULL,
  password_hash TEXT   NOT NULL,
  full_name     TEXT   NOT NULL,
  role          user_role NOT NULL,
  phone         TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));
CREATE INDEX users_role_idx ON users (role) WHERE is_active;

CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE settings
  ADD CONSTRAINT settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL;

-- --------------------------------------------------------------------------
-- refresh_tokens — rotating refresh tokens, stored hashed so a database dump
-- cannot be replayed as a login.
-- --------------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  replaced_by BIGINT REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  user_agent  TEXT,
  ip_address  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- --------------------------------------------------------------------------
-- academic_terms — terms/semesters, used to scope reports (PRD §7.5)
-- --------------------------------------------------------------------------
CREATE TABLE academic_terms (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  academic_year TEXT NOT NULL,
  start_date    DATE NOT NULL,
  end_date      DATE NOT NULL,
  is_current    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT academic_terms_name_year_unique UNIQUE (name, academic_year),
  CONSTRAINT academic_terms_date_order CHECK (end_date >= start_date)
);
-- At most one current term.
CREATE UNIQUE INDEX academic_terms_single_current ON academic_terms ((is_current)) WHERE is_current;

CREATE TRIGGER academic_terms_set_updated_at BEFORE UPDATE ON academic_terms
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- classes (PRD §7.1)
-- --------------------------------------------------------------------------
CREATE TABLE classes (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  grade_level   TEXT,
  stream        TEXT,
  academic_year TEXT NOT NULL,
  room          TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT classes_name_year_unique UNIQUE (name, academic_year)
);
CREATE INDEX classes_active_idx ON classes (is_active);

CREATE TRIGGER classes_set_updated_at BEFORE UPDATE ON classes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Teachers may own several classes and a class may have several teachers.
CREATE TABLE class_teachers (
  class_id   BIGINT NOT NULL REFERENCES classes (id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, user_id)
);
CREATE INDEX class_teachers_user_idx ON class_teachers (user_id);

-- --------------------------------------------------------------------------
-- students (PRD §7.1)
--
-- device_user_pin is the numeric ID typed into the fingerprint terminal during
-- enrollment. It is the join key between a physical punch and a student record,
-- so it is unique across the school and immutable once biometrics exist.
-- --------------------------------------------------------------------------
CREATE TABLE students (
  id               BIGSERIAL PRIMARY KEY,
  admission_number TEXT NOT NULL,
  device_user_pin  TEXT,
  first_name       TEXT NOT NULL,
  middle_name      TEXT,
  last_name        TEXT NOT NULL,
  date_of_birth    DATE,
  gender           TEXT,
  guardian_name    TEXT,
  guardian_phone   TEXT,
  guardian_email   TEXT,
  address          TEXT,
  status           student_status NOT NULL DEFAULT 'active',
  enrolled_on      DATE NOT NULL DEFAULT CURRENT_DATE,
  exited_on        DATE,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT students_pin_format CHECK (device_user_pin IS NULL OR device_user_pin ~ '^[0-9]{1,20}$')
);
CREATE UNIQUE INDEX students_admission_number_unique ON students (lower(admission_number));
CREATE UNIQUE INDEX students_device_pin_unique ON students (device_user_pin) WHERE device_user_pin IS NOT NULL;
CREATE INDEX students_status_idx ON students (status);
CREATE INDEX students_name_idx ON students (lower(last_name), lower(first_name));

CREATE TRIGGER students_set_updated_at BEFORE UPDATE ON students
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- enrollments — a student's membership of a class over time. Keeping history
-- means a report for last term still shows the class the student was in then.
-- --------------------------------------------------------------------------
CREATE TABLE enrollments (
  id         BIGSERIAL PRIMARY KEY,
  student_id BIGINT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  class_id   BIGINT NOT NULL REFERENCES classes (id) ON DELETE RESTRICT,
  start_date DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date   DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT enrollments_date_order CHECK (end_date IS NULL OR end_date >= start_date)
);
-- A student can only sit in one class at a time.
CREATE UNIQUE INDEX enrollments_one_active_per_student ON enrollments (student_id) WHERE end_date IS NULL;
CREATE INDEX enrollments_class_idx ON enrollments (class_id) WHERE end_date IS NULL;
CREATE INDEX enrollments_student_idx ON enrollments (student_id);

-- --------------------------------------------------------------------------
-- devices — registered fingerprint terminals (PRD §5)
--
-- push_secret is an optional shared secret appended to the ADMS callback URL.
-- ADMS itself only identifies a terminal by serial number, so the secret plus
-- the ip_allowlist are what stop an unregistered client forging punches.
-- --------------------------------------------------------------------------
CREATE TABLE devices (
  id             BIGSERIAL PRIMARY KEY,
  serial_number  TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  location       TEXT,
  model          TEXT,
  firmware       TEXT,
  timezone_offset SMALLINT,
  push_secret    TEXT,
  ip_allowlist   TEXT[],
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_at   TIMESTAMPTZ,
  last_push_at   TIMESTAMPTZ,
  attlog_stamp   TEXT NOT NULL DEFAULT '0',
  operlog_stamp  TEXT NOT NULL DEFAULT '0',
  user_count     INTEGER,
  fingerprint_count INTEGER,
  transaction_count INTEGER,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX devices_active_idx ON devices (is_active);

CREATE TRIGGER devices_set_updated_at BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- device_users — the user list as the terminal sees it. Rows appear when a
-- terminal pushes USERINFO after somebody is enrolled at the device. A row with
-- student_id IS NULL is an "unlinked" enrollment awaiting office staff action.
-- --------------------------------------------------------------------------
CREATE TABLE device_users (
  id                BIGSERIAL PRIMARY KEY,
  device_id         BIGINT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  pin               TEXT NOT NULL,
  name              TEXT,
  privilege         SMALLINT NOT NULL DEFAULT 0,
  card_number       TEXT,
  fingerprint_count INTEGER NOT NULL DEFAULT 0,
  student_id        BIGINT REFERENCES students (id) ON DELETE SET NULL,
  linked_at         TIMESTAMPTZ,
  linked_by         BIGINT REFERENCES users (id) ON DELETE SET NULL,
  first_seen_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT device_users_device_pin_unique UNIQUE (device_id, pin)
);
CREATE INDEX device_users_student_idx ON device_users (student_id);
CREATE INDEX device_users_unlinked_idx ON device_users (device_id) WHERE student_id IS NULL;

-- --------------------------------------------------------------------------
-- biometric_enrollments — metadata only. The fingerprint template stays on the
-- terminal; we deliberately store nothing that could reconstruct it.
-- --------------------------------------------------------------------------
CREATE TABLE biometric_enrollments (
  id            BIGSERIAL PRIMARY KEY,
  student_id    BIGINT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  device_id     BIGINT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  finger_index  SMALLINT NOT NULL,
  is_duress     BOOLEAN NOT NULL DEFAULT FALSE,
  template_size INTEGER,
  quality       SMALLINT,
  enrolled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT biometric_finger_unique UNIQUE (student_id, device_id, finger_index),
  CONSTRAINT biometric_finger_range CHECK (finger_index BETWEEN 0 AND 9)
);
CREATE INDEX biometric_enrollments_student_idx ON biometric_enrollments (student_id);

-- --------------------------------------------------------------------------
-- attendance_events — the immutable ledger. Every punch the terminal ever
-- pushes lands here exactly once (dedupe_hash), whether or not it maps to a
-- known student. This is the audit trail required by PRD §3.
-- --------------------------------------------------------------------------
CREATE TABLE attendance_events (
  id              BIGSERIAL PRIMARY KEY,
  device_id       BIGINT REFERENCES devices (id) ON DELETE SET NULL,
  device_serial   TEXT,
  device_user_pin TEXT NOT NULL,
  student_id      BIGINT REFERENCES students (id) ON DELETE SET NULL,
  event_time      TIMESTAMPTZ NOT NULL,
  local_date      DATE NOT NULL,
  local_time      TIME NOT NULL,
  punch_state     SMALLINT,
  verify_mode     SMALLINT,
  work_code       TEXT,
  raw_line        TEXT,
  dedupe_hash     TEXT NOT NULL UNIQUE,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied         BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX attendance_events_student_date_idx ON attendance_events (student_id, local_date);
CREATE INDEX attendance_events_date_idx ON attendance_events (local_date);
CREATE INDEX attendance_events_unmatched_idx ON attendance_events (local_date) WHERE student_id IS NULL;
CREATE INDEX attendance_events_device_idx ON attendance_events (device_id, event_time DESC);

-- --------------------------------------------------------------------------
-- attendance_records — one row per student per school day. This is what the
-- dashboard and every report read from.
-- --------------------------------------------------------------------------
CREATE TABLE attendance_records (
  id               BIGSERIAL PRIMARY KEY,
  student_id       BIGINT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  class_id         BIGINT REFERENCES classes (id) ON DELETE SET NULL,
  attendance_date  DATE NOT NULL,
  status           attendance_status NOT NULL,
  source           attendance_source NOT NULL DEFAULT 'device',
  check_in_at      TIMESTAMPTZ,
  check_out_at     TIMESTAMPTZ,
  minutes_late     INTEGER,
  device_id        BIGINT REFERENCES devices (id) ON DELETE SET NULL,
  first_event_id   BIGINT REFERENCES attendance_events (id) ON DELETE SET NULL,
  last_event_id    BIGINT REFERENCES attendance_events (id) ON DELETE SET NULL,
  is_manual_override BOOLEAN NOT NULL DEFAULT FALSE,
  override_reason  TEXT,
  recorded_by      BIGINT REFERENCES users (id) ON DELETE SET NULL,
  finalized_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- PRD §8 data integrity: at most one attendance record per student per day.
  CONSTRAINT attendance_records_student_day_unique UNIQUE (student_id, attendance_date)
);
CREATE INDEX attendance_records_date_idx ON attendance_records (attendance_date);
CREATE INDEX attendance_records_class_date_idx ON attendance_records (class_id, attendance_date);
CREATE INDEX attendance_records_student_date_idx ON attendance_records (student_id, attendance_date DESC);
CREATE INDEX attendance_records_status_date_idx ON attendance_records (attendance_date, status);

CREATE TRIGGER attendance_records_set_updated_at BEFORE UPDATE ON attendance_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- school_calendar — which dates actually count. Absence is only meaningful on
-- a school day, so holidays and breaks are excluded from every rate we compute.
-- --------------------------------------------------------------------------
CREATE TABLE school_calendar (
  calendar_date DATE PRIMARY KEY,
  day_type      day_type NOT NULL,
  label         TEXT,
  created_by    BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX school_calendar_type_idx ON school_calendar (day_type);

-- --------------------------------------------------------------------------
-- device_commands — outbound queue drained by the terminal's periodic
-- /iclock/getrequest poll (ADMS is pull-based for commands).
-- --------------------------------------------------------------------------
CREATE TABLE device_commands (
  id           BIGSERIAL PRIMARY KEY,
  device_id    BIGINT NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
  command      TEXT NOT NULL,
  description  TEXT,
  status       device_command_status NOT NULL DEFAULT 'pending',
  return_code  INTEGER,
  response     TEXT,
  created_by   BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at      TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);
CREATE INDEX device_commands_pending_idx ON device_commands (device_id, id) WHERE status = 'pending';

-- --------------------------------------------------------------------------
-- absentee_alerts — PRD §7.8: flag students absent for X consecutive days.
-- --------------------------------------------------------------------------
CREATE TABLE absentee_alerts (
  id                BIGSERIAL PRIMARY KEY,
  student_id        BIGINT NOT NULL REFERENCES students (id) ON DELETE CASCADE,
  class_id          BIGINT REFERENCES classes (id) ON DELETE SET NULL,
  consecutive_days  INTEGER NOT NULL,
  first_absent_date DATE NOT NULL,
  last_absent_date  DATE NOT NULL,
  status            alert_status NOT NULL DEFAULT 'open',
  acknowledged_by   BIGINT REFERENCES users (id) ON DELETE SET NULL,
  acknowledged_at   TIMESTAMPTZ,
  resolved_at       TIMESTAMPTZ,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- One live alert per student per absence streak.
  CONSTRAINT absentee_alerts_streak_unique UNIQUE (student_id, first_absent_date)
);
CREATE INDEX absentee_alerts_open_idx ON absentee_alerts (status, last_absent_date DESC);

CREATE TRIGGER absentee_alerts_set_updated_at BEFORE UPDATE ON absentee_alerts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- --------------------------------------------------------------------------
-- audit_logs — who changed what, when. Manual attendance overrides in
-- particular must be attributable (PRD §7.6).
-- --------------------------------------------------------------------------
CREATE TABLE audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    BIGINT REFERENCES users (id) ON DELETE SET NULL,
  actor_label TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  summary     TEXT,
  before_data JSONB,
  after_data  JSONB,
  ip_address  TEXT,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
