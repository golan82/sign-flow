# פיתוח ובדיקות

מסמך זה מפרט את הפיתוח המקומי, את פרטי הרצת ה־Docker, את הבדיקות ואת
תוצאותיהן. להרצה המהירה ב־Docker ראו את [README](../README.md).

## דרישות מוקדמות

- **Node.js `^22.18.0 || ^24.0.0 || >=26.0.0`** (`engines` ב־`package.json`).
  זה החיתוך של דרישות הכלים: Vitest 5 (`^22.12 || ^24 || >=26`), ESLint 9
  (`^20.19 || ^22.13 || >=24`), Next.js 16 (`>=20.9`), וקובצי ה־`.mts` שרצים
  ישירות ב־Node וצריכים הסרת טיפוסים מובנית (פעילה כברירת מחדל מ־22.18). הפיתוח
  נעשה עם Node.js 24.14.0.
- npm (הפיתוח נעשה עם npm 11.9.0).
- Docker Desktop עם Linux containers (למסד המקומי).
- Git.

## פיתוח מקומי (Windows PowerShell)

Next.js וה־worker רצים ישירות ב־Windows, ורק MongoDB רץ ב־Docker
(`compose.dev.yaml`, דרך `npm run db:up` / `db:stop`). PowerShell עלול לחסום את
`npm.ps1` ו־`npx.ps1`, ולכן משתמשים ב־`npm.cmd` וב־`npx.cmd`.

### הרצה ראשונה

```powershell
npm.cmd ci                        # התקנה; postinstall מריץ prisma generate
Copy-Item .env.example .env       # DATABASE_URL ו־TEST_DATABASE_URL (מוחרג מ־Git)
# הכניסו סוד אקראי ל־UPLOAD_SIGNING_SECRET ב־.env, למשל:
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
npm.cmd run db:up                 # הפעלת MongoDB והמתנה עד PRIMARY
npm.cmd run db:push               # החלת הסכמה (אינדקסים) על מסד הפיתוח
npm.cmd run dev                   # http://localhost:3000
npm.cmd run worker:claims         # בטרמינל שני: ה־worker לפקיעת תפיסות
```

פורט 27017 על `127.0.0.1` חייב להיות פנוי:

```powershell
Get-NetTCPConnection -LocalPort 27017 -State Listen -ErrorAction SilentlyContinue
```

### הרצות הבאות

```powershell
npm.cmd run db:up
npm.cmd run dev
npm.cmd run worker:claims         # טרמינל שני; Ctrl+C עוצר בצורה מסודרת
```

אחרי שינוי ב־`prisma/schema.prisma` מריצים `npm.cmd run db:push` (פיתוח)
ו־`npm.cmd run db:push:test` (בדיקות; רץ אוטומטית גם ב־`test:integration`).

### אפשרויות ה־worker

```powershell
npm.cmd run worker:claims                 # לולאה; Ctrl+C עוצר אחרי הסריקה הנוכחית
npm.cmd run worker:claims -- --once       # סריקה אחת ויציאה
$env:CLAIM_SWEEP_INTERVAL_MS = "2000"; npm.cmd run worker:claims   # ברירת מחדל 5000 ms
```

ב־Windows, Ctrl+C שולח SIGINT. `taskkill /F` אינו מאפשר עצירה מסודרת.

### עצירת המסד (הנתונים נשמרים)

```powershell
npm.cmd run db:stop               # docker compose -f compose.dev.yaml stop mongodb
```

גם `docker compose -f compose.dev.yaml down` (ללא `-v`) שומר את הנתונים: הוא
מסיר את הקונטיינר והרשת, אבל לא את ה־volumes.

> **אזהרה:** `docker compose -f compose.dev.yaml down -v` או
> `docker volume rm sign-flow_mongodb_data` **מוחקים לצמיתות את כל נתוני
> הפיתוח המקומיים.**

## הרצה מלאה ב־Docker: פרטים

ההוראות המהירות נמצאות ב־[README](../README.md).

| פעולה | פקודה |
| --- | --- |
| מצב | `docker compose ps` |
| לוגים (הכול / שירות אחד) | `docker compose logs -f` / `docker compose logs -f app` (או `worker`, `mongodb`, `schema`) |
| עצירה, **הנתונים נשמרים** | `docker compose stop` |
| הפעלה מחדש | `docker compose up -d --wait` |
| הפעלה מחדש של האפליקציה וה־worker | `docker compose restart app worker` |
| בנייה מחדש אחרי שינויי קוד | `docker compose up -d --build --wait` |
| הסרת קונטיינרים ורשת, **הנתונים נשמרים** | `docker compose down` |

> **אזהרה:** `docker compose down -v` מוחק את ה־volumes של הפרויקט
> (`signflow_mongodb_data`, `signflow_mongodb_config`) ואיתם **את כל הנתונים**
> של הרצת ה־Docker. הוא אינו נוגע במסד הפיתוח.

### השירותים

`docker-compose.yml`, פרויקט Compose בשם `signflow`:

| שירות | יעד באימג' | תפקיד |
| --- | --- | --- |
| `mongodb` | `mongo:8.0.38` | replica set בצומת יחיד `rs0`, חבר `mongodb:27017`; **ללא פורט חיצוני** |
| `schema` | `schema` | `prisma db push` חד־פעמי (אינדקסים), ואז יציאה עם 0 |
| `app` | `app` | שרת Next.js standalone, מפורסם על `127.0.0.1:${APP_PORT:-3080}` |
| `worker` | `worker` | ה־worker לפקיעת תפיסות |

סדר ההפעלה מבוסס על מוכנות אמיתית, ללא המתנות קבועות: `mongodb` תקין רק כשה־replica
set מאותחל ו־PRIMARY, אחר כך `schema` חייב להסתיים בהצלחה, ואז `app` ו־`worker`
מופעלים. `app` תקין כש־`GET /api/orders` עונה (מה שמוכיח גם את החיבור למסד).
`--wait` חוזר בנקודה הזו.

> **תצורת הדגמה מקומית, לא פריסה ציבורית מאובטחת:** ל־MongoDB אין אימות (נגיש
> רק בתוך רשת ה־Compose), אין TLS, והאפליקציה מפורסמת על 127.0.0.1 בלבד.

### בניית האימג'ים

`Dockerfile` רב־שלבי, על בסיס `node:24.14.0-bookworm-slim` (אותה גרסת Node.js
כמו בפיתוח), עם `openssl` עבור מנוע Prisma ו־`tini`:

- `deps`: `npm ci` (ה־`postinstall` מריץ `prisma generate` ל־Linux).
- `builder`: `next build` עם `BUILD_STANDALONE=1`, כלומר `output: "standalone"`.
  הבנייה אינה צריכה מסד ואינה צריכה `UPLOAD_SIGNING_SECRET`.
- `app`: רק שרת ה־standalone והקבצים הסטטיים (כ־130 MB).
- `worker`: רק `scripts/claim-expiry-worker.mts`, שני המודולים המשותפים שהוא
  מייבא (`src/lib/claims/store.mts`, `constants.mts`) ו־Prisma Client שנוצר
  (כ־115 MB). Node מריץ את קובצי ה־`.mts` ישירות (הסרת טיפוסים).
- `schema`: עץ התלויות המלא (Prisma CLI), לשימוש פעם אחת בכל הפעלה.
- כל יעדי הריצה רצים כמשתמש `node` ללא הרשאות, עם `tini` כ־PID 1 שמעביר את
  `SIGTERM`. ב־`docker compose stop` ה־worker מסיים את הסריקה הנוכחית ויוצא
  עם 0. האפליקציה יוצאת על האות (ל־Next.js standalone אין hook לכיבוי; קוד
  יציאה 143).
- `.dockerignore` מחריג מהקשר הבנייה את `.env*`, `node_modules`, `.next`, תוצאות
  בדיקות, נתוני Git ואת `docs`. אף קובץ `.env` אינו מועתק לאימג'.
  `UPLOAD_SIGNING_SECRET` מגיע לאפליקציה רק כמשתנה סביבה בזמן ריצה מ־`.env`
  (Compose מסרב להפעיל את האפליקציה בלעדיו).

### פיתוח לעומת הרצה מלאה ב־Docker

| | פיתוח מקומי (Windows) | הרצה מלאה ב־Docker |
| --- | --- | --- |
| קובץ ופרויקט Compose | `compose.dev.yaml` / `sign-flow` | `docker-compose.yml` / `signflow` |
| מה רץ ב־Docker | MongoDB בלבד | MongoDB, schema, app, worker |
| אפליקציה ו־worker | `npm run dev`, `npm run worker:claims` ב־Windows | קונטיינרים |
| פורט MongoDB | `127.0.0.1:27017` | לא מפורסם |
| חבר ה־replica set | `127.0.0.1:27017` | `mongodb:27017` |
| Volumes | `sign-flow_mongodb_data`, `sign-flow_mongodb_config` | `signflow_mongodb_data`, `signflow_mongodb_config` |
| כתובת המסד | `DATABASE_URL` ב־`.env` (127.0.0.1) | מוגדרת ב־`docker-compose.yml` (`mongodb`) |

כתובת החבר ב־replica set נשמרת בתוך כל volume כשה־set מאותחל, והדרייברים עוברים
לכתובת הזו אחרי הגילוי. תהליכי Windows צריכים `127.0.0.1:27017`, וקונטיינרים
צריכים `mongodb:27017`. לכן שתי התצורות משתמשות **ב־volumes נפרדים**.
`docker/mongodb/replica-set.js` לעולם אינו מגדיר מחדש set קיים: אם volume אותחל
עם כתובת אחרת, הוא נשאר לא תקין ורושם את אי ההתאמה בלוג. שתי התצורות יכולות לרוץ
בו־זמנית (פורטים שונים).

## המסד

### למה replica set

replica set הוא קבוצת תהליכי `mongod` שמחזיקים את אותם נתונים, עם PRIMARY אחד
שמקבל כתיבות. MongoDB תומך בטרנזקציות מרובות מסמכים רק ב־replica set, וה־connector
של Prisma ל־MongoDB משתמש בטרנזקציות בכתיבות מקוננות. גם Change Streams דורשים
replica set. בשרת עצמאי Prisma נכשל עם `Transactions are not supported by this
deployment`. לכן מקומית רץ replica set **בצומת יחיד** בשם `rs0`, שהוא תמיד
PRIMARY.

### ההגדרה

- `mongod --replSet rs0` רץ בשירות `mongodb` של כל אחד מקובצי ה־Compose. הנתונים
  נשמרים ב־volumes של אותו פרויקט (`/data/db` ו־`/data/configdb`).
- `docker/mongodb/replica-set.js` הוא ה־healthcheck של הקונטיינר. הוא קורא
  ל־`rs.initiate()` רק אם ה־set עדיין לא מאותחל (בטוח להרצה חוזרת), מדווח תקין
  רק כשהצומת PRIMARY, ומסרב (נשאר לא תקין, יציאה 2) אם ה־set ב־volume משתמש
  בכתובת חבר שונה מ־`MONGO_REPLICA_HOST`. הוא לעולם אינו מגדיר מחדש בשקט.
  להרצה ידנית (פיתוח):

  ```powershell
  docker compose -f compose.dev.yaml exec mongodb mongosh --quiet --file /docker/replica-set.js
  ```

- עם `?replicaSet=rs0` הדרייבר פונה קודם לכתובת ההתחלתית, מגלה את החברים מתצורת
  ה־replica set, ואז מתחבר לכתובת החבר המפורסמת. בפיתוח זו `127.0.0.1:27017`,
  ובהרצה המלאה `mongodb:27017` (נקבע דרך `MONGO_REPLICA_HOST`
  ב־`docker-compose.yml`). אם משנים את פורט הפיתוח, יש לשנות אותו
  ב־`compose.dev.yaml`, ב־`MONGO_REPLICA_HOST` או בברירת המחדל של הסקריפט ובשתי
  הכתובות, ולהשתמש ב־volume חדש.

### Prisma

- הסכמה: `prisma/schema.prisma` (ספק MongoDB).
- שינויי סכמה מוחלים ב־`prisma db push` (`db:push`, `db:push:test`).
  `prisma migrate` אינו נתמך ב־MongoDB. `db push` יוצר אינדקסים, אבל אינו כותב
  מחדש מסמכים קיימים.
- קוד השרת מייבא את הלקוח המשותף מ־`@/lib/prisma`. הוא מסומן `server-only`
  וממחזר `PrismaClient` אחד בין טעינות חמות בפיתוח.

## משתני סביבה

`.env` (מוחרג מ־Git; תבנית ב־`.env.example`). בהרצה המלאה ב־Docker, Compose
קורא ממנו רק את `UPLOAD_SIGNING_SECRET`, `APP_PORT` ו־`CLAIM_SWEEP_INTERVAL_MS`.
ה־`DATABASE_URL` של הקונטיינרים קבוע ב־`docker-compose.yml`.

| משתנה | בשימוש של | ברירת מחדל / דוגמה |
| --- | --- | --- |
| `UPLOAD_SIGNING_SECRET` | חתימת כתובות העלאה (**חובה**; בצד השרת בלבד, לפחות 32 תווים; ב־Docker מוזרק בזמן ריצה) | אקראי, למשל 32 בתים אקראיים ב־base64url |
| `APP_PORT` | הרצת Docker: פורט האפליקציה במחשב, על 127.0.0.1 (אופציונלי) | `3080` |
| `DATABASE_URL` | Next.js (Prisma ולקוח ה־change stream), Prisma CLI, ה־worker | פיתוח: `mongodb://127.0.0.1:27017/signflow?replicaSet=rs0`; Docker: `mongodb://mongodb:27017/signflow?replicaSet=rs0` (מוגדר ב־compose) |
| `TEST_DATABASE_URL` | פיתוח בלבד: בדיקות אינטגרציה, בדיקות מסד, `db:push:test` | `mongodb://127.0.0.1:27017/signflow_test?replicaSet=rs0` |
| `CLAIM_SWEEP_INTERVAL_MS` | ה־worker (אופציונלי) | `5000` |
| `REALTIME_RETRY_BASE_MS` | בסיס ההשהיה לחיבור מחדש של ה־change stream (אופציונלי) | `1000` (עד 30 שניות) |
| `SSE_HEARTBEAT_MS` | מרווח ה־heartbeat של SSE (אופציונלי) | `15000` |
| `MONGO_REPLICA_HOST` | כתובת חבר ה־replica set עבור `replica-set.js` | ברירת מחדל בפיתוח `127.0.0.1:27017`; Docker `mongodb:27017` |
| `BUILD_STANDALONE` | זמן בנייה בלבד (מוגדר ב־`Dockerfile`): `output: "standalone"` | לא מוגדר מקומית |

`UPLOAD_SIGNING_SECRET` לעולם אינו נחשף לדפדפן: אין לו קידומת `NEXT_PUBLIC_`,
והוא נקרא רק ב־`src/lib/uploads/signing.ts`, שמסומן `server-only`. החלפתו מבטלת
כתובות העלאה פתוחות.

`.env.atlas.local` (מוחרג מ־Git, מ־`.vercelignore` ומ־`.dockerignore`) מחזיק את
`DATABASE_URL` של Atlas לפקודות חד־פעמיות, כמו `prisma db push` הראשוני. שום
דבר אינו טוען אותו אוטומטית. מעבירים אותו במפורש, למשל
`node --env-file=.env.atlas.local ...`. משתני הייצור מפורטים
ב־[docs/deployment.md](deployment.md).

Next.js ו־Prisma CLI טוענים את `.env` אוטומטית. Vitest טוען אותו דרך `loadEnv`
ב־`vitest.config.mts`, וסקריפטי ה־`.mts` דרך `node --env-file=.env`. אין לשים את
`DATABASE_URL` רק ב־`.env.local`, כי Prisma CLI אינו קורא את הקובץ הזה. אין
`prisma.config.ts`, כי בנוכחותו Prisma 6 מפסיק לטעון את `.env` אוטומטית.

## פקודות בדיקה

```powershell
npm.cmd run typecheck            # טיפוסי הנתיבים של Next.js ו־tsc --noEmit
npm.cmd run lint                 # ESLint
npm.cmd run build                # בניית ייצור (ללא מסד)
npm.cmd run check                # שלושתן, לפי הסדר

npm.cmd test                     # בדיקות יחידה (ללא מסד)

# הבדיקות הבאות צריכות את המסד: npm.cmd run db:up
npm.cmd run test:integration     # db:push:test, ואז בדיקות API, תפיסות, העלאות, מגבלות ו־SSE על signflow_test
npm.cmd run test:db              # בדיקת קישוריות של Prisma (signflow_test)
npm.cmd run test:db:persistence  # הנתונים שורדים הפעלה מחדש של שירות ה־mongodb בפיתוח (signflow_test)
```

### מסד הבדיקות

כל בדיקות המסד האוטומטיות כותבות רק למסד שב־`TEST_DATABASE_URL`
(`signflow_test`), ולעולם לא ל־`DATABASE_URL` (`signflow`).

- פרויקט האינטגרציה של Vitest מגדיר את `DATABASE_URL` לערך של
  `TEST_DATABASE_URL` (`vitest.config.mts`). `tests/integration/setup.ts` רץ לפני
  כל קובץ בדיקות וזורק שגיאה, לפני כל כתיבה, אם בדיקת ההגנה נכשלת.
- בדיקת ההגנה (`tests/support/test-database.mts`, שמשמשת גם את בדיקות המסד
  ב־`scripts/` ואת `db:push:test`) מסרבת לרוץ כש־`TEST_DATABASE_URL` חסר, כששם
  המסד אינו מסתיים ב־`_test`, או כשהוא זהה למסד שב־`DATABASE_URL`.
- `npm run test:integration` מחיל קודם את הסכמה על מסד הבדיקות
  (`scripts/db-push-test.mts`).
- הבדיקות רושמות את המזהה של כל מסמך שהן יוצרות, ומוחקות בדיוק את המזהים האלה
  ב־`finally`, גם כשבדיקה נכשלת. שום דבר אינו מרוקן אוסף.
- בדיקות תפיסה שתלויות בזמן מזריקות שעון קבוע (`now`) לשירות, או קובעות מועד
  פקיעה עבר על רשומת הבדיקה שלהן. שום בדיקה אינה ממתינה שלוש דקות, וה־TTL של
  הייצור אינו משתנה.

### בדיקת הממשק (שני חלונות דפדפן)

`tests/ui/ui-check.mts` מפעיל שני חלונות דפדפן ללא ממשק (A ברוחב 390 פיקסלים,
B ברוחב מחשב) דרך Chrome DevTools Protocol. הוא מכסה:

- יצירת הזמנה ושינוי סטטוס;
- שני מתקינים שתופסים בו־זמנית, ואימות;
- פקיעת תפיסה עם ה־worker;
- העלאה מדומה. חלונית *Print files* חייבת להתאים ל־390×844 ול־768×1024 לפני
  ההעלאה, במהלכה ועם היסטוריה של שמות קבצים ארוכים;
- תפיסה שפקעה ונלקחת על ידי מתקין אחר, שנכשל באימות, תופס שוב, עובר ומשלים.
  אסור שיופיעו הודעות "Claimed as …" או "open again" ישנות, או הודעת פקיעה שגויה
  באף חלון;
- פריסת כפתורי האימות בשני הרוחבים;
- הודעות מגבלות ההדגמה בחלוניות *New order* ו־*Print files*;
- עדכונים חיים בחלון השני, ופריסת 390 פיקסלים.

הבדיקה מפעילה `next start` משלה (פורט 3100) ו־worker מול `signflow_test`, ומוחקת
רק את ההזמנות וההעלאות שיצרה.

דרישות: Microsoft Edge או Google Chrome מותקן (או `UI_TEST_BROWSER` שמצביע על
קובץ הרצה של דפדפן מבוסס Chromium), MongoDB פועל, סכמת הבדיקות מוחלת, ובניית
ייצור:

```powershell
npm.cmd run db:up
npm.cmd run db:push:test
npm.cmd run build
npm.cmd run test:ui            # כדקה; צילומי מסך ב־test-results/ui/ (מוחרג מ־Git)
```

`UI_TEST_PORT` משנה את פורט האפליקציה אם 3100 תפוס. אין צורך בחבילות npm נוספות
(הבדיקה משתמשת ב־`WebSocket` וב־`fetch` המובנים של Node).

## תוצאות הבדיקות

התיעוד מבחין בין חמישה סוגי בדיקות. בדיקה שלא בוצעה אינה מוצגת כאילו עברה.

### 1. בדיקות אוטומטיות (במאגר)

ההרצה המלאה האחרונה הייתה לפני ה־commit הראשון. שינויים שנוספו אחריה הם
בתיעוד בלבד, ולכן לא הורצו מחדש.

| בדיקה | תוצאה |
| --- | --- |
| `npm run typecheck`, `npm run lint` | נקי |
| `npm run build` | עובר, גם ללא מסד וללא `UPLOAD_SIGNING_SECRET` |
| `npm test` (יחידה) | 87 מתוך 87 עברו |
| `npm run test:integration` | 117 מתוך 117 עברו |
| `npm run test:ui` (שני חלונות) | 23 מתוך 23 בדיקות עברו |

### 2. בדיקות אוטומטיות חד־פעמיות (סקריפטים זמניים, לא במאגר)

- **אימות Docker סופי (16.11.2026, גרסת `main` ב־commit `3571ce7`):** ה־stack
  של `signflow` נבנה מחדש ב־`docker compose -f docker-compose.yml -p signflow
  --env-file .env up -d --build --wait`, בלי למחוק volumes. קובצי ה־worker
  בקונטיינר זהים ל־`main` (השוואת SHA-256). הבדיקה הריצה דפדפן Edge ללא ממשק
  וחיבור SSE ישיר מול `127.0.0.1:3080`, ו־**34 מתוך 34 בדיקות עברו**:
  - יצירת הזמנה (`201`, `DRAFT`, version 0), קריאה ב־`GET /api/orders`, והופעה
    בזרם ה־SSE ובדפדפן ללא רענון.
  - שיוך ספק ומחזור הסטטוסים עד `READY_FOR_INSTALL`. `expectedVersion` ישן נדחה
    ב־`409 VERSION_CONFLICT`, ומעבר לא חוקי ב־`400 INVALID_TRANSITION`.
  - העלאה מדומה: הרשאה עם כתובת חתומה, השלמה ל־`COMPLETED`, וכתובת ששונתה
    נדחתה ב־`403 UPLOAD_SIGNATURE_INVALID`. הסטטוס הגיע בזרם ה־SSE, ו־`GET
    /api/orders` לא החזיר כתובת חתומה, `storageKey` או גיבוב אסימון.
  - תפיסה בשם Jordan, ותפיסה שנייה בזמן שהראשונה פעילה נדחתה
    ב־`409 CLAIM_UNAVAILABLE`.
  - **ה־worker:** 186 שניות אחרי התפיסה (פקיעה ב־180 שניות ועוד מחזור סריקה)
    התפיסה שוחררה במסד, בלוג ה־worker הופיע `released 1 expired claim(s)`, השחרור
    הגיע בזרם ה־SSE, ואימות עם האסימון הישן נדחה ב־`409 CLAIM_NOT_ACTIVE`.
  - **חידוש SSE:** השרת שלח `reconnect` וסגר את הזרם אחרי 279.9 שניות. הדפדפן
    פתח זרם חדש 280 שניות אחרי הראשון, ונשאר **Live** לאורך כל 281 השניות שנדגמו.
  - **עדכון אחרי החידוש:** Sam תפס ועבר אימות, ההזמנה עברה ל־`COMPLETED`, ונוצרה
    הזמנה שנייה. הזרם החדש קיבל את השינויים, וההזמנה השנייה הופיעה בדפדפן.
  - **ניקוי:** שתי ההזמנות וההעלאה של הבדיקה נמחקו לפי מזהה, וכך גם מונה
    `demo_limits` שהבדיקה יצרה. שלוש ההזמנות ושש ההעלאות שהיו במסד לפני הבדיקה
    לא נגעו.
- **בדיקת Docker מוקדמת יותר:** בדיקה בשני חלונות דפדפן מול `127.0.0.1:3080`
  עברה 20 מתוך 20. היא רצה על גרסה שקדמה למגבלות ההדגמה ולאורך החיים של זרם
  ה־SSE.
- **חידוש זרם ה־SSE:** חלון דפדפן אחד נשאר פתוח 5 דקות מול `next start` מקומי.
  נרשמו שתי בקשות לזרם, בהפרש של 281 שניות, והחיווי נשאר **Live** כל הזמן.
- **MongoDB Atlas:** חיבור, `prisma db push` ללא איפוס, יצירה ועדכון של הזמנה
  דרך שירותי האפליקציה האמיתיים, קבלת אירוע change stream, ומחיקה לפי מזהה.
- **אימג' ה־worker לפריסה:** נבנה מ־`Dockerfile#worker` עם ערכי build arguments
  מדומים. הערכים לא הופיעו בתצורת האימג', בהיסטוריה או בקבצים. הקונטיינר עלה
  ונעצר בצורה מסודרת.

### 3. בדיקות ידניות מקומיות

| רוחב | אוטומטי (`npm run test:ui`) | ידני (מצב רספונסיבי בדפדפן) |
| --- | --- | --- |
| 390×844 (טלפון) | כל התרחיש בשני חלונות, בחלון A, ללא גלילה אופקית בדף; כפתורי Installer assignment; חלונית *Print files* לפני ההעלאה, במהלכה ועם היסטוריה של שמות ארוכים | חלונית *Print files* בבניית ה־Docker: נמצאה גלישה אופקית, שתוקנה ונוספה לבדיקה האוטומטית. אחרי התיקון *Print files* נבדקה שוב ידנית ברוחב הזה |
| 768×1024 (טאבלט) | חלונית *Print files* בלבד, באותם שלושה מצבים | לוח הבקרה והחלוניות *New order*, *Vendor*, *Change status*, *Installer assignment* (עם כפתורי האימות) ו־*Print files*. כולן נבדקו לפני תיקון הרוחב האחרון של *Print files* |
| 1280×900 (מחשב) | כל התרחיש בשני חלונות, בחלון B; כפתורי Installer assignment | לא נבדק ידנית |

בנוסף הורצו ידנית תרחישי תפיסה בשני חלונות (פקיעה, מתקין אחר שלוקח את העבודה,
אימות שנכשל ואימות שעבר, השלמה). הם חשפו הודעות תפיסה ישנות והודעת פקיעה
שגויה, שהבדיקה האוטומטית מכסה כעת. גודלי החלונות בבדיקות האלה לא תועדו.

פער: ב־768 פיקסלים הבדיקה האוטומטית מודדת רק את חלונית *Print files*. לוח הבקרה
ושאר החלוניות ברוחב טאבלט נבדקו ידנית לפני תיקון הרוחב האחרון של *Print files*,
ולא נבדקו שוב ידנית מאז. התיקון עצמו מכוסה ב־768 פיקסלים בבדיקה האוטומטית של
*Print files*.

### 4. בדיקה ידנית בענן

בוצעה בפריסת ה־Production ב־Vercel. התוצאות, כולל מה שלא נבדק, מפורטות
ב־[docs/deployment.md](deployment.md).

### 5. אימות הגדרות בלבד

- `vercel.json` אומת מול הסכמה הרשמית (`https://openapi.vercel.sh/vercel.json`)
  ונמצא תקין, כולל הגדרת ה־daemon. שבעה עותקים עם שגיאות מכוונות נדחו.
- כלל ה־WAF ב־Vercel הוגדר, פורסם ונראה פעיל. הפעלת `429` בפועל לא נבדקה (ראו
  [docs/deployment.md](deployment.md)).

## תרחיש הדגמה מקומי

הדגמה קצרה של התרחישים העיקריים (שרת פיתוח, שני חלונות דפדפן). לפני ההתחלה:
`npm.cmd run db:up`, אחר כך `npm.cmd run dev`, ובטרמינל שני
`npm.cmd run worker:claims`. פתחו את http://localhost:3000 **בשני חלונות** זה לצד
זה. בהרצת Docker הכתובת היא http://127.0.0.1:3080, וה־worker כבר רץ.

1. **הזמנה וסטטוס:** בחלון 1 לחצו *New order* וצרו הזמנה. היא מופיעה מיד בחלון 2.
   *Vendor*, בחירת ספק, *Save vendor*. *Change status*: *Submit order*, *Mark
   vendor accepted*, *Start production*, *Mark ready for install*. (ללא ספק,
   *Mark vendor accepted* מושבת, וה־API עונה `400 VENDOR_REQUIRED`.)
2. **התנגשות בין שני מתקינים:** בחרו ב־*Acting as installer* מתקינים שונים בשני
   החלונות. פתחו *Installer assignment* על ההזמנה בשני החלונות, ולחצו מהר
   *Claim as …* בשניהם. חלון אחד מציג "Claimed as …" עם ספירה לאחור, והשני
   "Another installer claimed this job first." שינוי סטטוס על גרסה ישנה מציג את
   ההודעה "changed by someone else" ומרענן.
3. **אימות:** בחלון שתפס לחצו *Simulate: verification passed* (או *failed*,
   שמשחרר את העבודה מיד). החלון השני מציג "Installer: … · verified".
4. **פקיעה:** תפסו הזמנה מוכנה אחרת ואל תעשו דבר. הספירה רצה מ־3:00, וב־0:00 שני
   החלונות מציגים את העבודה כפתוחה שוב. החלון שתפס מציג "Your previous claim on …
   expired before verification" (גם כשה־worker שחרר את התפיסה קודם). ה־worker
   מאפס את התפיסה השמורה. עכשיו תפסו ואמתו בחלון השני: החלון הראשון מסיר את
   ההודעה "Claimed as …" ומציג את השיוך החדש.
5. **העלאה:** *Print files*, *Use a 1.5 GB demo print file*, *Start upload* (כ־16
   שניות, מדומה). החלון השני מציג את הקובץ כהועלה. סמנו *Simulate a network
   failure* או לחצו *Cancel upload* כדי לראות את מצבי הכשל והביטול ואת *Try
   again*.

אותם תרחישים רצים אוטומטית ב־`npm.cmd run test:ui`.

## גרסאות ותלויות

| כלי | גרסה |
| --- | --- |
| Next.js (App Router) | 16.4.6 |
| React / React DOM | 19.3.1 |
| TypeScript (strict) | 5.9.3 |
| Tailwind CSS | 4.3.5 |
| רכיבי shadcn/ui | נוצרו עם shadcn CLI 4.23.0 (אינו תלות) |
| ESLint | 9.39.x |
| Prisma / @prisma/client | 6.19.3 |
| דרייבר MongoDB ל־Node.js (`mongodb`) | 7.8.0 |
| MongoDB (אימג' Docker) | 8.0.38 |
| Zod | 4.6.7 |
| Vitest / Vite | 5.1.0 / 8.3.8 |

נימוקי הגרסאות:

- **Prisma 6.19.3, לא 7 או 8:** ל־Prisma ORM 7 אין connector ל־MongoDB, ומדריך
  השדרוג הרשמי ממליץ להישאר על Prisma ORM 6 עבור MongoDB. Prisma 8 תומך
  ב־MongoDB אבל עדיין release candidate. 6.19.3 היא הגרסה היציבה החדשה ביותר
  עם תמיכה ב־MongoDB. `prisma` ו־`@prisma/client` נעולים לאותה גרסה מדויקת.
- **MongoDB 8.0.38:** עדכון התיקונים האחרון בקו 8.0. Prisma 6 תומך ב־MongoDB 4.2
  ומעלה (נדרש replica set). לוגיקת התפיסה משתמשת ב־`$dateAdd` (MongoDB 5.0 ומעלה).
- **TypeScript 5.9.3, לא 7.x:** `typescript-eslint` (בשימוש של
  `eslint-config-next`) תומך ב־`typescript >=4.8.4 <6.1.0`. Next.js 16 ו־Prisma 6
  דורשים TypeScript 5.1 ומעלה.
- **ESLint 9, לא 10:** `eslint-plugin-react`, `eslint-plugin-import`
  ו־`eslint-plugin-jsx-a11y` (בשימוש של `eslint-config-next`) מצהירים על תמיכה
  עד ESLint 9. גם התבנית הרשמית של Next.js 16.4.6 משתמשת ב־ESLint 9.
- **`mongodb` 7.8.0:** הדרייבר הרשמי ל־Node.js, בשימוש רק עבור Change Streams
  (Prisma 6 אינו חושף אותם). Next.js מתייחס אליו כחבילה חיצונית לשרת (לא
  נארזת). Prisma ממשיך לבצע את כל הקריאות והכתיבות.
- **Zod 4.6.7:** הגרסה שכבר הייתה ב־lockfile (תלות עקיפה), וכעת מוצהרת ישירות.
- **Vitest 5.1.0:** צריך את `vite` כתלות peer, נעול ל־8.3.8.
- Tailwind CSS v4 מחובר דרך `@tailwindcss/turbopack` (כפי ש־`create-next-app`
  יצר), ולכן אין `tailwind.config` ואין תצורת PostCSS.
- **shadcn/ui:** הרכיבים ב־`src/components/ui` הם קובצי מקור. בזמן ריצה הם צריכים
  רק את `radix-ui`, `cn`, `class-variance-authority`, `lucide-react`
  ו־`tw-animate-css`. הקובץ היחיד שהם השתמשו בו מחבילת ה־CLI `shadcn` (ה־variants
  של Tailwind, ברישיון MIT) הועתק לפרויקט כ־`src/app/shadcn-tailwind.css`, כך
  שה־CLI ועץ התלויות הגדול שלו אינם מותקנים. להוספת רכיבים בעתיד:
  `npx.cmd shadcn@4.23.0 add <name>`.
- `next.config.ts`: `cacheComponents` (ברירת המחדל ב־Next.js 16; נתיבי ה־API קוראים
  ל־`connection()`, והדף הוא מעטפת סטטית) ו־`partialPrefetching` (Next 16.4 מזהיר
  בלעדיו לצד `cacheComponents`; הוא משפיע רק על `<Link>`, שהדף היחיד אינו
  משתמש בו), ובנוסף טוען ה־Turbopack של Tailwind.
- `tsconfig.json` מפעיל את `allowImportingTsExtensions` (מותר בזכות `noEmit`).
  מודולים שה־worker טוען ישירות עם Node (`src/lib/claims/store.mts`,
  `constants.mts`) הם קובצי `.mts` שמיובאים עם הסיומת.

### `npm audit`

הבדיקה האחרונה: 10 ממצאים (3 high, 7 moderate; ה־CLI של `shadcn` ו־5 הממצאים שלו
הוסרו). אף אחד מהם אינו בקוד שאפליקציית האינטרנט או ה־worker טוענים בזמן ריצה:

| ממצא | מגיע דרך | סוג | מצב |
| --- | --- | --- | --- |
| `deepmerge-ts` < 8 (high, GHSA-ggr8-5vv4-36mx) דרך `@prisma/config` ו־`prisma` | ה־CLI של `prisma` 6.19.3 (`generate`, `db push`) | CLI. מופיע גם תחת `--omit=dev`, כי `@prisma/client` מצהיר על `prisma` כ־peer אופציונלי, אבל ה־runtime של הלקוח אינו טוען את `@prisma/config` | התיקון היחיד הוא Prisma 7, שאין לו connector ל־MongoDB, ולכן הממצא מתקבל. ה־CLI ממזג רק את התצורה של הפרויקט עצמו |
| `minimatch` 10.x (moderate, GHSA-g3hv-75wg-m249) דרך חבילות `typescript-eslint` | `eslint-config-next` | פיתוח (lint) | `minimatch` 11 המתוקן מחוץ לטווח `^10` של `typescript-eslint`. `npm audit fix --dry-run` אינו משנה דבר. אין override ללא הוכחת תאימות |

לתלויות הריצה (`next`, `react`, `@prisma/client`, `mongodb`, `zod`, `radix-ui`,
`lucide-react`, `cn`, `class-variance-authority`, `tw-animate-css`, `server-only`)
אין ממצאים מדווחים.

באימג'ים של Docker: האימג'ים `app` ו־`worker` אינם מכילים את Prisma CLI או את כלי
ה־lint, ולכן אף אחד מהממצאים אינו קיים בהם. האימג' החד־פעמי `schema` מכיל את עץ
התלויות המלא (הוא צריך את Prisma CLI). `npm ci` בבניית האימג' מדפיס הודעת
deprecation עבור ESLint 9. זה כלי פיתוח, והוא אינו באימג'י הריצה.

## מבנה הפרויקט

```
src/
  app/
    page.tsx                 דף לוח הבקרה (מעטפת סטטית)
    api/orders/              רשימה ויצירה, סטטוס, ספק, תפיסה, אימות,
                             העלאות (הרשאה, השלמה, ביטול), events (SSE)
    shadcn-tailwind.css      variants של Tailwind מ־shadcn (MIT)
  components/
    orders/                  לוח הבקרה, החלוניות (יצירה, סטטוס, ספק, שיוך מתקין),
                             תקציר תפיסה, hooks לנתונים חיים
    uploads/                 חלונית קבצי ההדפסה, תקציר העלאות, hook לניהול העלאות
    ui/                      רכיבי shadcn/ui
  lib/
    orders/                  כללי סטטוס, סכמות, שירות, מיזוג, לקוח API
    claims/                  מודל התפיסה, מתקיני דמו, סכמות, שירות,
                             store.mts (כתיבות מותנות ולולאת ה־worker), constants.mts
    uploads/                 מגבלות, סכמות, חתימה (שרת), שירות (שרת),
                             מתאם אחסון מדומה (דפדפן)
    realtime/                feed של change stream, תשובת SSE
    vendors/                 ספקי דמו וכללי ספקים
    api/http.ts              עזרי תשובות JSON ושגיאות
    demo-limits.mts          מגבלות נתוני ההדגמה (הזמנות, ניסיונות העלאה להזמנה)
    prisma.ts                לקוח Prisma משותף (server-only)
prisma/                      סכמת Prisma
scripts/                     ה־worker, החלת סכמה על מסד הבדיקות, בדיקות מסד
tests/
  integration/               בדיקות API, ספקים, תפיסות, העלאות, מגבלות ו־SSE (מסד בדיקות בלבד)
  ui/                        בדיקת ממשק בשני חלונות (npm run test:ui)
  support/                   הגנת מסד הבדיקות
docs/                        תיעוד (ארכיטקטורה, פיתוח ובדיקות, פריסה)
docker/mongodb/              אתחול ו־healthcheck של ה־replica set
Dockerfile                   אימג'ים רב־שלביים: app, worker, schema
docker-compose.yml           הרצה מלאה ב־Docker (MongoDB, schema, app, worker)
compose.dev.yaml             MongoDB לפיתוח מקומי ב־Windows
.dockerignore                מחריג סודות ותוצרי בנייה מהקשר הבנייה
.vercelignore                מחריג קובצי סביבה, מפתחות, docs ותוצרי בדיקות מהעלאות ל־Vercel
vercel.json                  Vercel: אזור הפונקציות וה־daemon של ה־worker
```
