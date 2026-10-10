<div dir="rtl">

# دليل الترحيل إلى MySQL — MySQL Migration Runbook

> هذا الدليل يشرح تشغيل المنصة على MySQL (سيرفر مشترك / إنتاج) بدل SQLite (ملف محلي — الوضع الافتراضي).
> القاعدة الذهبية: **البذور لا تمس بياناتك أبداً** — `INSERT OR IGNORE` + أعلام `meta`، ولا تُكتب فوق مستخدم أو كلمة مرور أو تعديل أدمن. المسار المدمّر الوحيد هو `db:reset` (مرفوض في الإنتاج).

## 1) المتطلبات — Prerequisites

| البند | المطلوب |
|---|---|
| MySQL | `≥ 8.0.16` (يفرض `CHECK` ويدعم `TEXT` defaults) |
| الترميز | القاعدة تُنشأ حصراً بـ `CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` (العربية + الإيموجي) |
| صلاحيات المستخدم | `CREATE, ALTER, INDEX, TRIGGER` على قاعدة التطبيق + `CREATE` على مستوى السيرفر لأول إنشاء (`mysql-init`) |
| Node | نفس نسخة المشروع + حزمة `mysql2` (موجودة في `backend/package.json`) |

إنشاء القاعدة والمستخدم (نفّذها كـ root):

```sql
CREATE DATABASE IF NOT EXISTS `industry_platform`
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS 'industry_app'@'%' IDENTIFIED BY 'ضع-كلمة-سر-قوية-هنا';
GRANT ALL PRIVILEGES ON `industry_platform`.* TO 'industry_app'@'%';
FLUSH PRIVILEGES;
```

> ملاحظة: `npm run db:mysql:init` ينفّذ `CREATE DATABASE IF NOT EXISTS` تلقائياً، لكنه يحتاج صلاحية `CREATE` — إن رُفضت، أنشئ القاعدة يدوياً بالأمر أعلاه ثم أعد التشغيل.

## 2) التركيب الجديد — Fresh install (قاعدة فارغة)

```bash
cd backend
# 1) المتغيرات (أو في backend/.env — انسخ من backend/.env.example)
export DB_DRIVER=mysql
export MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306
export MYSQL_USER=industry_app MYSQL_PASSWORD='...' MYSQL_DATABASE=industry_platform

# 2) إنشاء القاعدة + السكيما
npm run db:mysql:init

# 3) البذرة الأولى (حسابات الديمو + مبادرة شمس الصناعة)
npm run db:seed

# 4) فحص
npm run db:ping
```

## 3) مشروع قائم — Existing project (نقل من SQLite)

```bash
cd backend
export MYSQL_USER=industry_app MYSQL_PASSWORD='...' MYSQL_DATABASE=industry_platform
# (اختياري) SQLITE_PATH — الافتراضي DB_PATH ثم ./data/app.db

# 1) نسخة احتياطية من ملف SQLite (تلقائية داخل أداة النقل ما لم تُمرَّر --skip-backup)
npm run db:backup

# 2) النقل + التحقق (النص التالي يفشل بخروج 1 عند أي عدم تطابق)
npm run db:mysql:migrate
# خيارات: --dry-run (عدّ فقط) --tables=users,applications --batch-size=500 --skip-backup

# 3) تحديثات البذرة فقط (تضيف الناقص — لا تمس المستخدمين ولا كلمات المرور)
DB_DRIVER=mysql npm run db:seed

# 4) بدّل التشغيل إلى MySQL
export DB_DRIVER=mysql
npm run db:ping
npm run dev
```

> أثناء النقل: المصدر يُفتح **read-only** ولا يُعدَّل أبداً. الكتابة `REPLACE INTO` بالمفتاح الأساسي — إعادة التشغيل آمنة (idempotent).

## 4) جدول المتغيرات — Environment variables

| المتغير | الافتراضي | الوصف |
|---|---|---|
| `DB_DRIVER` | `sqlite` | `sqlite` (ملف) أو `mysql` (سيرفر) |
| `DB_PATH` | `./data/app.db` | مسار ملف SQLite (وضع sqlite فقط) |
| `SQLITE_PATH` | _(يتبع `DB_PATH`)_ | مصدر النقل في `db:mysql:migrate` |
| `MYSQL_HOST` | `127.0.0.1` | مضيف MySQL (`mysql` داخل compose مع profile) |
| `MYSQL_PORT` | `3306` | المنفذ |
| `MYSQL_USER` | _(مطلوب)_ | المستخدم — غيابه = خروج `2` |
| `MYSQL_PASSWORD` | _(فارغ)_ | كلمة السر (لا تُحفظ في أي مثال) |
| `MYSQL_DATABASE` | _(مطلوب)_ | القاعدة — غيابها = خروج `2` |
| `MYSQL_POOL_SIZE` | `10` | حجم الـ pool |

## 5) جدول الأوامر — npm commands

| الأمر | الوظيفة |
|---|---|
| `npm run db:ping` | فحص السائق + `SELECT 1` (+ عدد المستخدمين ونسخة السيرفر لـ MySQL) |
| `npm run db:mysql:init` | إنشاء القاعدة (utf8mb4) + السكيما — لمشروع جديد |
| `npm run db:mysql:migrate` | نقل SQLite → MySQL + تحقق عددي وفحص مفاتيح |
| `npm run db:migrate` | تجهيز سكيما SQLite (الوضع الافتراضي) |
| `npm run db:seed` | بذرة آمنة (تخطٍّ إن مزروعة + تحديثات مرقّمة فقط) |
| `npm run db:backup` | نسخة من ملف SQLite إلى `data/backups/app-YYYYMMDD-HHmmss.db` |
| `npm run db:reset` | **مدمّر + مرفوض في الإنتاج** — مسح كامل ثم بذرة (تطوير فقط) |

## 6) الرجوع — Rollback (عودة إلى SQLite)

1. أوقف الخدمة.
2. احذف/علّق `DB_DRIVER=mysql` (أو ضعه `sqlite`) — الكود يعود للملف تلقائياً.
3. إن لزم: استعد نسخة `data/backups/app-*.db` مكان `DB_PATH`.
4. شغّل `npm run db:ping` للتأكد (`driver: sqlite`).

## 7) استكشاف الأخطاء — Troubleshooting

| العرض | السبب / الحل |
|---|---|
| `DB_DRIVER=mysql requires MYSQL_USER + MYSQL_DATABASE` (خروج 2) | عرّف المتغيرين في البيئة أو `.env` |
| `Access denied for user` | المستخدم/كلمة السر خطأ، أو الصلاحيات ناقصة — أعد `GRANT ALL` ثم `FLUSH PRIVILEGES` |
| `Unknown database` | أنشئها يدوياً (قسم 1) أو شغّل `db:mysql:init` بمستخدم يملك `CREATE` |
| ترميز مكسور (‏`????`‏) للعربية | القاعدة/الاتصال ليست utf8mb4 — أعد الإنشاء بالأمر الموثّق (الأداة تضبط `SET NAMES utf8mb4`) |
| `Duplicate foreign key constraint name (1826)` | تجاهل مقصود أثناء `init` (idempotent) — لا تفعل شيئاً إن انتهى الأمر بـ `schema OK` |
| `Trigger already exists (1359)` / `Duplicate key (1050/1061)` | نفس الشيء — إعادة تشغيل آمنة |
| `MISMATCH` في عدّ جدول بعد النقل | أعد النقل (idempotent)؛ إن تكرر افحص `max_allowed_packet` أو قلّل `--batch-size` |
| `FK violation applications.factoryId` | صفوف يتيمة في المصدر — نظّفها في SQLite أولاً ثم أعد النقل |

## 8) الملفات التي تغيّرت — File-change list

### طبقة قاعدة البيانات (جديد)
- `backend/src/db/database.ts` — **جديد**: طبقة `async` موحدة (`dbGet/dbAll/dbRun/dbExec/dbTransaction/initDatabase/pingDatabase/closeDb`) تختار السائق من `DB_DRIVER`. ترجمة تلقائية (`INSERT OR IGNORE` ← `INSERT IGNORE`، `COLLATE NOCASE` يُحذف لـ MySQL، `IF NOT EXISTS` للفهارس/الـ triggers). معاملات عبر `AsyncLocalStorage` (اتصال مخصص لـ MySQL، وقفل تسلسلي لـ SQLite).
- `backend/src/db/schema.mysql.sql` — **جديد**: توأم `schema.sql` لـ MySQL ≥ 8.0.16 (‏`utf8mb4_unicode_ci`، ‏`VARCHAR(64)` للمفاتيح، ‏`LONGTEXT` للـ JSON، ‏`VARCHAR(32)` للتواريخ ISO، ‏`TINYINT(1)` للأعلام، triggers أحادية العبارة لسجل التدقيق).
- `backend/src/middleware/asyncHandler.ts` — **جديد**: مغلّف `ah()` (‏Express 4 لا يلتقط رفض الـ Promises).
- `backend/src/config.ts` — `dbDriver` + `mysql` ( host/port/user/password/database/pool ) مع فشل سريع عند نقص `MYSQL_USER`/`MYSQL_DATABASE` مع `DB_DRIVER=mysql`.
- `backend/src/store/helpers.ts` — نوع `SqlParam` يُعاد تصديره من `database.js`.

### التحويل الميكانيكي (نفس الأسماء + `async`/`await`)
- كل `src/store/*.ts` (‏13 ملفاً) + `src/services/factoryNotify.ts` + `src/routes/*.ts` (‏10) + `src/middleware/auth.ts` + `src/jobs/*.ts` + `src/index.ts` + `db/{migrate,reset,seed-cli,seed-file-cli}.ts` + `scripts/seed-from-file.ts` — نفس المنطق والعقود، فقط `async`.
- إصلاحات قابلية النقل: `ORDER BY rowid` ← `createdAt/id`، `json_each` ← `INSTR(timeline,…)` لـ MySQL، `BEGIN IMMEDIATE` ← `dbTransaction`، `meta.key` بين backticks، `m.rowid` للشات ← مؤشر `createdAt+id`، `+1ms` للمرفقات المتزامنة، `MAX(createdAt)` monotonic للرسائل.
- `backend/tests/*` — `await` فقط (بدون تغيير التوقعات)، ما عدا تحديث heuristic واحد: `BEGIN IMMEDIATE` ← `dbTransaction` في فحص P0-6.

### البذور والأدوات ( aforementioned + )
- `backend/src/db/seed.ts` — نفس البذرة لكن `async` عبر `database.js` (أعلام `meta` نفسها، `INSERT OR IGNORE` نفسه)
- `backend/src/db/seedFromFile.ts` — نفس التحويل (`await` للبذرة/القرارات/الحوكمة)
- `backend/src/db/seed-cli.ts` + `reset.ts` + `seed-file-cli.ts` + `scripts/seed-from-file.ts` — انتظار النسخ الـ async (تغليف `main()` فقط)
- `backend/scripts/migrate-sqlite-to-mysql.ts` — **جديد**: أداة النقل (node:sqlite للقراءة + mysql2 للكتابة)
- `backend/scripts/mysql-init.ts` — **جديد**: إنشاء القاعدة + السكيما لمشروع جديد
- `backend/scripts/db-ping.ts` — **جديد**: فحص الاتصال
- `backend/scripts/backup-sqlite.ts` — **جديد**: نسخة احتياطية للملف
- `backend/tests/helpers.ts` — `await seedIfEmpty()` قبل الإقلاع
- `.env.example` + `docker-compose.yml` + `docker-compose.vps.yml` — تمرير `DB_DRIVER`/`MYSQL_*` (خدمة `mysql` اختيارية عبر `--profile mysql`)
- `Dockerfile` (الجذر) + `backend/Dockerfile` — **بلا تغيير**: `copy-schema.mjs` ينسخ `schema.sql` و`schema.mysql.sql` معاً إلى `dist/db`، وصور الـ runtime تنسخ `dist` كاملاً — السكيما التوأم تُشحن تلقائياً
- `seed-data.json` — **لم يُمس**

## 9) نتائج التحقق — Verification results (‏10 أكتوبر 2026)

- `npx tsc --noEmit` نظيف + `npm run build` ينسخ السكيمتين إلى `dist/db`.
- مجموعة الاختبارات على SQLite: **166/166 ناجحة** (`npm test`).
- ترحيل حقيقي SQLite → MariaDB 10.4 (قريب MySQL 8): ‏49 صفاً، كل العدّادات متطابقة، فحوصات FK الأربعة سليمة، `migration verified OK`.
- ‏API حقيقي على MySQL: دخول بكلمة مرور مزروعة (bcrypt)، عربية كاملة ذهاباً وإياباً (utf8mb4)، ترقيم صفحات، دورة طلب (إنشاء ← اعتماد مبدئي ← تقدّم `stage-sh1` ← `stage-sh2`)، دليل شات + رسالة عربية — **12/12 ناجحة**.
- تثبيت جديد على قاعدة فارغة: `db:seed` أنشأ السكيما + زرع 14 مستخدماً، وإعادة التشغيل تُتخطى (idempotent).

> بيئة التحقق المتاحة كانت MariaDB 10.4 (متوافقة بروتوكولياً مع mysql2) بدل MySQL 8 — كل المسارات نجحت عليها. هدف الإنتاج يبقى **MySQL ≥ 8.0.16** حصراً (فرض `CHECK` و`TEXT` defaults)، والسكيما مكتوبة بلهجته الأصلية (`CREATE INDEX` بلا `IF NOT EXISTS`، triggers أحادية).

> ملاحظة سلوكية واحدة كشفها التحقق: التصعيد (`escalate`) لطلب ما زال `submitted` كان يُبقيه `submitted` (الكود يقول «لا تغيير حالة» بينما اختبار دورة البذرة يتوقع `in_progress`). الإصلاح: التصعيد من `submitted` ينقل إلى `in_progress` (الطلب قيد المعالجة) — دون أي أثر على الطلبات المتقدمة أو باقي الاختبارات (166/166).

</div>
