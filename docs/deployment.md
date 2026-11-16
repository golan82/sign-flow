# פריסה וכיבוי

מסמך זה מתאר את הפריסה הציבורית להדגמה, את הגישה לבודק, את ההגנות ואת
המכסות, את תוצאות בדיקת הענן ואת נוהל הכיבוי. פרטי המסלולים נבדקו מול התיעוד
של Vercel ו־Atlas בנובמבר 2026. כדאי לבדוק שוב את הדפים המקושרים בסוף המסמך
לפני שמסתמכים עליהם.

## מצב נוכחי

| רכיב | מצב |
| --- | --- |
| כתובת | **https://sign-flow-flame.vercel.app** (Production) |
| אירוח | Vercel Hobby. נבנה מהענף `main` של מאגר GitHub פרטי. כל push ל־`main` מפעיל פריסת Production אוטומטית |
| פונקציות | אזור `iad1` (Washington, D.C.) |
| ה־worker לפקיעת תפיסות | Vercel Daemon (בטא) בשם `worker`, מופע אחד ב־`iad1`, 1 GiB |
| מסד | אשכול MongoDB Atlas Free, מסד `signflow`, משתמש ייעודי `signflow_app` עם `readWrite` על `signflow` בלבד |
| חיבור GitHub | לאפליקציית GitHub של Vercel יש גישה למאגר `sign-flow` בלבד (אומת ידנית) |
| הגנת גישה | Vercel Authentication, כולל דומיין ה־Production. הבודק נכנס דרך קישור שיתוף שנמסר בנפרד |
| WAF | כלל Rate Limit פעיל על כתיבות ל־`/api/orders` (ראו [WAF](#waf)) |

## גישה לבודק

**קישור הגישה נמסר לבודק בנפרד, ואינו נשמר במאגר או בתיעוד.**

1. פתחו את קישור הגישה שקיבלתם. מומלץ חלון גלישה בסתר, כדי שחשבון Vercel
   אחר בדפדפן לא יתערב. אחרי פתיחת הקישור, הדפדפן מקבל גישה לאתר, כולל בקשות
   ה־API וה־SSE של הדף.
2. לבדיקה בשני חלונות, פתחו חלון נוסף באותו דפדפן ובאותו מצב גלישה. אם החלון
   הנוסף מפנה להתחברות Vercel, פתחו בו שוב את קישור הגישה.
3. בכל חלון בחרו מתקין אחר ב־**Acting as installer**. תרחיש הדגמה מוצע
   מופיע ב־[docs/development-and-testing.md](development-and-testing.md).
4. הנתונים משותפים לכל מי שמחזיק בקישור, וזהויות הדמו אינן הרשאות. חלות
   [מגבלות ההדגמה](../README.md#מגבלות-ההדגמה): עד 200 הזמנות, עד 20 ניסיונות
   העלאה להזמנה, ו־`429` על יותר מ־30 כתיבות בדקה מאותה כתובת IP.
5. אין להעביר את הקישור הלאה. בתום הבדיקה הגישה תיסגר לפי [נוהל
   הכיבוי](#נוהל-כיבוי).

ללא הרשאה, הדף, `/api/orders` ו־`/api/orders/events` מפנים להתחברות Vercel.

## תצורת Vercel

### `vercel.json`

- `regions: ["iad1"]`: הפונקציות רצות ב־Washington, D.C. (ב־Hobby מותר אזור
  אחד). כדאי שאזור Atlas יהיה קרוב אליו.
- `daemons.worker`: ה־worker לפקיעת תפיסות, נבנה מ־`Dockerfile#worker` (השלב
  `worker`, שהוא גם האחרון) עם שורש המאגר כהקשר בנייה, **מופע אחד ב־`iad1`,
  1 GiB**. ה־`ENTRYPOINT`/`CMD` של האימג' מפעילים אותו (`tini` ואז
  `node scripts/claim-expiry-worker.mts`). בפריסה מחדש Vercel שולח `SIGTERM`
  וממתין 30 שניות, וה־worker נעצר אחרי הסריקה הנוכחית. התחביר `#stage` מגיע
  מסכמת `vercel.json`, ותיעוד ה־daemons מציג רק `Dockerfile` רגיל. Daemons
  נמצאים בבטא, רצים רק ב־Production, ותיקיית השורש של הפרויקט חייבת להיות שורש
  המאגר.
- Vercel מעביר את משתני הסביבה של הפריסה לבניית האימג' כ־build arguments.
  ה־`Dockerfile` אינו מצהיר על אף אחד מהם, ולכן הם לעולם אינם נכנסים לאימג'
  (נבדק עם ערכים מדומים: הם לא הופיעו בתצורת האימג', בהיסטוריה או בקבצים).
- אפליקציית Next.js נבנית בבונה Next.js הרגיל של Vercel, וה־`Dockerfile` משמש
  רק ל־daemon. הבנייה אינה צריכה מסד או סודות (נבדק עם `DATABASE_URL` לא נגיש
  ו־`UPLOAD_SIGNING_SECRET` ריק).
- `vercel.json` אומת מול הסכמה הרשמית ונמצא תקין.

### משתני סביבה ב־Production

ב־Vercel: Settings, Environment Variables. סביבת **Production** בלבד, מסוג
*Secret* (לכתיבה בלבד אחרי השמירה, ומוסתרים בלוגי הבנייה). ערכים חדשים, לעולם
לא הערכים המקומיים:

| משתנה | ערך | בשימוש של |
| --- | --- | --- |
| `DATABASE_URL` | מחרוזת החיבור של `signflow_app` ל־Atlas, **כולל `/signflow`** כשם המסד | האפליקציה וה־worker |
| `UPLOAD_SIGNING_SECRET` | ערך אקראי חדש, לפחות 32 תווים | האפליקציה בלבד |
| `CLAIM_SWEEP_INTERVAL_MS` | אופציונלי, ברירת מחדל `5000` | ה־worker בלבד |

לא נדרשים ב־Production: `TEST_DATABASE_URL`, `APP_PORT`, `MONGO_REPLICA_HOST`,
`BUILD_STANDALONE`. משתנים שמוגדרים ל־Production בלבד מרחיקים את פריסות
ה־Preview מהמסד.

### `.vercelignore`

ה־CLI של Vercel אינו קורא את `.gitignore`, ולכן `.vercelignore` מחריג קובצי
סביבה (`.env`, `.env.*`, חוץ מ־`.env.example`), מפתחות (`*.pem`, `*.key`), את
`docs/` (כולל מסמך המשימה המקורי), תוצרי בדיקות, תוצרי בנייה ו־`node_modules`.
הפריסה עצמה נעשית מ־Git, ומאגר ה־Git אינו מכיל קובצי סביבה פרטיים.

## MongoDB Atlas

- משתמש מסד ייעודי לאפליקציה בלבד: התפקיד המובנה `readWrite` על המסד
  **`signflow`** בלבד, מוגבל לאשכול הזה, עם סיסמה אקראית ארוכה. לא
  `readWriteAnyDatabase` (זה התפקיד של המשתמש שהאינטגרציה של Vercel עם Atlas
  יוצרת, ולכן לא נעשה בה שימוש).
- גישת רשת: נדרש `0.0.0.0/0`, כי לפונקציות של Vercel אין כתובות IP קבועות.
  הסיסמה ו־TLS הם אז המחסום היחיד, ולכן המשתמש מוגבל ל־`signflow`.
- MFA בחשבון Atlas: מומלץ, אבל **עדיין לא אומת**. `TEST_DATABASE_URL` לעולם
  אינו מצביע על Atlas.
- האינדקסים נוצרו פעם אחת ב־`prisma db push`, עם `DATABASE_URL` שהוגדר רק
  לפקודה הזו (מ־`.env.atlas.local`, ולא נכתב ל־`.env`).
- מגבלות המסלול החינמי: 512 MB, 500 חיבורים, 100 פעולות לשנייה, ו־10 GB נכנס
  ו־10 GB יוצא בכל 7 ימים (מעבר לכך Atlas מאט). האשכול מושהה אחרי 30 ימים ללא
  חיבורים.

## SSE וה־worker במסלול החינמי

- כל תשובת SSE מסתיימת אחרי 280 שניות (ה־`maxDuration` של הנתיב הוא 300
  שניות, המקסימום ב־Hobby), והלקוח מתחבר מחדש מיד עם snapshot מלא.
- כל לשונית פתוחה של לוח הבקרה מחזיקה מופע פונקציה חי, שנספר במכסת Provisioned
  Memory (360 GB-hours בחודש ב־Hobby). לשונית שנשארת פתוחה ימים יכולה למצות את
  המכסה החודשית.
- כל מופע פונקציה פותח change stream ומאגר חיבורים משלו ל־MongoDB (ב־Atlas Free
  עד 500 חיבורים).
- ה־daemon צורך כ־24 GB-hours ביום ב־1 GiB, ולכן מכסת 420 GB-hours מספיקה לכ־17
  ימים. אחר כך Vercel עוצר אותו עד ה־1 בחודש הבא (UTC). פקיעת התפיסות עדיין
  נאכפת ב־API, ורק איפוס השדות השמורים והעדכון החי שלו ממתינים.

## הגנת גישה

- *Standard Protection* **אינה** מגינה על דומיין ה־Production. היא מגינה על
  פריסות Preview ועל הכתובת שנוצרה לפריסת ה־Production.
- הגנת *All Deployments* (Vercel Authentication) כלולה ב־Hobby ומכסה גם את דומיין
  ה־Production. מי יכול להיכנס: חברי חשבון Vercel, משתמש Vercel חיצוני אחד לכל
  חשבון שבקשת הגישה שלו אושרה, או כל מי שמחזיק ב**קישור השיתוף היחיד**
  (Shareable Link) של החשבון. Password Protection אינה זמינה ב־Hobby.
- בבדיקת הענן, גישה דרך קישור השיתוף אפשרה גם את בקשות ה־API וה־SSE של הדף (ראו
  [תוצאות בדיקת הענן](#תוצאות-בדיקת-הענן)).
- הגישה של אפליקציית GitHub של Vercel הוגבלה למאגר `sign-flow` בלבד, ואומתה
  ידנית. הפריסה נעשית מ־Git. אם
  פורסים עם ה־CLI, רק יחד עם `.vercelignore` (ה־CLI מעלה קבצים ש־`.gitignore`
  מחריג, כולל `.env`).

## WAF

**הכלל הפעיל:**

| שדה | ערך |
| --- | --- |
| פעולה | Rate Limit, תגובה `429` |
| נתיבים | מתחילים ב־`/api/orders` |
| שיטות | `POST`, `PATCH` |
| סף | 30 בקשות ב־60 שניות |
| מפתח | כתובת IP |

**מה הכלל אינו עושה:**

- הוא **אינו מגביל `GET` וחיבורי SSE** (`/api/orders/events`).
- הוא **אינו מבטיח מניעת מיצוי מכסות** של Vercel ו־Atlas. ראו את המכסות בהמשך.
- המונים הם לכל אזור, כך שאפשר לחרוג מהסף דרך כמה אזורים. שום כלל אינו עוצר
  הצפה מבוזרת מכתובות רבות.
- כלל מותאם עם *Deny*, *Challenge* או *Log* הוא מסנן, **לא** הגבלת קצב: הוא
  אינו סופר בקשות.

**מגבלות ה־WAF ב־Hobby:** עד **3 כללים מותאמים** לפרויקט, ומהם **לכל היותר
אחד** עם הפעולה *Rate Limit*. מפתחות: IP או JA4 digest. חלון קבוע של 10 שניות עד
10 דקות. כלולות 1,000,000 בקשות מותרות, ומה שקורה מעבר לכך ב־Hobby אינו מתועד.
במקרה של תקיפה אפשר להפעיל *Attack Mode*, שזמין בכל המסלולים (כבה אחרי 1, 6 או
24 שעות).

**מצב הבדיקה:** הכלל הוגדר, פורסם ונראה פעיל בממשק של Vercel. זו בדיקת הגדרה
בלבד. **הפעלת `429` בפועל, על ידי חריגה מהסף, לא נבדקה.**

## מכסות Hobby שחלות על Production

מכסות חודשיות. כשאחת מהן נגמרת, היכולת אינה זמינה עד שחולפים 30 יום.

| משאב | כלול |
| --- | --- |
| הפעלות פונקציה | 1,000,000 |
| Active CPU | 4 שעות |
| Provisioned Memory | 360 GB-hours (כל לשונית פתוחה מחזיקה מופע חי) |
| Fast Data Transfer / Fast Origin Transfer | 100 GB / 10 GB |
| בקשות CDN | 1,000,000 |
| משך פונקציה | 300 שניות לבקשה (SSE מתחבר מחדש) |
| לוגי ריצה | נשמרים שעה אחת |
| Daemons (בטא, לחשבון) | 5 שעות Active CPU ו־420 GB-hours. worker של 1 GiB שרץ כל הזמן צורך כ־720 GB-hours בחודש, ולכן נעצר אחרי כ־17 ימים (הפקיעה עדיין נאכפת ב־API) |

Hobby מיועד לשימוש אישי שאינו מסחרי, והתנאים שלו מתירים ל־Vercel להשתמש בתוכן
לאימון AI. במהלך חלון הבדיקה כדאי לעקוב אחרי *Usage* ב־Vercel ואחרי *Metrics*
ב־Atlas.

## תוצאות בדיקת הענן

הבדיקה בוצעה **ידנית**, בדפדפן, מול פריסת ה־Production. היא נפרדת מהבדיקות
האוטומטיות ומהבדיקות המקומיות ב־Docker, שמתוארות
ב־[docs/development-and-testing.md](development-and-testing.md).

**בוצעו ועברו:**

1. **ללא הרשאה**, הדף, `/api/orders` ו־`/api/orders/events` הפנו להתחברות Vercel.
2. **דרך קישור השיתוף**, בחלון גלישה בסתר, האתר נפתח, יצירת הזמנה הצליחה, ושיוך
   ספק התעדכן בחלון נוסף ללא רענון.
3. **יצירה, שיוך ספק וכל מחזור הסטטוסים** עד `COMPLETED` עברו בשני חלונות.
4. **תפיסה:** Jordan תפס הזמנה, והמצב הופיע בחלון השני.
5. **פקיעה:** התפיסה פקעה לאחר 3 דקות. בלוג ה־daemon הופיע
   `released 1 expired claim(s)`, והמופע היה במצב Alive באזור `iad1`.
6. **תפיסה אחרי פקיעה:** Sam תפס לאחר הפקיעה, עבר אימות, וההזמנה הושלמה בשני
   החלונות.
7. **העלאה:** העלאת קובץ הדמו של 1.5 GB הושלמה, והקובץ הופיע בחלון השני.

**לא נבדקו ידנית בענן:**

- **תפיסות מקבילות:** לא נשלחו ידנית שתי בקשות תפיסה בו־זמנית. המקביליות נבדקה
  רק בבדיקות האוטומטיות המקומיות (אינטגרציה ובדיקת הממשק).
- **היעדר אסימונים, `storageKey` וחתימות בתשובות הגולמיות.** זה מכוסה מקומית
  בבדיקות האינטגרציה (`tests/integration/uploads.test.ts`,
  `tests/integration/claims.test.ts`, `tests/integration/orders-events.test.ts`).
- **הפעלת `429` בפועל** על ידי חריגה מסף ה־WAF.
- **חידוש זרם ה־SSE אחרי 280 שניות:** לא תועדה בדיקה בענן. החידוש נבדק בבדיקה
  אוטומטית חד־פעמית מקומית.

**אימות הגדרות בלבד:** כלל ה־WAF (30 בקשות `POST`/`PATCH` ב־60 שניות לכל IP)
הוגדר, פורסם ונראה פעיל.

**בדיקה נוספת בעת כתיבת התיעוד:** בקשות HTTP ללא הרשאה ל־`/` ול־`/api/orders`
קיבלו `302` להתחברות Vercel.

## פריסה מחדש ובדיקת קבלה

push ל־`main` מפעיל פריסת Production אוטומטית. בפריסה יש לוודא שבניית Next.js
ובניית אימג' ה־daemon מצליחות, ושה־daemon `worker` מציג מופע אחד פעיל שהלוג שלו
מתחיל ב־`[claim-expiry] … started, sweeping every 5000 ms`.

ההקמה הראשונית בוצעה כך:

1. ייבוא המאגר ב־Vercel (*Add New Project*). Framework: Next.js (זוהה אוטומטית).
   תיקיית שורש: שורש המאגר. פקודות ההתקנה והבנייה: ברירות המחדל (`npm install`
   מריץ `prisma generate`, ואחריו `next build`).
2. הוספת משתני הסביבה של Production **לפני** פריסת ה־Production הראשונה, כי
   ה־daemon קורא אותם רק מפריסת Production.
3. הגדרת הגנת הגישה וכלל ה־WAF.
4. פריסה ל־Production.

**בדיקת קבלה אחרי פריסה**, בשני חלונות (אחד ברוחב טלפון):

1. שני החלונות מציגים **Live**. יצירת הזמנה באחד מופיעה בשני.
2. שיוך ספק והעברה ל־*Ready for install*. החלון השני מתעדכן.
3. תפיסה בשם שני מתקינים בו־זמנית: אחד מצליח, והשני רואה את ההתנגשות.
   *Simulate: verification passed*, והחלון השני מציג *Installer: … · verified*.
4. תפיסת הזמנה מוכנה נוספת והמתנה של 3 דקות: שני החלונות מציגים אותה כפתוחה
   שוב, ובתוך שניות לוג ה־daemon מציג `released 1 expired claim(s)`.
5. *Print files*, *Use a 1.5 GB demo print file*, *Start upload*. החלון השני מציג
   את הקובץ כהועלה.
6. חלון שנשאר פתוח יותר מ־5 דקות נשאר **Live** (הזרם מתחדש אחרי 280 שניות בלי
   *Reconnecting…*).
7. `GET /api/orders` אינו מחזיר `claimTokenHash`, `storageKey` או כתובת חתומה.
   בלוגי הפונקציות וה־daemon אין שגיאות. *Metrics* ב־Atlas מציג את החיבורים.
8. מחיקת הזמנות הקבלה (ב־Atlas Data Explorer, לפי מזהה, יחד עם ההעלאות שלהן)
   לפני שליחת הקישור לבודק.

מה מתוך הרשימה בוצע בפועל מפורט ב־[תוצאות בדיקת הענן](#תוצאות-בדיקת-הענן).

## נוהל כיבוי

לביצוע בתום הבדיקה. **הנוהל טרם בוצע.**

1. **עצירת הגישה:** ביטול קישור השיתוף (Shareable Link). כדי לסגור את האתר
   לגמרי, מחיקת פרויקט Vercel.
2. **עצירת ה־daemon:** הגדרת מספר המופעים ל־0, או הסרת `daemons` מ־`vercel.json`
   ופריסה מחדש (מחיקת הפרויקט מסירה אותו גם כן).
3. **ביטול הגישה למסד:** מחיקת משתמש המסד הייעודי ב־Atlas, ואז הסרת רשומת גישת
   הרשת `0.0.0.0/0`. השהיה או מחיקה של האשכול החינמי אם אינו נדרש עוד.
4. **הסרת הסודות:** מחיקת `DATABASE_URL` ו־`UPLOAD_SIGNING_SECRET` מפרויקט
   Vercel. הם נוצרו לפריסה הזו בלבד.
5. **GitHub:** הסרת הגישה של אפליקציית Vercel למאגר, אם אינה נדרשת עוד.
6. **בדיקה:** הכתובת כבר אינה מגישה את האפליקציה, ו־Atlas אינו מציג חיבורים.

## מקורות

[Vercel Hobby](https://vercel.com/docs/plans/hobby),
[Functions limits](https://vercel.com/docs/functions/limitations),
[Deployment Protection](https://vercel.com/docs/deployment-protection),
[Shareable Links](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/sharable-links),
[WAF](https://vercel.com/docs/vercel-firewall/vercel-waf),
[WAF Rate Limiting](https://vercel.com/docs/vercel-firewall/vercel-waf/rate-limiting),
[Secret environment variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables),
[.vercelignore](https://vercel.com/docs/deployments/vercel-ignore),
[Daemons limits](https://vercel.com/docs/daemons/limits),
[Daemons config reference](https://vercel.com/docs/daemons/config-reference),
[Function regions](https://vercel.com/docs/functions/configuring-functions/region),
[Function duration](https://vercel.com/docs/functions/configuring-functions/duration),
[Atlas Free limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/),
[Atlas and Vercel integration](https://www.mongodb.com/docs/atlas/reference/partner-integrations/vercel/).
