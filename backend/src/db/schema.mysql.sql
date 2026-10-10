-- Egypt Industrial Initiatives Platform — MySQL 8.0.16+ schema (production baseline)
-- Mirrors src/db/schema.sql (SQLite) column-for-column. Requirements:
--   MySQL >= 8.0.16 (CHECK enforcement + TEXT expression defaults).
--   Database created with: CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci
--   (see scripts/migrate-sqlite-to-mysql.ts and docs/MYSQL_MIGRATION.md).
--
-- Porting notes (behaviour-preserving):
-- - TEXT primary keys      → VARCHAR(64) PRIMARY KEY (MySQL cannot index bare TEXT).
-- - UNIQUE TEXT (code/email/slug) → VARCHAR with utf8mb4_unicode_ci, which is
--   already case-insensitive — replaces SQLite `COLLATE NOCASE`.
-- - JSON TEXT columns      → LONGTEXT holding the same JSON strings (NOT MySQL
--   JSON type: keeps '' / loose payloads working exactly like SQLite).
-- - ISO-8601 timestamps    → VARCHAR(32) (keeps '' = "no bound" working; TEXT
--   ordering on ISO strings is chronological either way).
-- - INTEGER 0/1 flags      → TINYINT(1); counts → INT; REAL money → DOUBLE.
-- - `meta`.`key` is backtick-quoted (KEY is reserved in MySQL).
-- - Row ordering that used SQLite `rowid` uses createdAt/id in queries instead.

CREATE TABLE IF NOT EXISTS organizations (
  id           VARCHAR(64) PRIMARY KEY,
  code         VARCHAR(64) NOT NULL UNIQUE,
  nameAr       TEXT NOT NULL,
  nameEn       TEXT NOT NULL,
  type         VARCHAR(32) NOT NULL CHECK (type IN ('ministry','authority','center','bank','utility','provider','factory')),
  active       TINYINT(1) NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  contactEmail VARCHAR(255) NOT NULL DEFAULT '',
  createdAt    VARCHAR(32) NOT NULL DEFAULT '',
  updatedAt    VARCHAR(32) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_orgs_type ON organizations(type);

CREATE TABLE IF NOT EXISTS users (
  id             VARCHAR(64) PRIMARY KEY,
  name           TEXT NOT NULL,
  nameEn         TEXT NOT NULL,
  email          VARCHAR(255) NOT NULL UNIQUE,
  role           VARCHAR(32) NOT NULL CHECK (role IN ('ministry_admin','initiative_manager','ida_reviewer','imc_reviewer','bank_reviewer','solar_provider','factory_owner','auditor')),
  organizationId VARCHAR(64) NOT NULL,
  factoryId      VARCHAR(64) NOT NULL DEFAULT '',
  passwordHash   LONGTEXT NOT NULL,
  mustChangePassword TINYINT(1) NOT NULL DEFAULT 0 CHECK (mustChangePassword IN (0,1)),
  isVerified     TINYINT(1) NOT NULL DEFAULT 1 CHECK (isVerified IN (0,1)),
  emailVerificationToken VARCHAR(255) NOT NULL DEFAULT '',
  emailVerificationExpires VARCHAR(32) NOT NULL DEFAULT '',
  createdAt      VARCHAR(32) NOT NULL DEFAULT '',
  updatedAt      VARCHAR(32) NOT NULL DEFAULT '',
  CONSTRAINT fk_users_org FOREIGN KEY (organizationId) REFERENCES organizations(id) ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_users_org ON users(organizationId);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_factory ON users(factoryId);

CREATE TABLE IF NOT EXISTS initiatives (
  id                    VARCHAR(64) PRIMARY KEY,
  slug                  VARCHAR(255) NOT NULL UNIQUE,
  titleAr               TEXT NOT NULL,
  titleEn               TEXT NOT NULL,
  taglineAr             LONGTEXT NOT NULL DEFAULT (''),
  taglineEn             LONGTEXT NOT NULL DEFAULT (''),
  descriptionAr         LONGTEXT NOT NULL DEFAULT (''),
  descriptionEn         LONGTEXT NOT NULL DEFAULT (''),
  category              VARCHAR(255) NOT NULL DEFAULT '',
  categoryEn            VARCHAR(255) NOT NULL DEFAULT '',
  status                VARCHAR(32) NOT NULL DEFAULT 'draft'
                      CHECK (status IN ('active','draft','coming_soon','closed','archived','completed')),
  targetSectors         LONGTEXT NOT NULL DEFAULT ('[]'),
  targetSectorsEn       LONGTEXT NOT NULL DEFAULT ('[]'),
  targetGovernorates    LONGTEXT NOT NULL DEFAULT ('[]'),
  budgetTotalEGP        DOUBLE NOT NULL DEFAULT 0 CHECK (budgetTotalEGP >= 0),
  budgetAllocatedEGP    DOUBLE NOT NULL DEFAULT 0 CHECK (budgetAllocatedEGP >= 0),
  startDate             VARCHAR(32) NOT NULL DEFAULT '',
  endDate               VARCHAR(32) NOT NULL DEFAULT '',
  coverImage            VARCHAR(1024) NOT NULL DEFAULT '/covers/solar-2026.svg',
  badgeTextAr           VARCHAR(1024) NOT NULL DEFAULT '',
  badgeTextEn           VARCHAR(1024) NOT NULL DEFAULT '',
  participatingOrgs     LONGTEXT NOT NULL DEFAULT ('[]'),
  benefits              LONGTEXT NOT NULL DEFAULT ('[]'),
  faqs                  LONGTEXT NOT NULL DEFAULT ('[]'),
  preEligibilityQuestions LONGTEXT NOT NULL DEFAULT ('[]'),
  requiredDocsList      LONGTEXT NOT NULL DEFAULT ('[]'),
  formSections          LONGTEXT NOT NULL DEFAULT ('[]'),
  impactMetrics         LONGTEXT NOT NULL DEFAULT ('{}'),
  customization         LONGTEXT NOT NULL DEFAULT ('{"requireDetailsFile":false,"maxFileSizeMB":15,"allowedFileTypes":".pdf"}'),
  workflow              LONGTEXT NOT NULL DEFAULT ('{"version":1,"stages":[]}'),
  objectives            LONGTEXT NOT NULL DEFAULT ('[]'),
  eligibilityRequirements LONGTEXT NOT NULL DEFAULT ('[]'),
  selectionCriteria     LONGTEXT NOT NULL DEFAULT ('[]'),
  financialTerms        LONGTEXT NOT NULL DEFAULT ('{}'),
  executionNotesAr      LONGTEXT NOT NULL DEFAULT (''),
  executionNotesEn      LONGTEXT NOT NULL DEFAULT (''),
  kpis                  LONGTEXT NOT NULL DEFAULT ('[]'),
  createdAt             VARCHAR(32) NOT NULL DEFAULT '',
  updatedAt             VARCHAR(32) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_initiatives_status ON initiatives(status);

CREATE TABLE IF NOT EXISTS factories (
  id        VARCHAR(64) PRIMARY KEY,
  data      LONGTEXT NOT NULL DEFAULT ('{}'),
  createdAt VARCHAR(32) NOT NULL DEFAULT '',
  updatedAt VARCHAR(32) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS details_files (
  id            VARCHAR(64) PRIMARY KEY,
  factoryId     VARCHAR(64) NOT NULL,
  fileName      VARCHAR(1024) NOT NULL,
  fileSize      VARCHAR(64) NOT NULL DEFAULT '',
  description   LONGTEXT NOT NULL DEFAULT (''),
  initiativeId  VARCHAR(64) NULL,
  applicationId VARCHAR(64) NULL,
  storedPath    VARCHAR(1024) NOT NULL DEFAULT '',
  uploadedAt    VARCHAR(32) NOT NULL DEFAULT '',
  uploadedBy    VARCHAR(64) NOT NULL DEFAULT 'unknown',
  status        VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  CONSTRAINT fk_files_factory FOREIGN KEY (factoryId) REFERENCES factories(id) ON DELETE CASCADE,
  CONSTRAINT fk_files_initiative FOREIGN KEY (initiativeId) REFERENCES initiatives(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_files_factory ON details_files(factoryId);
CREATE INDEX idx_files_app ON details_files(applicationId);

CREATE TABLE IF NOT EXISTS applications (
  id                     VARCHAR(64) PRIMARY KEY,
  applicationNumber      VARCHAR(64) NOT NULL UNIQUE,
  initiativeId           VARCHAR(64) NOT NULL,
  initiativeTitleAr      TEXT NOT NULL DEFAULT '',
  factoryId              VARCHAR(64) NOT NULL,
  factoryNameAr          TEXT NOT NULL DEFAULT '',
  factorySectorAr        VARCHAR(255) NOT NULL DEFAULT '',
  factoryGovernorateAr   VARCHAR(255) NOT NULL DEFAULT '',
  currentStageId         VARCHAR(64) NOT NULL DEFAULT 'stage-1',
  currentStageNameAr     TEXT NOT NULL DEFAULT '',
  status                 VARCHAR(32) NOT NULL DEFAULT 'submitted',
  currentAssignedOrgId   VARCHAR(64) NOT NULL DEFAULT 'org-ida',
  currentAssignedOrgNameAr TEXT NOT NULL DEFAULT '',
  slaDays                INT NOT NULL DEFAULT 3,
  submittedAt            VARCHAR(32) NOT NULL DEFAULT '',
  updatedAt              VARCHAR(32) NOT NULL DEFAULT '',
  formData               LONGTEXT NOT NULL DEFAULT ('{}'),
  detailsFileIds         LONGTEXT NOT NULL DEFAULT ('[]'),
  timeline               LONGTEXT NOT NULL DEFAULT ('[]'),
  CONSTRAINT fk_apps_initiative FOREIGN KEY (initiativeId) REFERENCES initiatives(id) ON DELETE RESTRICT,
  CONSTRAINT fk_apps_factory FOREIGN KEY (factoryId) REFERENCES factories(id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_apps_initiative ON applications(initiativeId);
CREATE INDEX idx_apps_status ON applications(status);
CREATE INDEX idx_apps_org ON applications(currentAssignedOrgId);
CREATE INDEX idx_apps_factory ON applications(factoryId);

CREATE TABLE IF NOT EXISTS messages (
  id            VARCHAR(64) PRIMARY KEY,
  applicationId VARCHAR(64) NOT NULL,
  fromUserId    VARCHAR(64) NOT NULL DEFAULT '',
  fromOrgId     VARCHAR(64) NOT NULL DEFAULT '',
  toOrgId       VARCHAR(64) NOT NULL DEFAULT '',
  subject       VARCHAR(1024) NOT NULL DEFAULT '',
  body          LONGTEXT NOT NULL DEFAULT (''),
  customFields  LONGTEXT NOT NULL DEFAULT ('{}'),
  detailsFileId VARCHAR(64) NULL,
  createdAt     VARCHAR(32) NOT NULL DEFAULT '',
  CONSTRAINT fk_messages_app FOREIGN KEY (applicationId) REFERENCES applications(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_messages_app ON messages(applicationId);
CREATE INDEX idx_messages_to ON messages(toOrgId);

-- مركز المراسلات (5c): محادثة ثنائية بين أي جهتين، الزوج مرتب (orgA < orgB) وفريد.
CREATE TABLE IF NOT EXISTS chat_conversations (
  id                 VARCHAR(64) PRIMARY KEY,
  orgA               VARCHAR(64) NOT NULL,
  orgB               VARCHAR(64) NOT NULL,
  lastMessageAt      VARCHAR(32) NOT NULL DEFAULT '',
  lastMessagePreview TEXT NOT NULL DEFAULT '',
  lastSenderOrgId    VARCHAR(64) NOT NULL DEFAULT '',
  readA              VARCHAR(32) NOT NULL DEFAULT '',
  readB              VARCHAR(32) NOT NULL DEFAULT '',
  reminderSentA      VARCHAR(32) NOT NULL DEFAULT '',
  reminderSentB      VARCHAR(32) NOT NULL DEFAULT '',
  reminderAttemptA   VARCHAR(32) NOT NULL DEFAULT '',
  reminderAttemptB   VARCHAR(32) NOT NULL DEFAULT '',
  createdAt          VARCHAR(32) NOT NULL DEFAULT '',
  UNIQUE (orgA, orgB),
  CHECK (orgA < orgB),
  CONSTRAINT fk_chat_conv_a FOREIGN KEY (orgA) REFERENCES organizations(id) ON DELETE CASCADE,
  CONSTRAINT fk_chat_conv_b FOREIGN KEY (orgB) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS chat_messages (
  id             VARCHAR(64) PRIMARY KEY,
  conversationId VARCHAR(64) NOT NULL,
  senderUserId   VARCHAR(64) NOT NULL DEFAULT '',
  senderOrgId    VARCHAR(64) NOT NULL DEFAULT '',
  body           LONGTEXT NOT NULL DEFAULT (''),
  createdAt      VARCHAR(32) NOT NULL DEFAULT '',
  CONSTRAINT fk_chat_msg_conv FOREIGN KEY (conversationId) REFERENCES chat_conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_chat_messages_conv ON chat_messages(conversationId, createdAt);

CREATE TABLE IF NOT EXISTS chat_attachments (
  id         VARCHAR(64) PRIMARY KEY,
  messageId  VARCHAR(64) NOT NULL,
  fileName   VARCHAR(1024) NOT NULL,
  mimeType   VARCHAR(255) NOT NULL,
  sizeBytes  INT NOT NULL DEFAULT 0,
  storedPath VARCHAR(1024) NOT NULL,
  createdAt  VARCHAR(32) NOT NULL DEFAULT '',
  CONSTRAINT fk_chat_att_msg FOREIGN KEY (messageId) REFERENCES chat_messages(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_chat_attachments_msg ON chat_attachments(messageId);

CREATE TABLE IF NOT EXISTS email_outbox (
  id            VARCHAR(64) PRIMARY KEY,
  kind          VARCHAR(64) NOT NULL,
  refType       VARCHAR(64) NOT NULL DEFAULT '',
  refId         VARCHAR(64) NOT NULL DEFAULT '',
  recipients    LONGTEXT NOT NULL DEFAULT ('[]'),
  subject       VARCHAR(1024) NOT NULL,
  html          LONGTEXT NOT NULL,
  text          LONGTEXT NOT NULL DEFAULT (''),
  status        VARCHAR(32) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  attempts      INT NOT NULL DEFAULT 0,
  lastError     TEXT NOT NULL,
  nextAttemptAt VARCHAR(32) NOT NULL DEFAULT '',
  createdAt     VARCHAR(32) NOT NULL DEFAULT '',
  sentAt        VARCHAR(32) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_email_outbox_due ON email_outbox(status, nextAttemptAt);
CREATE INDEX idx_email_outbox_ref ON email_outbox(refType, refId);

CREATE TABLE IF NOT EXISTS home_banners (
  id          VARCHAR(64) PRIMARY KEY,
  imageUrl    LONGTEXT NOT NULL,
  titleAr     TEXT NOT NULL DEFAULT '',
  titleEn     TEXT NOT NULL DEFAULT '',
  subtitleAr  TEXT NOT NULL DEFAULT '',
  subtitleEn  TEXT NOT NULL DEFAULT '',
  ctaLabelAr  VARCHAR(255) NOT NULL DEFAULT '',
  ctaLabelEn  VARCHAR(255) NOT NULL DEFAULT '',
  linkType    VARCHAR(32) NOT NULL DEFAULT 'none' CHECK (linkType IN ('none','initiative','url')),
  linkTarget  VARCHAR(1024) NOT NULL DEFAULT '',
  placement   VARCHAR(32) NOT NULL DEFAULT 'before_about' CHECK (placement IN ('before_about','before_steps','before_cta')),
  sortOrder   INT NOT NULL DEFAULT 0,
  active      TINYINT(1) NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  startsAt    VARCHAR(32) NOT NULL DEFAULT '',
  endsAt      VARCHAR(32) NOT NULL DEFAULT '',
  createdAt   VARCHAR(32) NOT NULL DEFAULT '',
  updatedAt   VARCHAR(32) NOT NULL DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id         VARCHAR(64) PRIMARY KEY,
  timestamp  VARCHAR(32) NOT NULL DEFAULT '',
  userId     VARCHAR(64) NOT NULL DEFAULT 'unknown',
  userName   TEXT NOT NULL DEFAULT 'unknown',
  ip         VARCHAR(64) NOT NULL DEFAULT '',
  actionType VARCHAR(64) NOT NULL DEFAULT '',
  entityType VARCHAR(64) NOT NULL DEFAULT '',
  entityId   VARCHAR(64) NOT NULL DEFAULT '',
  summaryAr  TEXT NOT NULL DEFAULT '',
  beforeJson LONGTEXT NOT NULL,
  afterJson  LONGTEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_audit_entity ON audit_logs(entityType, entityId);
CREATE INDEX idx_audit_time ON audit_logs(timestamp DESC);

-- سجل التدقيق append-only — منع التعديل/المسح على مستوى القاعدة (single-statement
-- triggers so schema files stay splittable on `;`).
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only';

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id         VARCHAR(64) PRIMARY KEY,
  userId     VARCHAR(64) NOT NULL,
  tokenHash  VARCHAR(255) NOT NULL,
  expiresAt  VARCHAR(32) NOT NULL DEFAULT '',
  revoked    TINYINT(1) NOT NULL DEFAULT 0 CHECK (revoked IN (0,1)),
  createdAt  VARCHAR(32) NOT NULL DEFAULT '',
  CONSTRAINT fk_refresh_user FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE INDEX idx_refresh_user ON refresh_tokens(userId);

CREATE TABLE IF NOT EXISTS meta (
  `key`   VARCHAR(191) PRIMARY KEY,
  `value` LONGTEXT NOT NULL DEFAULT ('')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
