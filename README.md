# SignFlow

לוח בקרה לניהול הזמנות שילוט בהתאמה אישית: מחזור חיים של הזמנה, שיוך ספקים,
תפיסת עבודות התקנה על ידי מתקינים, קבצי הדפסה ועדכונים חיים בין חלונות.

> זוהי **מטלת בית להדגמה**, לא מערכת מוכנה לייצור. אימות הזהות והתשלום
> ואחסון הקבצים הם **הדמיות**. המתקינים והספקים הם רשימה קבועה של נתוני דמו
> ללא התחברות, ולכן אינם הרשאות: כל מי שיכול לפתוח את האתר יכול לשנות את נתוני
> ההדגמה.

## יכולות מרכזיות

- **הזמנות עם מחזור סטטוסים שנאכף בשרת ובממשק**:
  `DRAFT -> SUBMITTED -> VENDOR_ACCEPTED -> IN_PRODUCTION -> READY_FOR_INSTALL -> COMPLETED`,
  וביטול (`CANCELLED`) רק לפני `IN_PRODUCTION`. מעבר לא חוקי מחזיר `400`.
- **שיוך ספק** מתוך רשימת ספקי דמו. ספק נדרש לפני `VENDOR_ACCEPTED` וננעל לאחר מכן.
- **תפיסת עבודת התקנה**: כשכמה מתקינים תופסים את אותה הזמנה בו־זמנית, בדיוק
  אחד מצליח (נעילה אופטימית במסד). התפיסה ממתינה לאימות מדומה ופוקעת
  אוטומטית לאחר 3 דקות.
- **העלאת קבצי הדפסה מדומה** ישירות לאחסון, באמצעות כתובות חתומות מראש
  (pre-signed URLs), כולל קובץ דמו של 1.5 GB, התקדמות, ביטול, כשל וניסיון חוזר.
- **עדכונים חיים** בכל החלונות הפתוחים: MongoDB Change Streams דוחפים
  שינויים דרך Server-Sent Events, ללא תשאול חוזר של המסד.
- **חלוניות** ליצירת הזמנה, שינוי סטטוס, שיוך ספק, שיוך מתקין וקבצי הדפסה.
  הממשק רספונסיבי (טלפון, טאבלט, מחשב).

## הדגמה חיה

**https://sign-flow-flame.vercel.app**

- האתר מוגן ב־Vercel Authentication. ללא הרשאה, גם הדף וגם ה־API מפנים
  להתחברות Vercel.
- **קישור הגישה לבודק נמסר בנפרד** ואינו נשמר במאגר. הוראות הגישה מפורטות
  ב־[docs/deployment.md](docs/deployment.md).
- הנתונים משותפים לכל מי שמחזיק בקישור. לבדיקת עדכונים חיים ותפיסות מקבילות,
  פתחו את האתר בשני חלונות ובחרו מתקין שונה בכל חלון (**Acting as installer**).

## הרצה ב־Docker (Run with Docker)

נדרש **Docker** עם Compose v2 בלבד (Docker Desktop ב־Windows/macOS, או Docker
Engine עם תוסף compose ב־Linux). אין צורך ב־Node.js.

1. יצירת קובץ `.env` עם סוד חתימה אקראי (נוצר בתוך קונטיינר):

   ```sh
   # Linux/macOS (bash/zsh)
   echo "UPLOAD_SIGNING_SECRET=$(docker run --rm node:24.14.0-bookworm-slim node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))")" > .env
   ```

   ```powershell
   # Windows PowerShell
   $secret = docker run --rm node:24.14.0-bookworm-slim node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64url'))"
   Set-Content -Path .env -Value "UPLOAD_SIGNING_SECRET=$secret" -Encoding ascii
   ```

2. בנייה והפעלה. הפקודה חוזרת כשהאפליקציה תקינה (בנייה ראשונה כ־2 עד 3 דקות):

   ```sh
   docker compose up -d --build --wait
   ```

3. פתיחת לוח הבקרה: http://127.0.0.1:3080

אם פורט 3080 תפוס, הוסיפו `APP_PORT=<port>` לקובץ `.env`. ה־worker לפקיעת
תפיסות כבר רץ. הפעלה מחדש: `docker compose up -d --wait`. עצירה עם שמירת
הנתונים: `docker compose stop` או `docker compose down`.

> **אזהרה:** `docker compose down -v` מוחק את ה־volumes של הפרויקט ואיתם את
> **כל הנתונים** של הרצת ה־Docker.

השירותים: `mongodb` (replica set בצומת יחיד, ללא פורט חיצוני), `schema`
(הרצה חד־פעמית של `prisma db push`), `app` (שרת Next.js, על `127.0.0.1` בלבד)
ו־`worker` (פקיעת תפיסות). זו תצורה מקומית להדגמה: ל־MongoDB אין סיסמה ואין
TLS. פירוט נוסף ב־[docs/development-and-testing.md](docs/development-and-testing.md).

## טכנולוגיות

| רכיב | גרסה |
| --- | --- |
| Next.js (App Router), React | 16.4.6, 19.3.1 |
| TypeScript (strict) | 5.9.3 |
| Tailwind CSS, shadcn/ui | 4.3.5, רכיבים שנוצרו ב־CLI 4.23.0 |
| Prisma (MongoDB connector) | 6.19.3 |
| MongoDB, דרייבר `mongodb` | 8.0.38 (replica set), 7.8.0 |
| Zod, Vitest | 4.6.7, 5.1.0 |
| Node.js | 24.14.0 (`engines`: `^22.18.0 \|\| ^24.0.0 \|\| >=26.0.0`) |

Prisma 6 ולא 7: ל־Prisma 7 אין connector ל־MongoDB. נימוקי הגרסאות מפורטים
ב־[docs/development-and-testing.md](docs/development-and-testing.md).

## החלטות ארכיטקטורה מרכזיות

- **כל הבקשות עוברות דרך Next.js API routes** (`src/app/api/orders/**/route.ts`):
  הזמנות, סטטוסים, ספקים, תפיסות ואימות, והרשאות העלאה. הלוגיקה העסקית נמצאת
  ב־`src/lib/*/service.ts`.
- **עיבוד האירועים החיים רץ בשרת Next.js**: נתיב ה־SSE (`/api/orders/events`)
  מוזן מ־change stream אחד לכל תהליך שרת, ומגיב לכתיבות מכל תהליך.
- **כל שינוי מצב הוא כתיבה מותנית אחת** ב־MongoDB, כך שהבדיקה והשינוי אטומיים.
  אין Redis ואין נעילה בזיכרון.
- **השעון הוא של MongoDB** (`$$NOW`), כך ששרתים ותהליכים עם סטיית שעון אינם
  חלוקים על הפקיעה.
- **worker נפרד לפקיעת תפיסות** (`scripts/claim-expiry-worker.mts`): הוא רק
  מאפס את שדות התפיסה שפקעו. הפקיעה עצמה נאכפת ב־API, גם כשה־worker עצור.
  זו פרשנות מכוונת של דרישת המשימה להריץ עיבוד אירועים ב־API routes.
- **הדפים אינם תלויים במסד בזמן הבנייה**: הדף הוא מעטפת סטטית, והנתונים
  נטענים בדפדפן (`GET` ראשוני ואחריו SSE).

פירוט מלא, כולל דיאגרמות, טבלת ה־API וקודי השגיאה:
[docs/architecture.md](docs/architecture.md).

## סכמת המסד (תקציר)

הסכמה ב־`prisma/schema.prisma`. שינויי סכמה מוחלים ב־`prisma db push`.

| אוסף | תוכן | אינדקסים |
| --- | --- | --- |
| `orders` | `title`, `description`, `status`, `version`, `vendorId`, שדות התפיסה (`claimState`, `claimInstallerId`, `claimTokenHash`, `claimExpiresAt`, `claimedAt`, `claimConfirmedAt`), `uploadRequestIds`, `createdAt`, `updatedAt` | `{ createdAt: -1, _id: -1 }`, `{ claimState: 1, claimExpiresAt: 1 }` |
| `uploads` | מטא־דאטה בלבד של קבצי הדפסה: `orderId`, `originalName`, `sizeBytes`, `contentType`, `storageKey`, `status`, `clientRequestId`, `authorizationExpiresAt`, `completedAt` | ייחודי `storageKey`, ייחודי `(orderId, clientRequestId)`, `(orderId, createdAt desc)` |
| `demo_limits` | מסמך אחד (`_id: "orders"`) שמסדר את מגבלת ההזמנות | |

- `version` עולה בכל שינוי סטטוס, ספק או תפיסה.
- אסימון התפיסה עצמו לעולם אינו נשמר, רק ה־SHA-256 שלו (`claimTokenHash`).
- תוכן קבצים לעולם אינו נשמר ב־MongoDB.
- כל שדות התפיסה אופציונליים, ולכן מסמכים ישנים נקראים ללא מיגרציה.

## נעילה אופטימית ותפיסת עבודה

- **שינוי סטטוס וספק**: הלקוח שולח `expectedVersion`. השרת מבצע עדכון מותנה
  אחד עם הסינון `{ _id, status, version: expectedVersion }`. אם בקשה אחרת
  הקדימה, אף מסמך לא מתאים והתשובה היא `409 VERSION_CONFLICT`.
- **תפיסה**: עדכון מותנה אחד שמצליח רק אם ההזמנה `READY_FOR_INSTALL` והתפיסה
  פנויה (`claimState` חסר או `NONE`, או `PENDING_VERIFICATION` שפקעה). בתפיסות
  מקבילות בדיוק אחת מקבלת `201` עם אסימון, והשאר `409 CLAIM_UNAVAILABLE`.
- **אימות מדומה**: `PASSED` מאשר את התפיסה (`CONFIRMED`), `FAILED` משחרר אותה
  מיד. שתיהן מותנות באותו מתקין, באותו אסימון ובכך שהתפיסה טרם פקעה.
- נבדק באינטגרציה עם 2 ו־12 תפיסות מקבילות, ובבדיקת ממשק בשני חלונות.

## פקיעת תפיסה

- תפיסה ממתינה לאימות פוקעת לאחר **3 דקות** (`claimExpiresAt`, לפי שעון MongoDB).
- מרגע הפקיעה התפיסה נחשבת פנויה, ואימות מאוחר נדחה ב־`409 CLAIM_EXPIRED`.
  זה נאכף בכתיבה המותנית עצמה, ולכן אינו תלוי ב־worker.
- ה־worker סורק כל 5 שניות תפיסות שפקעו (דרך האינדקס) ומשחרר כל אחת בעדכון
  מותנה. השינוי מגיע לכל החלונות דרך ה־change stream. כמה workers יכולים לרוץ
  במקביל.
- תפיסה מאושרת (`CONFIRMED`) לעולם אינה פוקעת.

## צינור ההעלאה המדומה

1. הדפדפן מבקש הרשאה: `POST /api/orders/{id}/uploads` עם `clientRequestId`, שם,
   גודל וסוג.
2. השרת יוצר רשומת `Upload` במצב `PENDING_UPLOAD` ומחזיר כתובת חתומה
   (HMAC-SHA256 עם `UPLOAD_SIGNING_SECRET`), שתקפה ל־30 דקות.
3. הדפדפן "מעלה" לאחסון מדומה. ההתקדמות מקומית לחלון המעלה בלבד, ואין כתיבה
   למסד בכל אחוז.
4. בסיום, ביטול או כשל, הדפדפן שולח את הכתובת החתומה ל־`.../complete` או
   ל־`.../abort`. השרת מאמת את החתימה ומבצע עדכון מותנה ל־`COMPLETED`,
   ל־`CANCELLED` או ל־`FAILED`.
5. ה־change stream מעדכן את שאר החלונות בסטטוס (מטא־דאטה בלבד).

אין העברת קבצים בפועל: הכתובת מפנה ל־`https://simulated-storage.invalid`. ההרשאה
אידמפוטנטית לפי `clientRequestId`, וגודל הקובץ מוגבל ל־5 GiB. ההסבר כיצד אחסון
אמיתי (S3, GCS, Azure Blob) יחליף את ההדמיה נמצא ב־[docs/architecture.md](docs/architecture.md).

## בדיקות

```powershell
npm.cmd run check               # typecheck, lint, build
npm.cmd test                    # בדיקות יחידה (ללא מסד)
npm.cmd run db:up               # MongoDB מקומי, נדרש לבדיקות הבאות
npm.cmd run test:integration    # API, תפיסות, העלאות, מגבלות ו־SSE מול signflow_test
npm.cmd run build; npm.cmd run test:ui   # בדיקת ממשק בשני חלונות דפדפן (Edge/Chrome)
```

ב־macOS/Linux משתמשים ב־`npm` במקום `npm.cmd`. הבדיקות כותבות רק למסד
`signflow_test`, ומוחקות רק את הרשומות שיצרו.

התיעוד מבחין בין סוגי הבדיקות:

- **בדיקות אוטומטיות**: יחידה, אינטגרציה ובדיקת הממשק.
- **בדיקות ידניות מקומיות**, כולל רוחב טאבלט.
- **בדיקה מקומית ב־Docker**.
- **בדיקה ידנית בענן**.
- **אימות הגדרות בלבד**.

הפירוט והתוצאות ב־[docs/development-and-testing.md](docs/development-and-testing.md),
ותוצאות בדיקת הענן ב־[docs/deployment.md](docs/deployment.md).

## מגבלות ההדגמה

- **אין התחברות והרשאות**: מתקינים וספקים הם זהויות דמו שנבחרות בדפדפן.
- **תקרות נתונים**: עד **200 הזמנות** במסד, ועד **20 ניסיונות העלאה להזמנה**
  (כולל ניסיונות שנכשלו או בוטלו). חריגה מחזירה `409 DEMO_LIMIT_REACHED` עם
  הודעה בחלונית.
- **הגבלת קצב (WAF) בפריסה**: 30 בקשות `POST`/`PATCH` ב־60 שניות לכל IP,
  בנתיבים שמתחילים ב־`/api/orders`. חריגה מחזירה `429`. הכלל אינו מגביל בקשות
  `GET` וחיבורי SSE.
- **התקרות וכלל ה־WAF אינם מבטיחים מניעת מיצוי מכסות** של Vercel ו־Atlas
  (זמן פונקציות, זיכרון, תעבורה, פעולות במסד).
- **זרם ה־SSE מתחדש כל 280 שניות** (מגבלת 300 שניות לפונקציה ב־Vercel Hobby),
  ללא הצגת "Reconnecting...".
- **ה־worker בענן** רץ כ־Vercel Daemon (בטא), שמכסתו החודשית מספיקה לכ־17 ימי
  ריצה רצופה. גם אחריהם הפקיעה נאכפת ב־API.
- **הדמיות**: אימות זהות ותשלום (כפתורי דמו), ואחסון קבצים.

## תיעוד מפורט

| מסמך | תוכן |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | רכיבים, מודל הנתונים, כללי הסטטוס, ה־API וקודי השגיאה, נעילה ותפיסות, worker, העלאות, עדכונים חיים, ממשק, מגבלות ההדגמה וכיסוי דרישות המשימה |
| [docs/development-and-testing.md](docs/development-and-testing.md) | פיתוח מקומי, פרטי Docker, משתני סביבה, מסד הבדיקות, פקודות ותוצאות הבדיקות, תרחיש הדגמה, תלויות ומבנה הפרויקט |
| [docs/deployment.md](docs/deployment.md) | הפריסה ב־Vercel וב־MongoDB Atlas, גישת הבודק, הגנת גישה, WAF, מכסות, תוצאות בדיקת הענן ונוהל הכיבוי |

מסמך המשימה המקורי נשמר מקומית בלבד, ומוחרג מהמאגר (`.gitignore`), מ־Vercel
(`.vercelignore`) ומ־Docker (`.dockerignore`).
