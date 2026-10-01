-- ============================================================
--  FebBox HLS Pool — direct SQL schema (MariaDB 10.4+ / MySQL 8+)
--
--  HOW TO APPLY:
--    1. Open phpMyAdmin
--    2. Select your database (e.g. `febusage`) in the left sidebar
--    3. Click the "SQL" tab
--    4. Paste this whole file and hit "Go"
--
--  Safe to re-run: every statement is IF NOT EXISTS, existing
--  data is never touched.
-- ============================================================

-- ------------------------------------------------------------
-- Cookie accounts in the rotation pool
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cookie_accounts (
  id                VARCHAR(64)      NOT NULL,
  label             VARCHAR(190)     NOT NULL DEFAULT '',
  cookie_raw        TEXT             NOT NULL,
  uid               VARCHAR(190)     NOT NULL DEFAULT '',
  email             VARCHAR(190)     NOT NULL DEFAULT '',
  username          VARCHAR(190)     NOT NULL DEFAULT '',
  plan              VARCHAR(190)     NOT NULL DEFAULT '',
  plan_expire       VARCHAR(190)     NOT NULL DEFAULT '',
  is_vip            TINYINT(1)       NOT NULL DEFAULT 0,
  status            VARCHAR(32)      NOT NULL DEFAULT 'active',  -- active | inactive | limit_reached
  usage_gb          DOUBLE           NOT NULL DEFAULT 0,
  real_usage_gb     DOUBLE           NOT NULL DEFAULT 0,         -- real flow usage reported by FebBox
  real_usage_limit_gb DOUBLE         NOT NULL DEFAULT 0,         -- plan's daily flow limit (e.g. 100)
  usage_source      VARCHAR(16)      NOT NULL DEFAULT 'estimate',-- real | estimate | manual
  usage_synced_at   TIMESTAMP        NULL DEFAULT NULL,          -- last real-usage sync
  fetch_count       INT UNSIGNED     NOT NULL DEFAULT 0,
  last_used_at      TIMESTAMP        NULL DEFAULT NULL,
  last_error        TEXT             NULL,
  created_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_pool (status, is_vip, usage_gb),
  KEY idx_uid (uid),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- NOTE: older installs that created `cookie_accounts` before the real-usage
-- columns existed do NOT need to edit anything here — the app adds the
-- missing columns automatically (runtime migration, INFORMATION_SCHEMA
-- checked) the first time it starts with the new version.

-- ------------------------------------------------------------
-- Fetch logs (who fetched what, when, how much usage was added)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fetch_logs (
  id         VARCHAR(64)  NOT NULL,
  cookie_id  VARCHAR(64)  NULL,
  fid        VARCHAR(64)  NOT NULL DEFAULT '',
  file_name  VARCHAR(255) NOT NULL DEFAULT '',
  quality    VARCHAR(32)  NOT NULL DEFAULT '',
  status     VARCHAR(16)  NOT NULL DEFAULT 'success',  -- success | failed
  message    TEXT         NULL,
  est_gb     DOUBLE       NOT NULL DEFAULT 0,
  created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_created (created_at),
  KEY idx_cookie (cookie_id),
  CONSTRAINT fk_logs_cookie
    FOREIGN KEY (cookie_id) REFERENCES cookie_accounts (id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ------------------------------------------------------------
-- App settings (proxy url/enabled, usage limit, auto usage)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  `key`   VARCHAR(64) NOT NULL,
  `value` TEXT        NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
