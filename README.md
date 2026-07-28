# MangaTracker
A personal tracker/bookmark of all the Manga, Manhwa, and Manhua that I currently read, use Google Sheets as a database via Google Apps Script. I hate creating an account.

## 🚀 Features
* **Custom Database:** Uses your personal Google Sheets as a backend.
* **Serverless Hosting:** Runs entirely in the browser via GitHub Pages.
* **Secure Setup:** Connects via a Google Apps Script Web App URL stored locally in your browser—no hardcoded API keys.

## 🛠️ How to Setup Your Own Tracker
If you want to copy this project and use it for your own manga collection, follow these setup steps:

### 1. Create the Google Sheet
Create a brand new Google Sheet and set up the header row (Row 1) with these **exact column names** in this specific order:

| Column | Header Name | Description |
| :---: | :--- | :--- |
| **A** | `ID` | Unique identifier or row number |
| **B** | `Title` | The name of the manga |
| **C** | `Type` | Format (e.g., Manga, Manhwa, Manhua) |
| **D** | `Current Chapter` | The last chapter you read |
| **E** | `Latest Chapter` | The total or most recently released chapter |
| **F** | `Status` | Current reading state (e.g., Reading, Plan to Read, Completed) |
| **G** | `URL` | Link to read or view details (e.g., MyAnimeList or MangaDex) |
| **H** | `Cover Image URL` | Direct image link (`.jpg`/`.png`) for the cover display |
| **I** | `Notes` | Personal thoughts or quick reminders |
| **J** | `Last Updated` | Timestamp of your latest update |

---

### 2. Deploy the Google Apps Script
To let the website communicate safely with your spreadsheet:
1. Inside your new Google Sheet, go to the top menu and click **Extensions** > **Apps Script**.
2. Delete any existing code in the editor.
3. Paste this exact code into the script editor:

/*** ===== CONFIG ===== */

const SHEET_NAME = 'Sheet1'; // change to your sheet/tab name
const SPREADSHEET_ID = ''; // leave blank to use the container-bound sheet

// Column order must match your header row exactly:
const COLUMNS = [
  'ID', 'Title', 'Type', 'Current Chapter', 'Latest Chapter',
  'Status', 'URL', 'Cover Image URL', 'Notes'
];

function getSheet_() {
  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error(`Sheet named "${SHEET_NAME}" not found.`);
  return sheet;
}

/**
 * ===== 1. doGet() — JSON API for your apps =====
 */
function doGet(e) {
  try {
    const sheet = getSheet_();
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const rows = data.slice(1);

    const json = rows
      .filter(row => row.some(cell => cell !== '')) // skip fully blank rows
      .map(row => {
        const obj = {};
        headers.forEach((header, i) => {
          obj[header] = row[i];
        });
        return obj;
      });

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, count: json.length, data: json }))
      .setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ success: false, error: err.message }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * ===== 2. fetchLatestChapters() — the scraping automation =====
 * Run manually or attach a time-driven trigger.
 */
function fetchLatestChapters() {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const colIndex = {};
  COLUMNS.forEach(name => {
    const idx = headers.indexOf(name);
    if (idx === -1) throw new Error(`Missing expected column: ${name}`);
    colIndex[name] = idx;
  });

  // Optional column — script still works fine if you haven't added it yet
  const lastUpdatedCol = headers.indexOf('Last Updated');

  const urlCol = colIndex['URL'];
  const latestCol = colIndex['Latest Chapter'];
  const titleCol = colIndex['Title'];

  const log = [];

  for (let r = 1; r < data.length; r++) {
    const row = data[r];
    const url = row[urlCol];
    const title = row[titleCol] || `Row ${r + 1}`;

    if (!url) continue;

    try {
      const html = fetchPage_(url);
      const foundChapter = extractLatestChapter_(html);

      if (foundChapter === null) {
        log.push(`⚠️ ${title}: no chapter number found`);
        continue;
      }

      const currentLatest = parseFloat(row[latestCol]) || 0;

      if (foundChapter > currentLatest) {
        sheet.getRange(r + 1, latestCol + 1).setValue(foundChapter);

        // Stamp "Last Updated" only when a genuinely new chapter appears
        if (lastUpdatedCol !== -1) {
          sheet.getRange(r + 1, lastUpdatedCol + 1).setValue(new Date());
        }

        log.push(`✅ ${title}: updated ${currentLatest} → ${foundChapter}`);
      } else {
        log.push(`— ${title}: no change (latest known ${currentLatest}, found ${foundChapter})`);
      }

      Utilities.sleep(800);

    } catch (err) {
      log.push(`❌ ${title}: fetch/parse error — ${err.message}`);
    }
  }

  Logger.log(log.join('\n'));
  return log;
}

/**
 * Fetch page HTML with a normal browser-like User-Agent
 * and muteHttpExceptions so one bad site doesn't kill the run.
 */
function fetchPage_(url) {
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    muteHttpExceptions: true,
    followRedirects: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36'
    }
  });

  const code = response.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error(`HTTP ${code}`);
  }
  return response.getContentText();
}

/**
 * Layered strategy to pull the newest chapter number out of a page.
 * Tries several patterns common across manga aggregator sites and
 * returns the HIGHEST plausible chapter number found.
 */
/**
 * Terms different manga sites/series use instead of "Chapter".
 * Add more as you discover them.
 */
const CHAPTER_TERMS = [
  'chapter', 'ch', 'episode', 'ep', 'mission', 'session',
  'act', 'issue', 'volume', 'vol', 'file', 'days', 'hunt',
  'brush'
];


function extractLatestChapter_(html, customTerm) {
  // Layer 1: strip out comments section before any scanning
  const commentMarkers = [/id=["']comments["']/i, /wpd-comm-/i, /wpDiscuz/i];
  let trimmedHtml = html;
  for (const marker of commentMarkers) {
    const m = trimmedHtml.match(marker);
    if (m && m.index !== undefined) {
      trimmedHtml = trimmedHtml.substring(0, m.index);
      break;
    }
  }

  // Layer 2 (highest priority): explicit "Latest: Chapter 99" label,
  // common on themes that show First/Latest badges directly.
  // Allows for HTML tags between "Latest" and "Chapter N" since these
  // are often split across nested <span>/<b> elements.
  const latestLabelRegex = /Latest[\s\S]{0,60}?(?:chapter|ch\.?|ep(?:isode)?|mission|act)\.?\s*(\d+(?:\.\d+)?)/i;
  const latestLabelMatch = trimmedHtml.match(latestLabelRegex);
  if (latestLabelMatch) {
    return parseFloat(latestLabelMatch[1]);
  }

  // Layer 3: dedicated "New Chapter" badge/link (WordPress/Madara style)
  const newChapterRegex = /href=["']([^"']*-chapter-(\d+(?:\.\d+)?)\/?)["'][^>]*>[\s\S]{0,80}?New\s*Chapter/i;
  const newChapterMatch = trimmedHtml.match(newChapterRegex);
  if (newChapterMatch) {
    return parseFloat(newChapterMatch[2]);
  }

  // Layer 4: href-based chapter slug extraction (max of all chapter links)
  const candidates = [];
  const hrefChapterMatches = trimmedHtml.match(/href=["'][^"']*-chapter-(\d+(?:\.\d+)?)\/?["']/gi) || [];
  hrefChapterMatches.forEach(m => {
    const num = m.match(/-chapter-(\d+(?:\.\d+)?)/i);
    if (num) candidates.push(parseFloat(num[1]));
  });
  // Strategy: "/chapter/N" path-style links — common on Astro/React-based
  // reader sites (e.g. Asura Scans), where chapter URLs look like
  // .../series-slug/chapter/28 rather than a hyphenated "-chapter-28-" slug.
  const hrefChapterPathMatches = trimmedHtml.match(/href=["'][^"']*\/chapter\/(\d+(?:\.\d+)?)\/?["']/gi) || [];
  hrefChapterPathMatches.forEach(m => {
    const num = m.match(/\/chapter\/(\d+(?:\.\d+)?)/i);
    if (num) candidates.push(parseFloat(num[1]));
  });

  if (candidates.length > 0) {
    const plausible = candidates.filter(n => n > 0 && n < 5000);
    if (plausible.length > 0) return Math.max(...plausible);
  }



  // Layer 5 (fallback): term-based scanning for sites without any of
  // the above patterns — same Strategy 1–4 logic as before
  const terms = customTerm ? [customTerm.toLowerCase()] : CHAPTER_TERMS;
  const termPattern = terms.map(t => escapeRegex_(t)).join('|');

  const ldJsonMatches = trimmedHtml.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  ldJsonMatches.forEach(block => {
    const nums = block.match(/"chapterNumber"\s*:\s*"?(\d+(?:\.\d+)?)"?/gi) || [];
    nums.forEach(n => {
      const m = n.match(/(\d+(?:\.\d+)?)/);
      if (m) candidates.push(parseFloat(m[1]));
    });
  });

  const slugRegex = new RegExp(`(?:${termPattern})[-_\\s]?(\\d+(?:\\.\\d+)?)`, 'gi');
  const slugMatches = trimmedHtml.match(slugRegex) || [];
  slugMatches.forEach(m => {
    const num = m.match(/(\d+(?:\.\d+)?)/);
    if (num) candidates.push(parseFloat(num[1]));
  });

  const classRegex = new RegExp(`class=["'][^"']*(?:${termPattern})[^"']*["'][^>]*>([\\s\\S]{0,120}?)<`, 'gi');
  const classBlockMatches = trimmedHtml.match(classRegex) || [];
  classBlockMatches.forEach(block => {
    const m = block.match(/(\d+(?:\.\d+)?)/);
    if (m) candidates.push(parseFloat(m[1]));
  });

  const textRegex = new RegExp(`\\b(?:${termPattern})\\.?\\s*(\\d+(?:\\.\\d+)?)\\b`, 'gi');
  const textMatches = trimmedHtml.match(textRegex) || [];
  textMatches.forEach(m => {
    const num = m.match(/(\d+(?:\.\d+)?)/);
    if (num) candidates.push(parseFloat(num[1]));
  });

  if (candidates.length === 0) return null;
  const plausible = candidates.filter(n => n > 0 && n < 5000);
  if (plausible.length === 0) return null;
  return Math.max(...plausible);
}

function escapeRegex_(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Optional: create a time-driven trigger to run fetchLatestChapters()
 * automatically, e.g. once every 6 hours. Run this once manually to set it up.
 */
function createTrigger() {
  // Clear existing triggers for this function first to avoid duplicates
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'fetchLatestChapters') {
      ScriptApp.deleteTrigger(t);
    }
  });

  ScriptApp.newTrigger('fetchLatestChapters')
    .timeBased()
    .everyHours(6)
    .create();
}

/**
 * ===== 4. Auto-fill on paste — installable onEdit trigger =====
 */
function handleEdit(e) {
  try {
    const sheet = e.range.getSheet();
    if (sheet.getName() !== SHEET_NAME) return;

    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    const urlColIndex = headers.indexOf('URL') + 1; // 1-based
    if (urlColIndex === 0) return;

    const editedRange = e.range;
    const editedFirstCol = editedRange.getColumn();
    const editedLastCol = editedFirstCol + editedRange.getNumColumns() - 1;

    // Only act if the edit touches the URL column
    if (urlColIndex < editedFirstCol || urlColIndex > editedLastCol) return;

    const startRow = editedRange.getRow();
    const numRows = editedRange.getNumRows();

    for (let i = 0; i < numRows; i++) {
      const row = startRow + i;
      if (row === 1) continue; // skip header row

      const url = sheet.getRange(row, urlColIndex).getValue();
      if (url) populateRowFromUrl_(sheet, headers, row, url);
    }
  } catch (err) {
    Logger.log('handleEdit error: ' + err.message);
  }
}

function populateRowFromUrl_(sheet, headers, row, url) {
  const colIndex = {};
  headers.forEach((h, i) => colIndex[h] = i + 1); // 1-based columns

  // Don't overwrite a row that's already populated
  const titleCell = sheet.getRange(row, colIndex['Title']);
  if (titleCell.getValue()) return;

  try {
    const html = fetchPage_(url);
    const meta = extractMangaMetadata_(html);
    const latestChapter = extractLatestChapter_(html) || 0;

    // Auto-number ID
    const idCell = sheet.getRange(row, colIndex['ID']);
    if (!idCell.getValue()) {
      const lastRow = sheet.getLastRow();
      const existingIds = lastRow > 1
        ? sheet.getRange(2, colIndex['ID'], lastRow - 1, 1).getValues().map(r => parseFloat(r[0]) || 0)
        : [];
      const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;
      idCell.setValue(newId);
    }

    titleCell.setValue(meta.title || 'Unknown Title');
    sheet.getRange(row, colIndex['Type']).setValue(meta.type || '');
    sheet.getRange(row, colIndex['Current Chapter']).setValue(0);
    sheet.getRange(row, colIndex['Latest Chapter']).setValue(latestChapter);
    sheet.getRange(row, colIndex['Status']).setValue(meta.status || '');
    sheet.getRange(row, colIndex['Cover Image URL']).setValue(meta.coverImage || '');

  } catch (err) {
    sheet.getRange(row, colIndex['Notes']).setValue('⚠️ Auto-fill failed: ' + err.message);
  }
}

/**
 * Pulls Title, Type, Status, Cover Image from a manga page.
 * Prioritizes Open Graph tags (og:title, og:image) since these are
 * standardized and reliable across virtually all sites.
 */
function extractMangaMetadata_(html) {
  const meta = {};

  // Prefer <h1> first now — it's usually the clean, unbranded title,
  // since og:title often has site branding/suffixes appended for
  // social-media link previews (Discord/Facebook/Twitter share cards).
  let m = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (m) {
    meta.title = decodeHtmlEntities_(m[1].replace(/<[^>]+>/g, '').trim());
  } else {
    m = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (m) meta.title = decodeHtmlEntities_(m[1]);
  }

  // Clean up branding/fluff even if it slipped through (covers cases
  // where <h1> itself contains extra text, or as a safety net)
  if (meta.title) meta.title = cleanMangaTitle_(meta.title);

  // --- Cover Image (unchanged) ---
  meta.coverImage = extractCoverImage_(html);

  // --- Type / Status (unchanged) ---
  m = html.match(/Type[\s\S]{0,60}?<[^>]+>\s*([A-Za-z]+)\s*<\/[^>]+>/i)
    || html.match(/Type\s*[:\-]?\s*<[^>]*>\s*([A-Za-z]+)/i);
  if (m) meta.type = m[1].trim();

  m = html.match(/Status[\s\S]{0,60}?<[^>]+>\s*([A-Za-z]+)\s*<\/[^>]+>/i)
    || html.match(/Status\s*[:\-]?\s*<[^>]*>\s*([A-Za-z]+)/i);
  if (m) meta.status = m[1].trim();

  return meta;
}

/**
 * Strips common site-branding and filler patterns from scraped titles.
 * Handles patterns like:
 *   "Spy x Family | Weeb Central"                     -> "Spy x Family"
 *   "Read The Delusional Hunter in Another Manga [Latest Chapters] | Kingofshojo" -> "The Delusional Hunter in Another"
 */
function cleanMangaTitle_(title) {
  let clean = title;

  // Remove "Read " prefix
  clean = clean.replace(/^Read\s+/i, '');

  // Remove trailing " | SiteName" — pipe is safe to strip unconditionally,
  // titles essentially never contain a literal pipe character
  clean = clean.replace(/\s*\|\s*[^|]+$/, '');

  // Remove trailing " - SiteName" or " – SiteName" — ONLY when the
  // dash has whitespace on both sides. This avoids matching hyphens
  // that are actually part of the title itself, like "Shangri-La"
  // (no surrounding spaces) vs "Title - Site Name" (spaced separator).
  clean = clean.replace(/\s+[-–]\s+[^-–]+$/, '');

  // Remove bracketed fluff like "[Latest Chapters]", "(Official)", etc.
  clean = clean.replace(/\s*[\[\(][^\]\)]*(?:latest|chapter|official|read|online)[^\]\)]*[\]\)]\s*/gi, ' ');

  // Remove trailing "Manga"/"Manhwa"/"Manhua" as a generic suffix
  clean = clean.replace(/\s+(?:Manga|Manhwa|Manhua)\s*$/i, '');

  return clean.replace(/\s{2,}/g, ' ').trim();
}

function extractCoverImage_(html) {
  // Strategy 1: og:image, property before content
  let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  if (m) return m[1];

  // Strategy 2: og:image, content before property
  m = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (m) return m[1];

  // Strategy 3: twitter:image
  m = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
  if (m) return m[1];

  // Strategy 4a: itemprop="image" directly carrying src/content itself
  m = html.match(/<[^>]+itemprop=["']image["'][^>]+(?:src|content)=["']([^"']+)["']/i);
  if (m) return m[1];

  // Strategy 4b: itemprop="image" wrapping a nested <img> tag —
  // e.g. <div class="thumb" itemprop="image">...<img src="...">...
  const itemPropIdx = html.search(/<[^>]+itemprop=["']image["']/i);
  if (itemPropIdx !== -1) {
    const nearbyHtml = html.substring(itemPropIdx, itemPropIdx + 500);
    const imgMatch = nearbyHtml.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (imgMatch) return imgMatch[1];
  }

  // Strategy 5: generic fallback — <img> with "cover"/"thumb" in class or src
  m = html.match(/<img[^>]*(?:class=["'][^"']*(?:cover|thumb)[^"']*["'][^>]*src|src=["'][^"']*(?:cover|thumb)[^"']*["'])[^>]*>/i);
  if (m) {
    const srcMatch = m[0].match(/src=["']([^"']+)["']/i);
    if (srcMatch) return srcMatch[1];
  }

  return '';
}

function decodeHtmlEntities_(str) {
  return str
    // Numeric entities: &#39; &#8217; &#8211; etc. — handles ANY numeric
    // code, not just a hardcoded few, fixing gaps like &#39; vs &#039;
    .replace(/&#(\d+);/g, (match, code) => String.fromCharCode(code))
    // Hex numeric entities: &#x27; etc.
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)))
    // Common named entities
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/**
 * Run this ONCE to activate the auto-fill-on-paste behavior.
 */
function createEditTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'handleEdit') ScriptApp.deleteTrigger(t);
  });

  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();

  ScriptApp.newTrigger('handleEdit')
    .forSpreadsheet(ss)
    .onEdit()
    .create();
}

/**
 * ===== 5. doPost() — Update Current Chapter =====
 * Frontend sends: { "action": "updateProgress", "id": 5, "currentChapter": 12 }
 * or for +/- buttons: { "action": "updateProgress", "id": 5, "delta": 1 }
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    if (payload.action === 'addManga') {
      const result = addMangaFromUrl_(payload.url);
      return jsonResponse_({ success: true, data: result });
    }

    if (payload.action === 'updateProgress') {
      const result = updateCurrentChapter_(payload.id, payload.currentChapter, payload.delta);
      return jsonResponse_({ success: true, data: result });
    }
// Inside your existing doPost(), add this branch alongside 'addManga' and 'updateProgress':
    if (payload.action === 'updateStatus') {
      const result = updateMangaStatus_(payload.id, payload.status);
      return jsonResponse_({ success: true, data: result });
    }
    return jsonResponse_({ success: false, error: 'Unknown action' });

  } catch (err) {
    return jsonResponse_({ success: false, error: err.message });
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * Updates Current Chapter for a given manga ID.
 * - If `currentChapter` is provided, sets it directly (manual number input).
 * - If `delta` is provided instead (+1/-1 buttons), adjusts from current value.
 * Always clamps the result between 0 and Latest Chapter, server-side,
 * regardless of what the frontend sends.
 */
function updateCurrentChapter_(id, currentChapter, delta) {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const idCol = headers.indexOf('ID');
  const currentCol = headers.indexOf('Current Chapter');
  const latestCol = headers.indexOf('Latest Chapter');

  let targetRow = -1;
  for (let r = 1; r < data.length; r++) {
    if (data[r][idCol] == id) {
      targetRow = r;
      break;
    }
  }

  if (targetRow === -1) throw new Error(`No manga found with ID ${id}`);

  const latestChapter = parseFloat(data[targetRow][latestCol]) || 0;
  const existingCurrent = parseFloat(data[targetRow][currentCol]) || 0;

  let newValue;
  if (typeof currentChapter === 'number') {
    newValue = currentChapter; // direct manual input
  } else if (typeof delta === 'number') {
    newValue = existingCurrent + delta; // +1 / -1 button press
  } else {
    throw new Error('Must provide either currentChapter or delta');
  }

  // Clamp: can't go below 0, can't exceed Latest Chapter
  newValue = Math.max(0, Math.min(newValue, latestChapter));

  sheet.getRange(targetRow + 1, currentCol + 1).setValue(newValue);

  return {
    id: id,
    currentChapter: newValue,
    latestChapter: latestChapter
  };
}

function updateMangaStatus_(id, status) {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const idCol = headers.indexOf('ID');
  const statusCol = headers.indexOf('Status');

  for (let r = 1; r < data.length; r++) {
    if (data[r][idCol] == id) {
      sheet.getRange(r + 1, statusCol + 1).setValue(status);
      return { id: id, status: status };
    }
  }
  throw new Error(`No manga found with ID ${id}`);
}

function fixLastUpdatedFormat() {
  const sheet = getSheet_();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const colIdx = headers.indexOf('Last Updated');

  if (colIdx === -1) {
    Logger.log('Last Updated column not found.');
    return;
  }

  const lastRow = sheet.getMaxRows();
  const range = sheet.getRange(1, colIdx + 1, lastRow, 1);
  range.setNumberFormat('yyyy-mm-dd hh:mm:ss'); // e.g. 2026-07-27 14:32:10

  Logger.log(`Formatted column ${colIdx + 1} ("Last Updated") for all rows.`);
}

function addMangaFromUrl_(url) {
  const sheet = getSheet_();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];

  const colIndex = {};
  COLUMNS.forEach(name => colIndex[name] = headers.indexOf(name));

  const html = fetchPage_(url);
  const meta = extractMangaMetadata_(html);
  const latestChapter = extractLatestChapter_(html) || 0;

  // Generate next numeric ID (max existing ID + 1)
  const idCol = colIndex['ID'];
  const existingIds = data.slice(1).map(r => parseFloat(r[idCol]) || 0);
  const newId = existingIds.length > 0 ? Math.max(...existingIds) + 1 : 1;

  const newRow = [];
  newRow[colIndex['ID']] = newId;
  newRow[colIndex['Title']] = meta.title || 'Unknown Title';
  newRow[colIndex['Type']] = meta.type || '';
  newRow[colIndex['Current Chapter']] = 0;
  newRow[colIndex['Latest Chapter']] = latestChapter;
  newRow[colIndex['Status']] = meta.status || '';
  newRow[colIndex['URL']] = url;
  newRow[colIndex['Cover Image URL']] = meta.coverImage || '';
  newRow[colIndex['Notes']] = '';

  sheet.appendRow(newRow);

  return {
    id: newId,
    title: meta.title,
    type: meta.type,
    status: meta.status,
    latestChapter: latestChapter,
    coverImage: meta.coverImage
  };
}
/*** ===== END ===== */
   
5. Click the **Save** disk icon.
6. Click **Deploy** (top right corner) > Select **New deployment**.
7. Click the gear icon next to "Select type" and choose **Web app**.
8. Set the configuration details exactly as follows:
   * **Execute as:** `Me (your-email@gmail.com)`
   * **Who has access:** `Anyone` *(Required so your browser can make requests to it)*
9. Click **Deploy** and complete the Google account authorization prompts.
10. Copy the generated **Web App URL** (it will end with `/exec`).

---

### 3. Configure Automated Triggers
This project uses background triggers to automatically update manga data (like timestamps or fetching the latest chapters). To set them up:

1. In your Apps Script editor sidebar, click the **Triggers** icon (the alarm clock ⏰ icon).
2. Click the blue **+ Add Trigger** button in the bottom right corner.
3. Add the **On Edit** trigger:
   * **Choose which function to run:** `handleEdit`
   * **Choose which deployment should run:** `Head`
   * **Select event source:** `From spreadsheet`
   * **Select event type:** `On edit`
   * Click **Save**.
4. Add the **Time-Based** trigger:
   * **Choose which function to run:** `fetchLatestChapters`
   * **Choose which deployment should run:** `Head`
   * **Select event source:** `Time-driven`
   * **Select type of time based trigger:** `Hour timer` (and select your preferred interval)
   * Click **Save**.

### 4. Connect to the App
1. Open the live hosted URL of this website.
2. Click on the **Settings** icon/button in the user interface.
3. Paste your copied Google Apps Script **Web App URL** into the input field.
4. Save and reload the page. Your tracker is now fully operational!
