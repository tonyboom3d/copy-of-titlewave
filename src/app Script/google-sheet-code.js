/***** CONFIG *****/
const STATUSES = ['Pending (24h)','Approved','Waiting for Approval','Rejected','Canceled','Sent to Production'];
const SPREADSHEET_ID = '';  // השאר ריק אם זה container-bound

// הגדרת נתיב ה-API של האתר שלך בוויקס
const WIX_ENDPOINT = 'https://shirfu.wixsite.com/copy-of-titlewave/_functions/updateOrderFromSheet';
// Fallback column indexes (if headers are missing)
const FALLBACK_ORDER_NUMBER_COL = 1; // A
const FALLBACK_ITEM_ID_COL = 2;      // B
const FALLBACK_STATUS_COL = 9;       // I
const FALLBACK_COMMENT_COL = 10;     // J
const FALLBACK_TIMESTAMP_COL = 12;   // L

// הגדרת הצבעים לפי הסטטוסים (מפתחות באותיות קטנות לצורך השוואה קלה)
const STATUS_COLORS = {
  'pending (24h)': '#ffe0b2',        // כתום בהיר
  'approved': '#c8e6c9',             // ירוק בהיר
  'waiting for approval': '#bbdefb', // כחול בהיר
  'rejected': '#f5c2c7',             // אדום ורדרד
  'canceled': '#ffcdd2',             // אדום בהיר
  'sent to production': '#ffffff'    // לבן (ללא צבע)
};

function getStatusColor(statusValue) {
  const key = String(statusValue || '').trim().toLowerCase();
  return STATUS_COLORS[key] || '#ffffff';
}

/***** COLUMN RESOLUTION (by header names) *****/
function normalizeHeader(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function getHeaderMap(sheet) {
  const lastCol = sheet.getLastColumn();
  if (!lastCol) return new Map();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0] || [];
  const map = new Map();
  for (let i = 0; i < headers.length; i++) {
    const key = normalizeHeader(headers[i]);
    if (!key) continue;
    if (!map.has(key)) map.set(key, i + 1); // 1-based col index
  }
  return map;
}

function resolveCols(sheet) {
  const hm = getHeaderMap(sheet);
  const orderNumberCol = hm.get(normalizeHeader('Order number')) || FALLBACK_ORDER_NUMBER_COL;
  const itemIdCol = hm.get(normalizeHeader('Item ID')) || hm.get(normalizeHeader('itemid')) || FALLBACK_ITEM_ID_COL;
  const statusCol = hm.get(normalizeHeader('STATUS')) || hm.get(normalizeHeader('Status')) || FALLBACK_STATUS_COL;
  const commentCol = hm.get(normalizeHeader('Back office comment')) || hm.get(normalizeHeader('backofficemsg')) || FALLBACK_COMMENT_COL;
  const lastUpdateCol =
    hm.get(normalizeHeader('Last update')) ||
    hm.get(normalizeHeader('Last Update')) ||
    hm.get(normalizeHeader('Last update ')) ||
    FALLBACK_TIMESTAMP_COL;
  return { orderNumberCol, itemIdCol, statusCol, commentCol, lastUpdateCol };
}

/***** HTTP *****/
function doGet(e) {
  return respond({ ok: true, ping: true, ts: new Date().toISOString() });
}

function doPost(e) {
  try {
    const raw = e && e.postData && e.postData.contents || '';
    const body = JSON.parse(raw || '{}');

    // --- זיהוי פעולת עדכון המגיעה מ-Wix ---
    if (body.action === 'updateOrder') {
      return updateRowFromWix(body);
    }
    // ----------------------------------------

    const title = sanitizeTitle(body.sheetTitle || '');
    const headers = Array.isArray(body.headers) ? body.headers : [];
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const mode = String(body.mode || '').toLowerCase();   // '' | 'overwrite' | 'rename'
    const newTitleRaw = body.newTitle != null ? String(body.newTitle) : '';
    const newTitle = newTitleRaw ? sanitizeTitle(newTitleRaw) : '';

    if (!title || !headers.length) {
      return respond({ ok: false, error: 'missing title/headers', got: { title, headers: headers.length, rows: rows.length } });
    }

    const ss = getSpreadsheet();
    const exists = !!ss.getSheetByName(title);

    if (exists) {
      if (mode === 'overwrite') {
        const sh = ss.getSheetByName(title);
        sh.clear();
        return writeAll(ss, sh, title, headers, rows);
      } else if (mode === 'rename' && newTitle) {
        const unique = uniqueName(ss, newTitle);
        const sh = ss.insertSheet(unique);
        return writeAll(ss, sh, unique, headers, rows);
      } else {
        const suggestion = uniqueName(ss, title);
        return respond({ ok: false, needsDecision: true, reason: 'sheet_exists', existingTitle: title, suggestion });
      }
    }

    const sh = ss.insertSheet(title);
    return writeAll(ss, sh, title, headers, rows);
  } catch (err) {
    return respond({ ok: false, error: String(err && err.stack || err) });
  }
}

/***** TRIGGERS *****/
// פונקציה זו הוחלפה מ-onEdit ל-onSheetEdit. חובה ליצור עבורה טריגר ב-App Script מסוג On Edit!
function onSheetEdit(e) {
  if (!e || !e.range) return;
  
  const sheet = e.range.getSheet();
  const startRow = e.range.getRow();
  const numRows = e.range.getNumRows();
  const startCol = e.range.getColumn();
  const numCols = e.range.getNumColumns();

  // אם נערכה רק שורת הכותרת, אין צורך לעשות כלום
  if (startRow === 1 && numRows === 1) return;

  const cols = resolveCols(sheet);
  const STATUS_COL = cols.statusCol;
  const COMMENT_COL = cols.commentCol;
  const TIMESTAMP_COL = cols.lastUpdateCol;

  // מניעת לולאה: אם משתמש משנה רק את תאריך העדכון עצמו, לא נעשה כלום כדי לחסוך ביצועים
  if (startCol === TIMESTAMP_COL && numRows === 1) return;

  let lastCol = sheet.getLastColumn();
  if (lastCol < TIMESTAMP_COL) lastCol = TIMESTAMP_COL; // נוודא שהצביעה תגיע לפחות לעמודה L

  // חישוב השורות הרלוונטיות (מתעלמים משורת הכותרת)
  const actualStartRow = Math.max(2, startRow);
  const rowsToProcess = (startRow === 1) ? numRows - 1 : numRows;
  
  if (rowsToProcess <= 0) return;

  // הבאת הערכים של הסטטוס מתוך עמודת הסטטוס בלבד
  const statusValues = sheet.getRange(actualStartRow, STATUS_COL, rowsToProcess, 1).getValues();

  // יצירת חותמת זמן בפורמט המבוקש
  const timestampStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yy HH:mm:ss');
  
  const backgrounds = [];
  const timestamps = [];

  for (let i = 0; i < rowsToProcess; i++) {
    const val = String(statusValues[i][0] || '').trim().toLowerCase();
    const color = getStatusColor(val);
    
    backgrounds.push(Array(lastCol).fill(color));
    timestamps.push([timestampStr]);
  }

  // החלת כל הצבעים וכל חותמות הזמן
  sheet.getRange(actualStartRow, 1, rowsToProcess, lastCol).setBackgrounds(backgrounds);
  sheet.getRange(actualStartRow, TIMESTAMP_COL, rowsToProcess, 1).setValues(timestamps);

  // --- שליחת העדכון ל-Wix אם שונו עמודות הסטטוס (I) או ההערה (J) ---
  const endCol = startCol + numCols - 1;
  if (endCol >= STATUS_COL && startCol <= COMMENT_COL) {
    sendUpdateToWix(sheet, actualStartRow, rowsToProcess);
  }
}

// פונקציה חדשה ששולחת את הנתונים לאתר ה-Wix שלך
function sendUpdateToWix(sheet, startRow, numRows) {
  const cols = resolveCols(sheet);
  const lastCol = Math.max(sheet.getLastColumn(), cols.commentCol);
  const data = sheet.getRange(startRow, 1, numRows, lastCol).getValues();
  
  for (let i = 0; i < numRows; i++) {
    const rowData = data[i];
    const orderNumber = rowData[cols.orderNumberCol - 1];
    const itemId = rowData[cols.itemIdCol - 1];
    const status = rowData[cols.statusCol - 1];
    const comment = rowData[cols.commentCol - 1];
    
    if (!orderNumber || !itemId) continue; // require both keys
    
    const payload = {
      orderNumber: String(orderNumber),
      itemId: String(itemId),
      status: String(status || ''),
      comment: String(comment || '')
    };
    
    const options = {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true // לא קורס אם Wix מחזיר שגיאה
    };
    
    try {
      UrlFetchApp.fetch(WIX_ENDPOINT, options);
    } catch (err) {
      console.error('Error sending to Wix:', err);
    }
  }
}

// פונקציה חדשה לעדכון הגיליון מקריאות של Wix
function updateRowFromWix(body) {
  const ss = getSpreadsheet();
  // אם לא סופק שם גיליון ספציפי, עובד על הגיליון הראשון (ברירת מחדל)
  const sheet = body.sheetTitle ? ss.getSheetByName(body.sheetTitle) : ss.getSheets()[0];
  
  if (!sheet) return respond({ ok: false, error: 'Sheet not found' });

  const cols = resolveCols(sheet);
  
  const orderNumber = body.orderNumber != null ? String(body.orderNumber) : '';
  const itemId = body.itemId != null ? String(body.itemId) : '';
  if (!orderNumber) return respond({ ok: false, error: 'Missing orderNumber' });

  const row = findRowByKeys(sheet, orderNumber, itemId, cols);
  if (!row) return respond({ ok: false, error: 'Row not found in sheets', orderNumber, itemId });

  // STATUS + Back office comment
  sheet.getRange(row, cols.statusCol).setValue(body.status || '');
  sheet.getRange(row, cols.commentCol).setValue(body.comment || '');

  // Last update
  const timestampStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yy HH:mm:ss');
  sheet.getRange(row, cols.lastUpdateCol).setValue(timestampStr);

  // Row color
  const val = String(body.status || '').trim().toLowerCase();
  const color = getStatusColor(val);
  const lastCol = sheet.getLastColumn();
  sheet.getRange(row, 1, 1, Math.max(lastCol, cols.lastUpdateCol)).setBackground(color);

  return respond({ ok: true, rowUpdated: row });
}

/***** CORE *****/
function writeAll(ss, sheet, title, headers, rows) {
  const safeRows = normalizeRows(rows, headers.length);
  writeGrid(sheet, headers, safeRows);

  // תאריך יצירת המסמך ב-O1 (MM/dd/yy) כדי לא להתנגש עם עמודות נתונים
  stampCreatedAtN(sheet);

  applyFormatting(sheet, headers, safeRows);
  applyStatusValidation(sheet, safeRows); // הסרנו את העברת הכותרות מכיוון שאנו משתמשים בעמודה קשיחה

  return respond({ ok: true, sheetTitle: title, spreadsheetUrl: ss.getUrl(), rows: safeRows.length });
}

/***** HELPERS *****/

function sanitizeTitle(s) {
  return String(s || '')
    .replace(/[\/\u2044]/g, '-')       // "/" וגם "⁄" -> "-"
    .replace(/[\[\]\:\*\?\/\\]/g, '')  // ניקוי תווים אסורים
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, 90);
}

function stampCreatedAtN(sheet) {
  const today = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yy');
  sheet.getRange('O1').setValue(today);
}

function getSpreadsheet() {
  if (SPREADSHEET_ID) return SpreadsheetApp.openById(SPREADSHEET_ID);
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (id) return SpreadsheetApp.openById(id);
  return SpreadsheetApp.getActiveSpreadsheet();
}

function uniqueName(ss, base) {
  let name = sanitizeTitle(base || '');
  if (!name) name = 'Sheet';
  if (!ss.getSheetByName(name)) return name;
  let i = 2;
  while (ss.getSheetByName(`${name} (${i})`)) i++;
  return `${name} (${i})`;
}

function normalizeRows(rows, cols) {
  if (!rows.length) return [];
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    const r = Array.isArray(rows[i]) ? rows[i].slice(0, cols) : [];
    while (r.length < cols) r.push('');
    for (let c = 0; c < r.length; c++) {
      const v = r[c];
      if (v === null || v === undefined) continue;
      if (Object.prototype.toString.call(v) === '[object Date]') {
        r[c] = Utilities.formatDate(v, Session.getScriptTimeZone(), 'MM/dd/yy HH:mm:ss');
      } else if (typeof v === 'object') {
        r[c] = String(v && (v.title || v.name || v.label || v.value || v.url) || '');
      }
    }
    out.push(r);
  }
  return out;
}

function writeGrid(sheet, headers, rows) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length) sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
}

function applyFormatting(sheet, headers, rows) {
  const resolved = resolveCols(sheet);
  // Paint at least through Last update column
  const cols = Math.max(headers.length, resolved.lastUpdateCol || 1);
  const rowsLen = rows.length;

  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, cols).setBackground('#dbeafe').setFontWeight('bold');

  if (!rowsLen) return;

  const STATUS_COL_IDX = resolved.statusCol || FALLBACK_STATUS_COL;

  // קוראים את הסטטוסים *ישירות מהגיליון* בעמודה I לאחר הכתיבה
  // כך אנו מבטיחים זיהוי מושלם גם אם ה-API שלח מערך נתונים קצר יותר
  const statusValues = sheet.getRange(2, STATUS_COL_IDX, rowsLen, 1).getValues();
  
  const backgrounds = [];
  const fontWeights = [];

  for (let i = 0; i < rowsLen; i++) {
    const r = rows[i];
    const isGroup = r && r.length && typeof r[0] === 'string' && /^\d+\s/.test(r[0]) && r.slice(1).every(x => !x);

    if (isGroup) {
      backgrounds.push(Array(cols).fill('#fff59d')); // צבע לשורת קבוצה
      fontWeights.push(Array(cols).fill('bold'));
    } else {
      let color = '#ffffff'; // ברירת מחדל ללא צבע
      
      // שליפת הסטטוס מהקריאה הישירה של עמודה I
      const statusValue = String(statusValues[i][0] || '').trim().toLowerCase();
      color = getStatusColor(statusValue);
      
      backgrounds.push(Array(cols).fill(color));
      fontWeights.push(Array(cols).fill('normal'));
    }
  }

  // הגדרת הרקעים והפונטים בבת אחת לכל רוחב השורה (עד L)
  const dataRange = sheet.getRange(2, 1, rowsLen, cols);
  dataRange.setBackgrounds(backgrounds);
  dataRange.setFontWeights(fontWeights);

  // מתאים את רוחב העמודות רק לפי מה שבאמת נשלח
  sheet.autoResizeColumns(1, headers.length);
}

function applyStatusValidation(sheet, rows) {
  if (!rows || !rows.length) return;
  
  const resolved = resolveCols(sheet);
  const STATUS_COL_IDX = resolved.statusCol || FALLBACK_STATUS_COL;
  
  const isGroupRow = (r) => r && typeof r[0] === 'string' && /^\d+\s/.test(r[0]) && r.slice(1).every(x => !x);

  const dataRowStart = 2; 
  const ranges = [];
  let runStart = null;

  for (let i = 0; i < rows.length; i++) {
    const sheetRow = dataRowStart + i;
    const groupy = isGroupRow(rows[i]);

    if (!groupy) {
      if (runStart === null) runStart = sheetRow;
    } else {
      if (runStart !== null) {
        ranges.push([runStart, sheetRow - runStart]);
        runStart = null;
      }
    }
  }
  if (runStart !== null) ranges.push([runStart, dataRowStart + rows.length - runStart]);

  if (!ranges.length) return;

  const rule = SpreadsheetApp.newDataValidation()
    .requireValueInList(STATUSES, true)
    .setAllowInvalid(false)
    .build();

  ranges.forEach(([start, len]) => {
    sheet.getRange(start, STATUS_COL_IDX, len, 1).setDataValidation(rule);
  });
}

function findRowByKeys(sheet, orderNumber, itemId, colsOpt) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  const numRows = lastRow - 1;
  const cols = colsOpt || resolveCols(sheet);
  const maxKeyCol = Math.max(cols.orderNumberCol || 1, cols.itemIdCol || 2);
  const data = sheet.getRange(2, 1, numRows, maxKeyCol).getValues();

  const on = String(orderNumber || '').trim();
  const id = String(itemId || '').trim();

  for (let i = 0; i < data.length; i++) {
    const a = String(data[i][(cols.orderNumberCol || 1) - 1] || '').trim();
    const b = String(data[i][(cols.itemIdCol || 2) - 1] || '').trim();
    if (!a) continue;
    if (id) {
      if (a === on && b === id) return 2 + i;
    } else {
      if (a === on) return 2 + i;
    }
  }
  return 0;
}

function respond(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}